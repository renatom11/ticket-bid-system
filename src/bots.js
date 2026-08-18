// Demo crowd: bidders drawn from socioeconomic segments so a drop shows real
// dynamics — an early spike on the good tiers, dropouts, prices sagging back,
// cascades into lower tiers, then equilibrium.
//
// Budgets are lognormal per segment (real long tails: a superfan can be worth
// $500+ for prime seats). Note the uniform-price twist: the wealthy don't set
// the settled price — the marginal winner does — so a $400-budget superfan
// still pays the same clearing price as everyone else in the tier.

import { TIER_ORDER } from './venue.js';

export const SEGMENTS = [
  {
    id: 'superfan',
    name: 'Superfans / high income',
    weight: 0.07,
    budget: { median: 260, sigma: 0.45 }, // for their top tier; tails past $600
    topTiers: [['t1', 0.9], ['t2', 0.1]],
    maxDepth: 2, // would rather skip than sit up front
  },
  {
    id: 'comfortable',
    name: 'Comfortable professionals',
    weight: 0.18,
    budget: { median: 110, sigma: 0.4 },
    topTiers: [['t1', 0.6], ['t2', 0.4]],
    maxDepth: 3,
  },
  {
    id: 'middle',
    name: 'Middle income',
    weight: 0.4,
    budget: { median: 55, sigma: 0.45 },
    topTiers: [['t1', 0.35], ['t2', 0.4], ['t3', 0.25]],
    maxDepth: 3,
  },
  {
    id: 'budget',
    name: 'Budget-conscious',
    weight: 0.25,
    budget: { median: 28, sigma: 0.4 },
    topTiers: [['t2', 0.15], ['t3', 0.5], ['t4', 0.35]],
    maxDepth: 4, // any seat beats no seat
  },
  {
    id: 'student',
    name: 'Students / lowest budget',
    weight: 0.1,
    budget: { median: 16, sigma: 0.35 },
    topTiers: [['t3', 0.3], ['t4', 0.7]],
    maxDepth: 4,
  },
];

// Willingness drops with each step down from the top-choice tier.
const STEP_DOWN = 0.7;

export function addBots(drop, count, rng = Math.random) {
  const added = [];
  for (let i = 0; i < count; i++) {
    const segment = pickWeighted(SEGMENTS.map((s) => [s, s.weight]), rng);
    const topTier = pickWeighted(segment.topTiers, rng);
    const startIdx = TIER_ORDER.indexOf(topTier);
    const depth = Math.min(
      1 + Math.floor(rng() * segment.maxDepth),
      TIER_ORDER.length - startIdx
    );
    const budget = lognormal(segment.budget.median, segment.budget.sigma, rng);
    const tierMaxes = [];
    for (let d = 0; d < depth; d++) {
      tierMaxes.push({
        tierId: TIER_ORDER[startIdx + d],
        maxPrice: Math.max(5, Math.round(budget * STEP_DOWN ** d)),
      });
    }
    const showings = pickShowings(drop.showings, rng);
    added.push(
      drop.addBidder({
        name: `Bot ${drop.nextBidderId}`,
        showings,
        tierMaxes,
        segment: segment.id,
      })
    );
  }
  return added;
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
