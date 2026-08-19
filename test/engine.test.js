import test from 'node:test';
import assert from 'node:assert/strict';
import { Drop } from '../src/engine.js';
import { VENUE, TIER_ORDER, seatsForTier } from '../src/venue.js';
import { addBots, adjustBots } from '../src/bots.js';

const SHOWINGS = ['S1', 'S2'];

// Pin every showtime to the top class (weight 1.0) so bids and values line
// up 1:1 — desirability weighting has its own tests below.
function makeDrop(opts = {}) {
  return new Drop({
    showings: SHOWINGS,
    showClasses: Object.fromEntries(SHOWINGS.map((s) => [s, 5])),
    ...opts,
  });
}

function runToSettle(drop, rng) {
  drop.openBidding();
  let guard = 0;
  while (drop.phase === 'bidding' && guard++ < 100) {
    if (rng) adjustBots(drop, rng);
    drop.tick();
  }
  assert.equal(drop.phase, 'settled');
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('venue zones cover every seat exactly once', () => {
  const total = VENUE.rows.reduce((sum, r) => sum + r.seats.length, 0);
  const byTier = TIER_ORDER.map((t) => VENUE.capacityPerShowing[t]);
  assert.equal(byTier.reduce((a, b) => a + b, 0), total);
  for (const t of TIER_ORDER) {
    assert.equal(seatsForTier(t).length, VENUE.capacityPerShowing[t]);
  }
});

test('the Show-7 failure case is gone: a hot show prices itself, everyone who can afford it is seated', () => {
  const drop = makeDrop();
  const cap = VENUE.capacityPerShowing.t2; // 76 Prime Center seats per show
  // 90 bidders insist on S1's Prime Center, distinct maxes 40..129
  for (let i = 0; i < 90; i++) {
    drop.addBidder({ name: `hot${i}`, showings: ['S1'], tierMaxes: [{ tierId: 't2', maxPrice: 40 + i }] });
  }
  runToSettle(drop);
  const p = drop.cellPrices.get('S1|t2');
  const winners = [...drop.bidders.values()].filter((b) => b.assignment);
  assert.equal(winners.length, cap, 'exactly the seats that exist are sold');
  // The price is exactly the marginal (highest losing) bid: maxes are
  // 40..129, seats go to the top 76, so the best loser bid 40+90-cap-1.
  assert.equal(p, 40 + 90 - cap - 1, `price ${p} equals the marginal bid`);
  for (const b of drop.bidders.values()) {
    if (b.assignment) {
      assert.ok(b.tierMaxes[0].maxPrice >= p, 'every winner could afford the price');
      assert.equal(b.assignment.pricePaid, p, 'uniform price within the cell');
    } else {
      assert.ok(b.tierMaxes[0].maxPrice <= p, 'nobody who could afford it was left out');
    }
  }
  // And the other show's identical seats stay at floor
  assert.equal(drop.cellPrices.get('S2|t2'), drop.floors.t2);
});

test('flexibility is precisely rewarded: flexible bidders are steered to slack shows at floor', () => {
  const drop = makeDrop();
  for (let i = 0; i < 80; i++) {
    drop.addBidder({ name: `hot${i}`, showings: ['S1'], tierMaxes: [{ tierId: 't1', maxPrice: 200 + i }] });
  }
  const flex = drop.addBidder({
    name: 'flex',
    showings: ['S1', 'S2'],
    tierMaxes: [{ tierId: 't1', maxPrice: 100 }],
  });
  runToSettle(drop);
  assert.ok(flex.assignment, 'flexible bidder gets a seat');
  assert.equal(flex.assignment.showing, 'S2');
  assert.equal(flex.assignment.pricePaid, drop.floors.t1, 'and pays floor while S1 runs hot');
  assert.ok(drop.cellPrices.get('S1|t1') > drop.floors.t1);
});

test('settlement: capacity respected, cell-uniform prices, nobody over their max, seats unique', () => {
  const drop = makeDrop();
  const rng = mulberry32(7);
  addBots(drop, 1200, rng);
  runToSettle(drop, rng);

  const winners = [...drop.bidders.values()].filter((b) => b.assignment);
  assert.ok(winners.length > 0);
  const cellCount = new Map();
  const seatIds = new Set();
  for (const w of winners) {
    const { tierId, showing, seat, pricePaid } = w.assignment;
    assert.equal(pricePaid, drop.cellPrices.get(`${showing}|${tierId}`), 'cell-uniform price');
    const max = w.tierMaxes.find((tm) => tm.tierId === tierId).maxPrice;
    assert.ok(pricePaid <= max, 'never charged over the stated max');
    assert.ok(w.showings.includes(showing), 'assigned an acceptable showing');
    const key = `${showing}|${tierId}`;
    cellCount.set(key, (cellCount.get(key) ?? 0) + 1);
    const seatId = `${showing}|${seat.row}${seat.seat}`;
    assert.ok(!seatIds.has(seatId), 'no double-booked seats');
    seatIds.add(seatId);
  }
  for (const [key, count] of cellCount) {
    const tierId = key.split('|')[1];
    assert.ok(count <= VENUE.capacityPerShowing[tierId], 'per-cell capacity respected');
  }
  // The core guarantee: no unseated bidder can afford any cell they accept.
  for (const b of drop.bidders.values()) {
    if (b.withdrawn || b.assignment) continue;
    for (const tm of b.tierMaxes) {
      for (const s of b.showings) {
        assert.ok(
          tm.maxPrice * drop.weightOf(s) <= drop.cellPrices.get(`${s}|${tm.tierId}`) + 1e-9,
          'guarantee holds'
        );
      }
    }
  }
});

test('tickWith (async worker path) matches tick exactly', async () => {
  const { solveMarket } = await import('../src/market.js');
  const rng1 = mulberry32(5);
  const rng2 = mulberry32(5);
  const a = makeDrop();
  const b = makeDrop();
  addBots(a, 400, rng1);
  addBots(b, 400, rng2);
  a.openBidding();
  b.openBidding();
  let guard = 0;
  while ((a.phase === 'bidding' || b.phase === 'bidding') && guard++ < 100) {
    const rngA = mulberry32(guard);
    const rngB = mulberry32(guard);
    adjustBots(a, rngA);
    a.tick();
    adjustBots(b, rngB);
    const v = b.bookVersion; // what the browser driver does
    const result = solveMarket(b.bookInput());
    b.tickWith(result, v);
  }
  assert.equal(a.phase, 'settled');
  assert.equal(b.phase, 'settled');
  assert.deepEqual(a.prices, b.prices);
  assert.equal(a.results.revenue, b.results.revenue);
  assert.equal(a.results.winners, b.results.winners);
});

test('showtime desirability: the wanted slot clears higher and steers the flexible crowd', () => {
  const drop = new Drop({
    showings: ['Weak', 'Strong'],
    showClasses: { Weak: 1, Strong: 5 },
  });
  assert.ok(drop.weightOf('Strong') > drop.weightOf('Weak'));
  const cap = VENUE.capacityPerShowing.t1;
  // one flexible crowd, no show-specific constraints at all
  for (let i = 0; i < cap * 3; i++) {
    drop.addBidder({
      name: `b${i}`,
      showings: ['Weak', 'Strong'],
      tierMaxes: [{ tierId: 't1', maxPrice: 60 + i }],
    });
  }
  runToSettle(drop);
  const strong = drop.cellPrices.get('Strong|t1');
  const weak = drop.cellPrices.get('Weak|t1');
  assert.ok(strong > weak, `the desirable showtime should cost more (${strong} vs ${weak})`);
  for (const b of drop.bidders.values()) {
    if (!b.assignment) continue;
    const bid = b.tierMaxes[0].maxPrice;
    assert.ok(b.assignment.pricePaid <= bid, 'never charged over the stated bid');
  }
});

test('withdrawn bidders are never charged or seated', () => {
  const drop = makeDrop();
  const stay = drop.addBidder({ name: 'stay', showings: SHOWINGS, tierMaxes: [{ tierId: 't3', maxPrice: 30 }] });
  const leave = drop.addBidder({ name: 'leave', showings: SHOWINGS, tierMaxes: [{ tierId: 't3', maxPrice: 30 }] });
  drop.openBidding();
  drop.withdraw(leave.id);
  runToSettle(drop);
  assert.ok(stay.assignment);
  assert.equal(stay.assignment.pricePaid, drop.floors.t3, 'uncontested seats price at floor');
  assert.equal(leave.assignment, null);
});

test('bidders can update showings mid-drop, and committedTotal tracks the exact pool', () => {
  const drop = makeDrop();
  const b = drop.addBidder({ name: 'b', showings: ['S1'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  drop.updateBidder(b.id, { showings: ['S1', 'S2'] });
  assert.deepEqual(b.showings, ['S1', 'S2']);
  assert.throws(() => drop.updateBidder(b.id, { showings: [] }), /at least one showing/);
  drop.openBidding();
  drop.tick();
  const c = drop.committedTotal();
  assert.equal(c.bidders, 1);
  assert.equal(c.total, drop.floors.t2);
});

test('adding shows grows supply and relieves prices; flexible bidders pick the new shows up', () => {
  const drop = makeDrop();
  const flexible = drop.addBidder({ name: 'f', showings: ['S1', 'S2'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  const picky = drop.addBidder({ name: 'p', showings: ['S1'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  const t2Before = drop.supply.t2;
  drop.addShowings(2);
  assert.equal(drop.showings.length, 4);
  assert.equal(drop.supply.t2, t2Before * 2);
  assert.equal(flexible.showings.length, 4);
  assert.deepEqual(picky.showings, ['S1']);
});

test('behavioral crowd converges and reports segments, with stretch ceilings in the hundreds', () => {
  const drop = makeDrop();
  const rng = mulberry32(3);
  const bots = addBots(drop, 1500, rng);
  const stretchT1 = bots.flatMap((b) => (b.bot.stretch.t1 ? [b.bot.stretch.t1] : []));
  assert.ok(stretchT1.some((m) => m >= 300), 'superfans stretching past $300 exist');
  for (const b of bots) {
    for (const t of Object.keys(b.bot.comfort)) {
      assert.ok(b.bot.stretch[t] >= b.bot.comfort[t], 'stretch is never below comfort');
    }
  }
  // Show counts are uniform-ish over 1..N: with 2 shows, both counts appear a lot
  const oneShow = bots.filter((b) => b.showings.length === 1).length;
  assert.ok(oneShow > 500 && oneShow < 1000, `~half pick a single show (got ${oneShow})`);
  runToSettle(drop, rng);
  const bySegment = drop.results.bySegment;
  assert.ok(bySegment && Object.keys(bySegment).length >= 5);
  for (const row of Object.values(bySegment)) assert.ok(row.winners <= row.bidders);
});
