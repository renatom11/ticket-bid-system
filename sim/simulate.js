// CLI simulation: run a full drop with a crowd of bots and print the
// round-by-round price discovery. Usage: npm run sim [-- <botCount> <seed>]

import { Drop } from '../src/engine.js';
import { addBots } from '../src/bots.js';
import { TIERS, TIER_ORDER } from '../src/venue.js';

const botCount = Number(process.argv[2] ?? 2500);
const seed = Number(process.argv[3] ?? 42);

// Small deterministic RNG so runs are reproducible.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const drop = new Drop({ name: 'Simulated Drop' });
addBots(drop, botCount, mulberry32(seed));

console.log(`\n${drop.name}: ${botCount} bidders, ${drop.showings.length} showings\n`);
console.log('Supply per tier:', TIER_ORDER.map((t) => `${t}=${drop.supply[t]}`).join('  '));
console.log('\nRound | ' + TIER_ORDER.map((t) => `${t} price (demand/supply)`).join(' | '));
console.log('-'.repeat(100));

drop.openBidding();
const line = (label) =>
  console.log(
    `${String(label).padStart(5)} | ` +
      TIER_ORDER.map(
        (t) => `$${String(drop.prices[t]).padStart(4)} (${drop.lastDemand[t]}/${drop.supply[t]})`.padEnd(22)
      ).join(' | ')
  );
line('start');
while (drop.phase === 'bidding') {
  drop.tick();
  line(drop.round);
}

const r = drop.results;
console.log(`\nSettled in ${r.rounds} rounds`);
console.log(`Winners: ${r.winners}/${r.participants} bidders · revenue $${r.revenue.toLocaleString()}\n`);
for (const tier of TIERS) {
  const row = r.byTier[tier.id];
  console.log(
    `${tier.name.padEnd(24)} settled $${String(row.finalPrice).padStart(4)} · sold ${row.sold}/${row.supply}`
  );
}
console.log();
