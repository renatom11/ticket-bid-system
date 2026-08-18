// Demo crowd: bots with randomized tastes so a drop shows real dynamics —
// an early spike on the good tiers, dropouts, prices sagging back, cascades
// into lower tiers, then equilibrium.

import { TIER_ORDER } from './venue.js';

// Rough mean willingness-to-pay per tier for a bot whose *top choice* is that tier.
const TOP_TIER_MEANS = { t1: 95, t2: 60, t3: 38, t4: 22 };
// Share of bots whose top choice is each tier — most people want the good seats.
const TOP_TIER_WEIGHTS = [
  ['t1', 0.45],
  ['t2', 0.3],
  ['t3', 0.17],
  ['t4', 0.08],
];

export function addBots(drop, count, rng = Math.random) {
  const added = [];
  for (let i = 0; i < count; i++) {
    const topTier = pickWeighted(TOP_TIER_WEIGHTS, rng);
    const startIdx = TIER_ORDER.indexOf(topTier);
    // How far down the tier ladder they're willing to fall if priced out.
    const depth = 1 + Math.floor(rng() * (TIER_ORDER.length - startIdx));
    const budget = lognormalish(TOP_TIER_MEANS[topTier], rng);
    const tierMaxes = [];
    for (let d = 0; d < depth; d++) {
      const tierId = TIER_ORDER[startIdx + d];
      // Willing to pay less for each step down from their top choice.
      tierMaxes.push({ tierId, maxPrice: Math.max(5, Math.round(budget * 0.75 ** d)) });
    }
    const showings = pickShowings(drop.showings, rng);
    added.push(drop.addBidder({ name: `Bot ${drop.nextBidderId}`, showings, tierMaxes }));
  }
  return added;
}

function pickWeighted(pairs, rng) {
  let r = rng();
  for (const [value, weight] of pairs) {
    r -= weight;
    if (r <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

// Skewed positive distribution: most bots near the mean, a long tail of superfans.
function lognormalish(mean, rng) {
  const n = (rng() + rng() + rng() - 1.5) / 1.5; // approx normal in [-1, 1]
  return Math.max(5, Math.round(mean * Math.exp(n * 0.6)));
}

function pickShowings(showings, rng) {
  if (rng() < 0.6) return [...showings]; // most people are flexible
  const count = 1 + Math.floor(rng() * showings.length);
  return [...showings].sort(() => rng() - 0.5).slice(0, count);
}
