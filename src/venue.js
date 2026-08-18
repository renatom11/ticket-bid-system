// AMC Lincoln Square style auditorium.
// Rows A-M (no row I), cross-aisle between H and J.
// Zones are our own, derived from geometry (row + distance from center),
// not the seat map image's recommendations:
//   T1 "Center of Center" : middle 12 seats of H and J — the core, guaranteed
//   T2 "Prime Center"     : rest of the center blocks of G, H, J, K
//   T3 "Great"            : sides of G-K, center of L and M
//   T4 "Okay"             : centers of E and F, far sides of L and M
//   T5 "Front"            : rows A-D, far edges of E and F

export const TIERS = [
  { id: 't1', name: 'Tier 1 · Center of Center', floorPrice: 40 },
  { id: 't2', name: 'Tier 2 · Prime Center', floorPrice: 30 },
  { id: 't3', name: 'Tier 3 · Great', floorPrice: 25 },
  { id: 't4', name: 'Tier 4 · Okay', floorPrice: 20 },
  { id: 't5', name: 'Tier 5 · Front', floorPrice: 15 },
];

export const TIER_ORDER = TIERS.map((t) => t.id);

const ROW_DEFS = [
  // [label, seatCount, zoneRule]
  ['A', 28, () => 't5'],
  ['B', 32, () => 't5'],
  ['C', 36, () => 't5'],
  ['D', 38, () => 't5'],
  ['E', 38, sideRule(5, 't5', 't4')],
  ['F', 38, sideRule(5, 't5', 't4')],
  ['G', 38, sideRule(8, 't3', 't2')],
  ['H', 38, coreRule],
  ['J', 38, coreRule],
  ['K', 38, sideRule(8, 't3', 't2')],
  ['L', 38, sideRule(10, 't4', 't3')],
  ['M', 36, sideRule(10, 't4', 't3')],
];

function sideRule(sideWidth, sideTier, centerTier) {
  return (seatIdx, seatCount) =>
    seatIdx < sideWidth || seatIdx >= seatCount - sideWidth ? sideTier : centerTier;
}

// The two rows at the cross-aisle: sides are T3, center block T2, and the
// middle 12 seats are the Center of Center.
function coreRule(seatIdx, seatCount) {
  if (seatIdx < 8 || seatIdx >= seatCount - 8) return 't3';
  return Math.abs(seatIdx - (seatCount - 1) / 2) <= 5.5 ? 't1' : 't2';
}

function buildVenue() {
  const rows = ROW_DEFS.map(([label, seatCount, rule]) => ({
    label,
    seats: Array.from({ length: seatCount }, (_, i) => rule(i, seatCount)),
  }));
  const capacityPerShowing = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
  for (const row of rows) {
    for (const tier of row.seats) capacityPerShowing[tier] += 1;
  }
  return { name: 'AMC Lincoln Square (prototype layout)', rows, capacityPerShowing };
}

export const VENUE = buildVenue();

// Seats within a tier, ordered by desirability (center-out within each row,
// rows in a per-tier preference order). Used to hand out concrete seats at settlement.
const TIER_ROW_PREFERENCE = {
  t1: ['H', 'J'],
  t2: ['H', 'J', 'G', 'K'],
  t3: ['J', 'K', 'G', 'H', 'L', 'M'],
  t4: ['F', 'E', 'L', 'M'],
  t5: ['D', 'C', 'E', 'F', 'B', 'A'],
};

export function seatsForTier(tierId) {
  const seats = [];
  for (const rowLabel of TIER_ROW_PREFERENCE[tierId]) {
    const row = VENUE.rows.find((r) => r.label === rowLabel);
    const indices = row.seats
      .map((t, i) => (t === tierId ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => centerDistance(a, row.seats.length) - centerDistance(b, row.seats.length));
    for (const i of indices) seats.push({ row: rowLabel, seat: i + 1 });
  }
  return seats;
}

function centerDistance(idx, count) {
  return Math.abs(idx - (count - 1) / 2);
}
