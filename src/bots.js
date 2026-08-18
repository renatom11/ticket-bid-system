// Demo crowd: bidders drawn from socioeconomic segments, with behavioral
// bidding. Each bot has a private true budget (lognormal per segment — real
// long tails: a superfan can be worth $500+ for prime seats) but starts with
// a cautious stated ceiling near the floor, the way real buyers anchor low.
// Between ticks, bots that are currently losing either raise their stated
// ceilings toward their true budget or give up. Prices published each tick
// are exact for the stated book, and the drop settles when the crowd stops
// moving.

import { TIERS, TIER_ORDER } from './venue.js';

export const SEGMENTS = [
  {
    id: 'superfan',
    name: 'Superfans / high income',
    weight: 0.07,
    budget: { median: 260, sigma: 0.45 },
    topTiers: [['t1', 0.7], ['t2', 0.3]],
    maxDepth: 2, // would rather skip than sit up front
  },
  {
    id: 'comfortable',
    name: 'Comfortable professionals',
    weight: 0.18,
    budget: { median: 110, sigma: 0.4 },
    topTiers: [['t1', 0.1], ['t2', 0.5], ['t3', 0.4]],
    maxDepth: 3,
  },
  {
    id: 'middle',
    name: 'Middle income',
    weight: 0.4,
    budget: { median: 55, sigma: 0.45 },
    topTiers: [['t2', 0.3], ['t3', 0.4], ['t4', 0.3]],
    maxDepth: 3,
  },
  {
    id: 'budget',
    name: 'Budget-conscious',
    weight: 0.25,
    budget: { median: 28, sigma: 0.4 },
    topTiers: [['t3', 0.15], ['t4', 0.5], ['t5', 0.35]],
    maxDepth: 4, // any seat beats no seat
  },
  {
    id: 'student',
    name: 'Students / lowest budget',
    weight: 0.1,
    budget: { median: 16, sigma: 0.35 },
    topTiers: [['t4', 0.3], ['t5', 0.7]],
    maxDepth: 4,
  },
];

// Willingness drops with each step down from the top-choice tier.
const STEP_DOWN = 0.7;
const QUIT_PROB = 0.1; // chance a losing bot stops raising, per tick

const floorOf = Object.fromEntries(TIERS.map((t) => [t.id, t.floorPrice]));

export function addBots(drop, count, rng = Math.random) {
  const added = [];
  for (let i = 0; i < count; i++) {
    const segment = pickWeighted(SEGMENTS.map((s) => [s, s.weight]), rng);
    const topTier = pickWeighted(segment.topTiers, rng);
    const startIdx = TIER_ORDER.indexOf(topTier);
    const depth = Math.min(1 + Math.floor(rng() * segment.maxDepth), TIER_ORDER.length - startIdx);
    const budget = lognormal(segment.budget.median, segment.budget.sigma, rng);
    const trueMaxes = {};
    const tierMaxes = [];
    for (let d = 0; d < depth; d++) {
      const tierId = TIER_ORDER[startIdx + d];
      const trueMax = Math.max(5, Math.round(budget * STEP_DOWN ** d));
      trueMaxes[tierId] = trueMax;
      // anchor low: open near the floor, never above the true budget
      tierMaxes.push({
        tierId,
        maxPrice: Math.max(1, Math.min(trueMax, floorOf[tierId] + Math.floor(rng() * 8))),
      });
    }
    const showings = pickShowings(drop.showings, rng);
    const bidder = drop.addBidder({ name: `Bot ${drop.nextBidderId}`, showings, tierMaxes, segment: segment.id });
    bidder.bot = {
      trueMaxes,
      quit: false,
      aggression: 0.25 + rng() * 0.35, // how fast they close the gap when losing
    };
    added.push(bidder);
  }
  return added;
}

// Between ticks: losing bots raise stated ceilings toward their true budget
// or give up. Returns how many bids changed (0 = the crowd has converged).
export function adjustBots(drop, rng = Math.random) {
  let changed = 0;
  for (const b of drop.bidders.values()) {
    if (!b.bot || b.bot.quit || b.withdrawn) continue;
    if (drop.currentOf(b)) continue; // winning at current prices: sit tight
    if (rng() < QUIT_PROB) {
      b.bot.quit = true;
      continue;
    }
    let raised = false;
    for (const tm of b.tierMaxes) {
      const trueMax = b.bot.trueMaxes[tm.tierId] ?? tm.maxPrice;
      if (tm.maxPrice < trueMax) {
        tm.maxPrice = Math.min(
          trueMax,
          tm.maxPrice + Math.max(1, Math.round((trueMax - tm.maxPrice) * b.bot.aggression))
        );
        raised = true;
      }
    }
    if (raised) changed += 1;
    else b.bot.quit = true; // at their true budget and still losing: done
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

// True lognormal via Box-Muller: median * exp(sigma * z), z ~ N(0, 1).
function lognormal(median, sigma, rng) {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(5, Math.round(median * Math.exp(sigma * z)));
}

function pickShowings(showings, rng) {
  if (rng() < 0.6) return [...showings]; // most people are flexible
  const count = 1 + Math.floor(rng() * showings.length);
  return [...showings].sort(() => rng() - 0.5).slice(0, count);
}
