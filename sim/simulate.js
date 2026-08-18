// CLI simulation: run a full drop with a behavioral crowd against the exact
// clearing engine, printing each tick's precise prices.
// Usage: npm run sim [-- <botCount> <seed>]

import { Drop } from '../src/engine.js';
import { addBots, adjustBots, SEGMENTS } from '../src/bots.js';
import { TIERS, TIER_ORDER } from '../src/venue.js';

const botCount = Number(process.argv[2] ?? 2500);
const seed = Number(process.argv[3] ?? 42);

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(seed);
const drop = new Drop({ name: 'Simulated Drop' });
addBots(drop, botCount, rng);

console.log(`\n${drop.name}: ${botCount} bidders, ${drop.showings.length} shows`);
console.log('Exact clearing each tick; bots anchor low and raise while losing.\n');
console.log('Supply per tier:', TIER_ORDER.map((t) => `${t}=${drop.supply[t]}`).join('  '));
console.log(
  '\nRound | ' + TIER_ORDER.map((t) => `${t} $min-max (seated)`).join(' | ') + ' | moved'
);
console.log('-'.repeat(110));

const line = (label, moved) =>
  console.log(
    `${String(label).padStart(5)} | ` +
      TIER_ORDER.map((t) => {
        const range = drop.prices[t] === drop.priceMax[t]
          ? `$${drop.prices[t]}`
          : `$${drop.prices[t]}-${drop.priceMax[t]}`;
        return `${range} (${drop.seated[t]}/${drop.supply[t]})`.padEnd(19);
      }).join(' | ') +
      ` | ${moved}`
  );

drop.openBidding();
line('start', '-');
while (drop.phase === 'bidding') {
  const moved = adjustBots(drop, rng);
  drop.tick();
  line(drop.round, moved);
}

const r = drop.results;
console.log(`\nSettled in ${r.rounds} rounds`);
console.log(`Winners: ${r.winners}/${r.participants} bidders · revenue $${r.revenue.toLocaleString()}\n`);
for (const tier of TIERS) {
  const row = r.byTier[tier.id];
  const range = row.priceMin === row.priceMax ? `$${row.priceMin}` : `$${row.priceMin}-$${row.priceMax}`;
  console.log(`${tier.name.padEnd(26)} settled ${range.padStart(9)} · sold ${row.sold}/${row.supply}`);
}

if (r.bySegment) {
  console.log('\nWho got in, by segment:');
  for (const seg of SEGMENTS) {
    const row = r.bySegment[seg.id];
    if (!row) continue;
    const pct = Math.round((row.winners / row.bidders) * 100);
    const avg = row.winners ? Math.round(row.totalPaid / row.winners) : 0;
    console.log(
      `${seg.name.padEnd(28)} ${String(row.winners).padStart(4)}/${String(row.bidders).padEnd(4)} seated (${String(pct).padStart(3)}%) · avg paid $${avg}`
    );
  }
}

// Hot cells: with popularity-weighted availability, individual shows carry
// real premiums over their tier's floor.
const premiums = [...drop.cellPrices]
  .map(([key, p]) => ({ key, premium: p - drop.floors[key.split('|')[1]], price: p }))
  .filter((c) => c.premium > 0)
  .sort((a, b) => b.premium - a.premium)
  .slice(0, 6);
if (premiums.length) {
  console.log('\nHottest cells (price over floor):');
  for (const c of premiums) {
    const [show, tier] = c.key.split('|');
    console.log(`  ${show.padEnd(12)} ${tier}  $${c.price}  (+$${c.premium})`);
  }
}

// Show-count distribution of the crowd (uniform 1..N by design).
const hist = new Map();
for (const b of drop.bidders.values()) hist.set(b.showings.length, (hist.get(b.showings.length) ?? 0) + 1);
console.log('\nShow-count distribution:', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));

// Guarantee check: at exact clearing prices, nobody who can afford a cell is
// left out, and every winner is in a best cell for them.
let violations = 0;
for (const b of drop.bidders.values()) {
  if (b.withdrawn || b.assignment) continue;
  for (const tm of b.tierMaxes) {
    for (const s of b.showings) {
      if (tm.maxPrice > drop.cellPrices.get(`${s}|${tm.tierId}`)) violations++;
    }
  }
}
console.log(`\nGuarantee check: ${violations === 0 ? 'PASS' : 'FAIL'} — no unseated bidder can afford any cell they accept.`);
console.log();
