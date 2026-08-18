import test from 'node:test';
import assert from 'node:assert/strict';
import { Drop } from '../src/engine.js';
import { VENUE, TIER_ORDER, seatsForTier } from '../src/venue.js';
import { addBots } from '../src/bots.js';

const SHOWINGS = ['S1', 'S2'];

function makeDrop() {
  return new Drop({ showings: SHOWINGS });
}

test('venue zones cover every seat exactly once', () => {
  const total = VENUE.rows.reduce((sum, r) => sum + r.seats.length, 0);
  const byTier = TIER_ORDER.map((t) => VENUE.capacityPerShowing[t]);
  assert.equal(byTier.reduce((a, b) => a + b, 0), total);
  for (const t of TIER_ORDER) {
    assert.equal(seatsForTier(t).length, VENUE.capacityPerShowing[t]);
  }
});

test('excess demand raises the price, spare capacity lowers it back toward the floor', () => {
  const drop = makeDrop();
  const supply = drop.supply.t1;
  // 3x oversubscribe tier 1 with rich bidders
  for (let i = 0; i < supply * 3; i++) {
    drop.addBidder({ name: `b${i}`, showings: SHOWINGS, tierMaxes: [{ tierId: 't1', maxPrice: 500 }] });
  }
  drop.openBidding();
  const before = drop.prices.t1;
  drop.tick();
  assert.ok(drop.prices.t1 > before, 'price should rise under excess demand');

  // Everyone bails: price should sag back toward the floor over the next rounds
  for (const b of drop.bidders.values()) drop.withdraw(b.id);
  const spiked = drop.prices.t1;
  drop.tick();
  assert.ok(drop.prices.t1 < spiked, 'price should fall when demand collapses');
});

test('bidders priced out of a tier cascade into their next tier pool', () => {
  const drop = makeDrop();
  const f = drop.floors.t1;
  const cheap = drop.addBidder({
    name: 'cheap',
    showings: SHOWINGS,
    tierMaxes: [
      { tierId: 't1', maxPrice: f + 1 },
      { tierId: 't2', maxPrice: 500 },
    ],
  });
  assert.equal(drop.targetTier(cheap), 't1');
  drop.prices.t1 = f + 2; // clock passes their t1 max
  assert.equal(drop.targetTier(cheap), 't2');
  drop.prices.t1 = f; // and they re-enter if it falls back
  assert.equal(drop.targetTier(cheap), 't1');
});

test('drop settles: capacity respected, uniform price per tier, nobody pays over their max', () => {
  const drop = makeDrop();
  addBots(drop, 900, mulberry32(7));
  drop.openBidding();
  let guard = 0;
  while (drop.phase === 'bidding' && guard++ < 100) drop.tick();
  assert.equal(drop.phase, 'settled');

  const winners = [...drop.bidders.values()].filter((b) => b.assignment);
  assert.ok(winners.length > 0);

  const seatCount = new Map(); // "tier|showing" -> count
  const seatIds = new Set();
  for (const w of winners) {
    const { tierId, showing, seat, pricePaid } = w.assignment;
    assert.equal(pricePaid, drop.prices[tierId], 'uniform price per tier');
    const max = w.tierMaxes.find((tm) => tm.tierId === tierId).maxPrice;
    assert.ok(pricePaid <= max, 'never charged over their stated max');
    assert.ok(w.showings.includes(showing), 'assigned an acceptable showing');
    const key = `${tierId}|${showing}`;
    seatCount.set(key, (seatCount.get(key) ?? 0) + 1);
    const seatId = `${showing}|${seat.row}${seat.seat}`;
    assert.ok(!seatIds.has(seatId), 'no double-booked seats');
    seatIds.add(seatId);
  }
  for (const [key, count] of seatCount) {
    const tierId = key.split('|')[0];
    assert.ok(count <= VENUE.capacityPerShowing[tierId], 'per-showing tier capacity respected');
  }
});

test('when the clock clears (demand <= supply), everyone still pooled gets a seat', () => {
  const drop = makeDrop();
  // Modest demand, everyone flexible and within floor prices: clears immediately.
  for (let i = 0; i < 50; i++) {
    drop.addBidder({
      name: `b${i}`,
      showings: SHOWINGS,
      tierMaxes: [{ tierId: 't2', maxPrice: 40 }],
    });
  }
  drop.openBidding();
  let guard = 0;
  while (drop.phase === 'bidding' && guard++ < 100) drop.tick();
  const winners = [...drop.bidders.values()].filter((b) => b.assignment);
  assert.equal(winners.length, 50, 'every committed bidder is guaranteed a seat');
  for (const w of winners) assert.equal(w.assignment.pricePaid, drop.floors.t2);
});

test('withdrawn bidders are never charged or seated', () => {
  const drop = makeDrop();
  const stay = drop.addBidder({ name: 'stay', showings: SHOWINGS, tierMaxes: [{ tierId: 't3', maxPrice: 30 }] });
  const leave = drop.addBidder({ name: 'leave', showings: SHOWINGS, tierMaxes: [{ tierId: 't3', maxPrice: 30 }] });
  drop.openBidding();
  drop.withdraw(leave.id);
  let guard = 0;
  while (drop.phase === 'bidding' && guard++ < 100) drop.tick();
  assert.ok(stay.assignment);
  assert.equal(leave.assignment, null);
});

test('forced settle rations oversubscribed tiers by join order and cascades the overflow', () => {
  const drop = new Drop({ showings: ['S1'], maxRounds: 1 });
  const supply = drop.supply.t1;
  const bidders = [];
  for (let i = 0; i < supply + 10; i++) {
    bidders.push(
      drop.addBidder({
        name: `b${i}`,
        showings: ['S1'],
        tierMaxes: [
          { tierId: 't1', maxPrice: 10000 }, // all rich enough that the clock can't shed them in 1 round
          { tierId: 't2', maxPrice: 10000 },
        ],
      })
    );
  }
  drop.openBidding();
  drop.tick(); // hits maxRounds -> forced settle
  assert.equal(drop.phase, 'settled');
  const inT1 = bidders.filter((b) => b.assignment?.tierId === 't1');
  const inT2 = bidders.filter((b) => b.assignment?.tierId === 't2');
  assert.equal(inT1.length, supply);
  assert.equal(inT2.length, 10);
  // earliest joiners kept the contested tier
  assert.ok(inT1.every((b) => b.joinedAt < supply));
});

test('bidders can update their showings mid-drop, and committedTotal tracks the pool', () => {
  const drop = makeDrop();
  const b = drop.addBidder({ name: 'b', showings: ['S1'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  drop.updateBidder(b.id, { showings: ['S1', 'S2'] });
  assert.deepEqual(b.showings, ['S1', 'S2']);
  assert.throws(() => drop.updateBidder(b.id, { showings: [] }), /at least one showing/);
  assert.deepEqual(b.tierMaxes, [{ tierId: 't2', maxPrice: 40 }], 'tierMaxes untouched by showings update');
  const c = drop.committedTotal();
  assert.equal(c.bidders, 1);
  assert.equal(c.total, drop.prices.t2);
});

test('adding shows grows supply; fully-flexible bidders pick them up, restricted ones keep their set', () => {
  const drop = makeDrop(); // showings S1, S2
  const flexible = drop.addBidder({ name: 'f', showings: ['S1', 'S2'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  const picky = drop.addBidder({ name: 'p', showings: ['S1'], tierMaxes: [{ tierId: 't2', maxPrice: 40 }] });
  const t2Before = drop.supply.t2;
  drop.addShowings(2);
  assert.equal(drop.showings.length, 4);
  assert.equal(drop.supply.t2, t2Before * 2, 'supply doubles when show count doubles');
  assert.equal(flexible.showings.length, 4);
  assert.deepEqual(picky.showings, ['S1']);
});

test('crowd spans socioeconomic backgrounds, including bidders willing to pay hundreds', () => {
  const drop = makeDrop();
  addBots(drop, 2000, mulberry32(3));
  const bidders = [...drop.bidders.values()];
  const t1Maxes = bidders
    .flatMap((b) => b.tierMaxes.filter((tm) => tm.tierId === 't1'))
    .map((tm) => tm.maxPrice);
  assert.ok(t1Maxes.some((m) => m >= 300), 'some superfans will pay $300+ for prime seats');
  assert.ok(t1Maxes.some((m) => m <= 60), 'and plenty of modest budgets exist alongside them');
  const segments = new Set(bidders.map((b) => b.segment));
  assert.ok(segments.size >= 5, 'all five segments are represented');

  drop.openBidding();
  let guard = 0;
  while (drop.phase === 'bidding' && guard++ < 100) drop.tick();
  const bySegment = drop.results.bySegment;
  assert.ok(bySegment && Object.keys(bySegment).length >= 5, 'settlement reports per-segment outcomes');
  for (const row of Object.values(bySegment)) {
    assert.ok(row.winners <= row.bidders);
  }
});

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
