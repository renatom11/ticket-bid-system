// Demo crowd: bidders drawn from socioeconomic segments, with a behavioral
// model aimed at realism rather than convenience:
//
// - Availability: each bot can attend a uniformly random NUMBER of shows
//   (1..N with equal probability), and WHICH shows is drawn weighted by
//   per-show popularity (some showtimes are simply hotter), so per-show
//   price premiums emerge naturally.
// - Two-zone valuations per tier: a COMFORT price (what they think the tier
//   is worth — reached quickly while losing) and a STRETCH ceiling
//   (comfort x (1 + tolerance), tolerance drawn per tier per bidder — the
//   zone they grind into reluctantly before giving up).
// - Attention: bots only react to a tick with some probability (people
//   don't watch every refresh).
// - FOMO: a tier whose price jumped since a bot last looked triggers
//   bigger raises.
// - Quit hazard: the longer a bot keeps losing, the likelier they walk;
//   losing with every accepted cell priced beyond their stretch is certain
//   exit.
// - Late joiners: a slice of the crowd only shows up a few ticks into the
//   bidding.
//
// Segments set the money scale (lognormal budgets with real long tails) and
// the personality ranges (tolerance, attention).

import { TIERS, TIER_ORDER } from './venue.js';

export const SEGMENTS = [
  {
    id: 'superfan',
    name: 'Superfans / high income',
    weight: 0.07,
    budget: { median: 260, sigma: 0.45 },
    topTiers: [['t1', 0.7], ['t2', 0.3]],
    maxDepth: 2, // would rather skip than sit up front
    tol: [0.5, 1.0], // will stretch far past comfort for the thing they love
    attention: [0.8, 1.0],
  },
  {
    id: 'comfortable',
    name: 'Comfortable professionals',
    weight: 0.18,
    budget: { median: 110, sigma: 0.4 },
    topTiers: [['t1', 0.1], ['t2', 0.5], ['t3', 0.4]],
    maxDepth: 3,
    tol: [0.3, 0.7],
    attention: [0.6, 1.0],
  },
  {
    id: 'middle',
    name: 'Middle income',
    weight: 0.4,
    budget: { median: 55, sigma: 0.45 },
    topTiers: [['t2', 0.3], ['t3', 0.4], ['t4', 0.3]],
    maxDepth: 3,
    tol: [0.2, 0.5],
    attention: [0.4, 0.9],
  },
  {
    id: 'budget',
    name: 'Budget-conscious',
    weight: 0.25,
    budget: { median: 28, sigma: 0.4 },
    topTiers: [['t3', 0.15], ['t4', 0.5], ['t5', 0.35]],
    maxDepth: 4, // any seat beats no seat
    tol: [0.1, 0.35],
    attention: [0.3, 0.8],
  },
  {
    id: 'student',
    name: 'Students / lowest budget',
    weight: 0.1,
    budget: { median: 16, sigma: 0.35 },
    topTiers: [['t4', 0.3], ['t5', 0.7]],
    maxDepth: 4,
    tol: [0.05, 0.3],
    attention: [0.3, 0.7],
  },
];

// Comfort drops with each step down from the top-choice tier.
const STEP_DOWN = 0.7;
const LATE_JOINER_SHARE = 0.25;
const FOMO_TRIGGER = 1.08; // price grew >8% since last look
const FOMO_MULT = 1.6;

const floorOf = Object.fromEntries(TIERS.map((t) => [t.id, t.floorPrice]));

// Per-drop show popularity (lognormal, wide — a Friday-night show really
// does draw several times a weekday matinee): consistent across addBots
// calls, extended when shows are added mid-drop.
function popularity(drop, rng) {
  const pop = (drop.__showPopularity ??= new Map());
  for (const s of drop.showings) {
    if (!pop.has(s)) pop.set(s, Math.exp(gaussian(rng) * 0.9));
  }
  return pop;
}

export function addBots(drop, count, rng = Math.random) {
  const pop = popularity(drop, rng);
  const added = [];
  for (let i = 0; i < count; i++) {
    const segment = pickWeighted(SEGMENTS.map((s) => [s, s.weight]), rng);
    const topTier = pickWeighted(segment.topTiers, rng);
    const startIdx = TIER_ORDER.indexOf(topTier);
    const depth = Math.min(1 + Math.floor(rng() * segment.maxDepth), TIER_ORDER.length - startIdx);
    const budget = lognormal(segment.budget.median, segment.budget.sigma, rng);

    const comfort = {};
    const stretch = {};
    const tierMaxes = [];
    for (let d = 0; d < depth; d++) {
      const tierId = TIER_ORDER[startIdx + d];
      const c = Math.max(5, Math.round(budget * STEP_DOWN ** d));
      // tolerance to go up, drawn separately for every tier
      const tol = segment.tol[0] + rng() * (segment.tol[1] - segment.tol[0]);
      comfort[tierId] = c;
      stretch[tierId] = Math.max(c, Math.round(c * (1 + tol)));
      // anchor low: open near the floor, never above comfort
      tierMaxes.push({
        tierId,
        maxPrice: Math.max(1, Math.min(c, floorOf[tierId] + Math.floor(rng() * 6))),
      });
    }

    // availability: uniform 1..N show count, popularity-weighted picks
    const k = 1 + Math.floor(rng() * drop.showings.length);
    const showings = pickShowsWeighted(drop.showings, k, pop, rng);

    const bidder = drop.addBidder({
      name: `Bot ${drop.nextBidderId}`,
      showings,
      tierMaxes,
      segment: segment.id,
    });
    bidder.bot = {
      comfort,
      stretch,
      attention: segment.attention[0] + rng() * (segment.attention[1] - segment.attention[0]),
      quit: false,
      losingTicks: 0,
      lastSeen: {},
      fullyFlexible: showings.length === drop.showings.length,
    };
    if (rng() < LATE_JOINER_SHARE) {
      bidder.bot.arrivesAt = 1 + Math.floor(rng() * 8);
      bidder.withdrawn = true; // not in the book until they arrive
    }
    added.push(bidder);
  }
  return added;
}

// Between ticks: arrivals, distraction, FOMO, comfort-then-stretch raising,
// and quitting. Returns how many bidders changed (0 = crowd has converged).
export function adjustBots(drop, rng = Math.random) {
  if (drop.phase !== 'bidding') return 0;
  let changed = 0;
  for (const b of drop.bidders.values()) {
    const bot = b.bot;
    if (!bot || bot.quit) continue;

    // Late joiners arrive
    if (bot.arrivesAt !== undefined && b.withdrawn) {
      if (drop.round + 1 >= bot.arrivesAt) {
        b.withdrawn = false;
        changed += 1;
      }
      continue;
    }
    if (b.withdrawn) continue;

    if (drop.currentOf(b)) {
      bot.losingTicks = 0;
      continue; // winning at current exact prices: sit tight
    }
    if (rng() > bot.attention) continue; // didn't look this tick
    bot.losingTicks += 1;

    // Hopeless? Every cell they accept already costs more than their stretch.
    let cheapestGap = Infinity;
    for (const tm of b.tierMaxes) {
      const cap = bot.stretch[tm.tierId] ?? tm.maxPrice;
      for (const s of b.showings) {
        const p = drop.cellPrices.get(`${s}|${tm.tierId}`);
        if (p !== undefined) cheapestGap = Math.min(cheapestGap, p - cap);
      }
    }
    const hopeless = cheapestGap !== Infinity && cheapestGap > 0;
    const hazard = Math.min(1, 0.02 + 0.015 * bot.losingTicks + (hopeless ? 1 : 0));
    if (rng() < hazard) {
      bot.quit = true;
      continue;
    }

    let raised = false;
    for (const tm of b.tierMaxes) {
      const t = tm.tierId;
      const comfort = bot.comfort[t] ?? tm.maxPrice;
      const stretch = bot.stretch[t] ?? tm.maxPrice;
      const priceNow = drop.prices[t];
      const last = bot.lastSeen[t] ?? priceNow;
      const fomo = priceNow > last * FOMO_TRIGGER ? FOMO_MULT : 1;
      bot.lastSeen[t] = priceNow;
      if (tm.maxPrice < comfort) {
        // below comfort: close most of the gap fast
        const step = Math.max(1, Math.round((comfort - tm.maxPrice) * (0.5 + 0.3 * rng()) * fomo));
        tm.maxPrice = Math.min(comfort, tm.maxPrice + step);
        raised = true;
      } else if (tm.maxPrice < stretch) {
        // tolerance zone: reluctant, small steps
        const step = Math.max(1, Math.round((stretch - tm.maxPrice) * (0.1 + 0.1 * rng()) * fomo));
        tm.maxPrice = Math.min(stretch, tm.maxPrice + step);
        raised = true;
      }
    }
    if (raised) changed += 1;
    else bot.quit = true; // at full stretch everywhere and still losing: done
  }
  if (changed > 0) drop.touch();
  return changed;
}

function pickWeighted(pairs, rng) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, weight] of pairs) {
    r -= weight;
    if (r <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

// k distinct shows, drawn without replacement, weighted by popularity.
function pickShowsWeighted(showings, k, pop, rng) {
  const remaining = showings.map((s) => [s, pop.get(s) ?? 1]);
  const picked = [];
  while (picked.length < k && remaining.length > 0) {
    const total = remaining.reduce((sum, [, w]) => sum + w, 0);
    let r = rng() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i][1];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(remaining[idx][0]);
    remaining.splice(idx, 1);
  }
  return showings.filter((s) => picked.includes(s)); // keep canonical order
}

function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// True lognormal: median * exp(sigma * z), z ~ N(0, 1).
function lognormal(median, sigma, rng) {
  return Math.max(5, Math.round(median * Math.exp(sigma * gaussian(rng))));
}
