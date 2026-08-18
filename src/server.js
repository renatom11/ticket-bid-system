// Zero-dependency HTTP server: serves the web UI and a small JSON API around
// a single in-memory Drop. Timers drive the lobby countdown and price ticks.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Drop, UserError } from './engine.js';
import { TIERS, VENUE } from './venue.js';
import { addBots } from './bots.js';

const PORT = Number(process.env.PORT ?? 3000);
const LOBBY_SECONDS = Number(process.env.LOBBY_SECONDS ?? 45);
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS ?? 12);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let drop;
let lobbyEndsAt = null;
let nextTickAt = null;
let timer = null;

function reset() {
  clearTimeout(timer);
  timer = null;
  lobbyEndsAt = null;
  nextTickAt = null;
  drop = new Drop({ name: 'Odyssey — Opening Night Drop' });
}
reset();

function openDrop() {
  if (drop.phase !== 'lobby' || lobbyEndsAt) return;
  lobbyEndsAt = Date.now() + LOBBY_SECONDS * 1000;
  timer = setTimeout(startBidding, LOBBY_SECONDS * 1000);
}

function startBidding() {
  if (drop.phase !== 'lobby') return;
  clearTimeout(timer);
  lobbyEndsAt = null;
  drop.openBidding();
  scheduleTick();
}

function scheduleTick() {
  if (drop.phase !== 'bidding') {
    nextTickAt = null;
    return;
  }
  nextTickAt = Date.now() + ROUND_SECONDS * 1000;
  timer = setTimeout(() => {
    drop.tick();
    scheduleTick();
  }, ROUND_SECONDS * 1000);
}

function publicState(bidderId) {
  const you = bidderId ? drop.bidders.get(bidderId) : null;
  return {
    ...drop.summary(),
    name: drop.name,
    showings: drop.showings,
    priceHistory: drop.priceHistory,
    bidderCount: [...drop.bidders.values()].filter((b) => !b.withdrawn).length,
    lobbyEndsAt,
    nextTickAt,
    roundSeconds: ROUND_SECONDS,
    dropOpen: lobbyEndsAt !== null || drop.phase !== 'lobby',
    you: you
      ? {
          id: you.id,
          name: you.name,
          showings: you.showings,
          tierMaxes: you.tierMaxes,
          withdrawn: you.withdrawn,
          targetTier: drop.targetTier(you),
          assignment: you.assignment,
        }
      : null,
  };
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname === '/api/state') {
      return send(200, publicState(url.searchParams.get('bidderId')));
    }
    if (url.pathname === '/api/venue') {
      return send(200, { venue: VENUE, tiers: TIERS });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/join': {
          const bidder = drop.addBidder(body);
          return send(200, { bidderId: bidder.id, state: publicState(bidder.id) });
        }
        case '/api/update':
          drop.updateBidder(body.bidderId, body);
          return send(200, publicState(body.bidderId));
        case '/api/withdraw':
          drop.withdraw(body.bidderId);
          return send(200, publicState(body.bidderId));
        case '/api/admin/open':
          openDrop();
          return send(200, publicState(null));
        case '/api/admin/start-bidding':
          startBidding();
          return send(200, publicState(null));
        case '/api/admin/tick':
          if (drop.phase === 'lobby') startBidding();
          clearTimeout(timer);
          drop.tick();
          scheduleTick();
          return send(200, publicState(null));
        case '/api/admin/bots':
          addBots(drop, Math.min(Number(body.count ?? 100), 10000));
          return send(200, publicState(null));
        case '/api/admin/reset':
          reset();
          return send(200, publicState(null));
        default:
          return send(404, { error: 'Not found' });
      }
    }

    // Static files
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(file));
    if (!filePath.startsWith(PUBLIC_DIR)) return send(404, { error: 'Not found' });
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'text/plain' });
      return res.end(data);
    } catch {
      return send(404, { error: 'Not found' });
    }
  } catch (err) {
    if (err instanceof UserError) return send(400, { error: err.message });
    console.error(err);
    return send(500, { error: 'Internal error' });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new UserError('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new UserError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`Ticket drop prototype running at http://localhost:${PORT}`);
  console.log(`Lobby: ${LOBBY_SECONDS}s · Price tick every ${ROUND_SECONDS}s`);
});
