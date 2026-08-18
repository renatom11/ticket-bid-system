import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMarket } from '../src/market.js';

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const value = (b, show, tierId) => {
  if (!b.showings.includes(show)) return null;
  const tm = b.tierMaxes.find((x) => x.tierId === tierId);
  return tm ? tm.maxPrice : null;
};

// Exhaustive max-surplus search for tiny instances.
function bruteForceSurplus({ showings, tiers, capacityPerShowing, bidders }) {
  const cells = [];
  for (const s of showings) for (const t of tiers) cells.push({ s, t: t.id, floor: t.floorPrice, cap: capacityPerShowing[t.id] });
  let best = 0;
  const used = cells.map(() => 0);
  function rec(i, surplus) {
    if (i === bidders.length) {
      best = Math.max(best, surplus);
      return;
    }
    rec(i + 1, surplus); // bidder stays out
    const b = bidders[i];
    for (let c = 0; c < cells.length; c++) {
      if (used[c] >= cells[c].cap) continue;
      const m = value(b, cells[c].s, cells[c].t);
      if (m === null) continue;
      used[c]++;
      rec(i + 1, surplus + (m - cells[c].floor));
      used[c]--;
    }
  }
  rec(0, 0);
  return best;
}

function randomInstance(rng, { nBidders, nShows, nTiers, cap, maxV }) {
  const showings = Array.from({ length: nShows }, (_, i) => `S${i + 1}`);
  const tiers = Array.from({ length: nTiers }, (_, i) => ({ id: `t${i + 1}`, floorPrice: 2 + i * 3 }));
  const capacityPerShowing = Object.fromEntries(tiers.map((t) => [t.id, 1 + Math.floor(rng() * cap)]));
  const bidders = [];
  for (let i = 0; i < nBidders; i++) {
    const shows = showings.filter(() => rng() < 0.6);
    if (shows.length === 0) shows.push(showings[Math.floor(rng() * nShows)]);
    const tierMaxes = tiers
      .filter(() => rng() < 0.7)
      .map((t) => ({ tierId: t.id, maxPrice: 1 + Math.floor(rng() * maxV) }));
    if (tierMaxes.length === 0) tierMaxes.push({ tierId: tiers[0].id, maxPrice: 1 + Math.floor(rng() * maxV) });
    bidders.push({ id: `b${i}`, showings: shows, tierMaxes });
  }
  return { showings, tiers, capacityPerShowing, bidders };
}

function checkEquilibrium(inst, { prices, assignments }) {
  const { showings, tiers, capacityPerShowing, bidders } = inst;
  const floorOf = Object.fromEntries(tiers.map((t) => [t.id, t.floorPrice]));
  // capacity + assigned validity
  const fill = new Map();
  for (const [bid, a] of assignments) {
    const key = `${a.show}|${a.tierId}`;
    fill.set(key, (fill.get(key) ?? 0) + 1);
    assert.equal(a.price, prices.get(key));
    const b = bidders.find((x) => x.id === bid);
    const m = value(b, a.show, a.tierId);
    assert.ok(m !== null, 'assigned only to accepted cells');
    assert.ok(m - a.price >= 0, `assigned utility >= 0 (m=${m} p=${a.price})`);
    // own cell is a best cell
    for (const s of showings) {
      for (const t of tiers) {
        const m2 = value(b, s, t.id);
        if (m2 === null) continue;
        const u2 = m2 - prices.get(`${s}|${t.id}`);
        assert.ok(m - a.price >= u2 - 1e-9, 'assigned bidder is in an argmax cell');
      }
    }
  }
  for (const s of showings) {
    for (const t of tiers) {
      const key = `${s}|${t.id}`;
      const sold = fill.get(key) ?? 0;
      assert.ok(sold <= capacityPerShowing[t.id], 'capacity respected');
      const p = prices.get(key);
      assert.ok(p >= floorOf[t.id], 'price >= floor');
      if (sold < capacityPerShowing[t.id]) {
        // slack cells: no unassigned bidder may strictly afford them, and no
        // assigned bidder elsewhere may strictly prefer them (already checked)
        for (const b of bidders) {
          if (assignments.has(b.id)) continue;
          const m = value(b, s, t.id);
          if (m !== null) assert.ok(m <= p, 'unassigned bidder cannot afford slack cell');
        }
      }
    }
  }
  // unassigned bidders: utility <= 0 everywhere they accept
  for (const b of bidders) {
    if (assignments.has(b.id)) continue;
    for (const s of showings) {
      for (const t of tiers) {
        const m = value(b, s, t.id);
        if (m === null) continue;
        assert.ok(m - prices.get(`${s}|${t.id}`) <= 1e-9, 'unassigned bidder priced out everywhere');
      }
    }
  }
}

test('solver matches brute force surplus on tiny random instances', () => {
  const rng = mulberry32(11);
  for (let iter = 0; iter < 60; iter++) {
    const inst = randomInstance(rng, { nBidders: 5, nShows: 2, nTiers: 2, cap: 2, maxV: 30 });
    const { prices, assignments } = solveMarket(inst);
    const floorOf = Object.fromEntries(inst.tiers.map((t) => [t.id, t.floorPrice]));
    let surplus = 0;
    for (const [bid, a] of assignments) {
      const b = inst.bidders.find((x) => x.id === bid);
      surplus += value(b, a.show, a.tierId) - floorOf[a.tierId];
    }
    const best = bruteForceSurplus(inst);
    assert.equal(surplus, best, `iter ${iter}: solver surplus ${surplus} != optimal ${best}`);
    checkEquilibrium(inst, { prices, assignments });
  }
});

test('equilibrium properties hold on medium random instances', () => {
  const rng = mulberry32(23);
  for (let iter = 0; iter < 5; iter++) {
    const inst = randomInstance(rng, { nBidders: 400, nShows: 3, nTiers: 3, cap: 25, maxV: 120 });
    checkEquilibrium(inst, solveMarket(inst));
  }
});

test('hint screening never changes the answer', () => {
  const rng = mulberry32(31);
  for (let iter = 0; iter < 4; iter++) {
    const inst = randomInstance(rng, { nBidders: 400, nShows: 3, nTiers: 3, cap: 25, maxV: 120 });
    const plain = solveMarket(inst);
    // hints from a totally different book state must not affect the result
    const misleadingHints = [
      undefined,
      [...plain.prices].map(([k, v]) => [k, v + 40]), // screens out lots of bidders
      [...plain.prices].map(([k]) => [k, 0]), // screens out nobody
    ];
    for (const hint of misleadingHints) {
      const hinted = solveMarket({ ...inst, hint });
      assert.deepEqual([...hinted.prices], [...plain.prices], `iter ${iter}: prices differ under hint`);
      assert.equal(hinted.assignments.size, plain.assignments.size, `iter ${iter}: assignment count differs`);
    }
  }
});

test('second-price flavor: the marginal loser sets the price', () => {
  const inst = {
    showings: ['S1'],
    tiers: [{ id: 't1', floorPrice: 10 }],
    capacityPerShowing: { t1: 1 },
    bidders: [
      { id: 'hi', showings: ['S1'], tierMaxes: [{ tierId: 't1', maxPrice: 100 }] },
      { id: 'lo', showings: ['S1'], tierMaxes: [{ tierId: 't1', maxPrice: 60 }] },
    ],
  };
  const { prices, assignments } = solveMarket(inst);
  assert.ok(assignments.has('hi'));
  assert.ok(!assignments.has('lo'));
  assert.equal(prices.get('S1|t1'), 60, 'winner pays the losing bid, not their own max');
});

test('flexibility is precisely priced: constrained-to-hot pay the premium, flexible pay floor', () => {
  // 3 seats per show in t1, two shows. 5 bidders insist on S1; 1 is flexible.
  const inst = {
    showings: ['S1', 'S2'],
    tiers: [{ id: 't1', floorPrice: 10 }],
    capacityPerShowing: { t1: 3 },
    bidders: [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `hot${i}`,
        showings: ['S1'],
        tierMaxes: [{ tierId: 't1', maxPrice: 50 + i * 10 }], // 50..90
      })),
      { id: 'flex', showings: ['S1', 'S2'], tierMaxes: [{ tierId: 't1', maxPrice: 55 }] },
    ],
  };
  const { prices, assignments } = solveMarket(inst);
  // S1 fits 3 of the 5 insisters: price = the 4th-highest insisting bid (60).
  assert.equal(prices.get('S1|t1'), 60);
  assert.equal(prices.get('S2|t1'), 10, 'the slack show stays at floor');
  const flex = assignments.get('flex');
  assert.equal(flex.show, 'S2', 'flexible bidder is steered to the slack show');
  assert.equal(flex.price, 10, 'and pays floor — the exact flexibility discount');
  assert.ok(!assignments.has('hot0'));
  assert.ok(!assignments.has('hot1'), 'the two lowest insisters are priced out');
});
