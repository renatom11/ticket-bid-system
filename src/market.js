// Exact market clearing for a capacitated unit-demand assignment market
// (Shapley-Shubik with item multiplicities).
//
// Input: bidders with acceptance sets (shows x tiers) and stated ceilings per
// tier. Output: a maximum-surplus assignment plus the buyer-optimal (minimal)
// clearing price for every (show, tier) cell, satisfying:
//   - no cell is filled over capacity,
//   - every assigned bidder is in a best cell for them at these prices,
//   - every unassigned bidder has utility <= 0 at every cell they accept,
//   - cells with unsold seats price at their floor,
//   - no price can be lowered without breaking one of the above.
//
// Algorithm: incremental successive-shortest-path assignment over the cell
// graph. Two structural optimizations keep it fast without giving up
// exactness:
//   1. Exchange-edge caching: for every ordered cell pair (c -> k) a lazy
//      min-heap tracks the cheapest occupant swap, so a path search touches
//      O(cells^2) edges instead of scanning every occupant's options.
//   2. Hint screening: bidders who could not afford any of their cells at
//      the previous solve's prices (the optional `hint`) are deferred; after
//      solving the active set, deferred bidders are re-checked against the
//      *resulting* prices and inserted if they can now afford in, repeating
//      until none can — which is exactly the equilibrium condition, so the
//      result is identical to solving everyone.
// The minimal price vector is then extracted with a difference-constraint
// closure over the optimal assignment.

export function solveMarket({ showings, tiers, capacityPerShowing, bidders, hint }) {
  const nT = tiers.length;
  const nS = showings.length;
  const nC = nS * nT; // cell index = showIdx * nT + tierIdx
  const OUT = nC; // virtual "stay out" column
  const floors = new Float64Array(nC);
  const cap = new Int32Array(nC);
  const tierIdx = new Map(tiers.map((t, i) => [t.id, i]));
  const showIdx = new Map(showings.map((s, i) => [s, i]));
  for (let si = 0; si < nS; si++) {
    for (let ti = 0; ti < nT; ti++) {
      floors[si * nT + ti] = tiers[ti].floorPrice;
      cap[si * nT + ti] = capacityPerShowing[tiers[ti].id];
    }
  }
  const cellKey = (c) => `${showings[Math.floor(c / nT)]}|${tiers[c % nT].id}`;

  // Bidder records. Adjusted value at a cell = stated max - floor (seller
  // reserve); a bidder is only ever seated at non-negative adjusted surplus.
  const recs = bidders.map((b) => {
    const accCells = [];
    const accVals = [];
    for (const tm of b.tierMaxes) {
      const ti = tierIdx.get(tm.tierId);
      if (ti === undefined) continue;
      for (const s of b.showings) {
        const si = showIdx.get(s);
        if (si === undefined) continue;
        const c = si * nT + ti;
        accCells.push(c);
        accVals.push(tm.maxPrice - floors[c]);
      }
    }
    return { id: b.id, accCells, accVals, cell: -1, aval: 0 };
  });

  const assigned = Array.from({ length: nC }, () => []);

  // --- exchange-edge cache ---
  // pairHeaps[c*nC+k]: min-heap of [swapCost, occupant, ] for moving some
  // occupant of c to k. evictHeaps[c]: min-heap of [value, occupant] for
  // pushing an occupant of c out entirely. Entries go stale when occupants
  // move; they are validated (occupant.cell === c) lazily on peek.
  const pairHeaps = new Map();
  const neighbors = Array.from({ length: nC }, () => new Set());
  const evictHeaps = Array.from({ length: nC }, () => []);

  function heapPush(h, item) {
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  function heapPopTop(h) {
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
  }
  function topValid(h, c) {
    while (h.length) {
      if (h[0][1].cell === c) return h[0];
      heapPopTop(h);
    }
    return null;
  }
  // Register x as an occupant of cell c (x.cell and x.aval already set).
  function pushOccupant(x, c) {
    for (let i = 0; i < x.accCells.length; i++) {
      const k = x.accCells[i];
      if (k === c) continue;
      const key = c * nC + k;
      let h = pairHeaps.get(key);
      if (!h) {
        h = [];
        pairHeaps.set(key, h);
        neighbors[c].add(k);
      }
      heapPush(h, [x.aval - x.accVals[i], x]);
    }
    heapPush(evictHeaps[c], [x.aval, x]);
  }

  // --- one row insertion: max-gain augmenting chain via SPFA ---
  const dist = new Float64Array(nC + 1);
  const inQueue = new Uint8Array(nC + 1);
  const parFrom = new Int32Array(nC + 1);
  const parBidder = new Array(nC + 1);

  function insert(r) {
    if (r.accCells.length === 0) return;
    let bestEntry = -Infinity;
    for (let i = 0; i < r.accVals.length; i++) if (r.accVals[i] > bestEntry) bestEntry = r.accVals[i];
    if (bestEntry < 0) return; // can't clear any floor

    dist.fill(Infinity);
    inQueue.fill(0);
    parFrom.fill(-2);
    const queue = [];
    let qHead = 0;
    for (let i = 0; i < r.accCells.length; i++) {
      const c = r.accCells[i];
      const d = -r.accVals[i];
      if (d < dist[c]) {
        dist[c] = d;
        parFrom[c] = -1; // entry by r itself
        parBidder[c] = i; // acc index of the entry
        if (!inQueue[c]) {
          inQueue[c] = 1;
          queue.push(c);
        }
      }
    }

    while (qHead < queue.length) {
      const c = queue[qHead++];
      inQueue[c] = 0;
      if (assigned[c].length < cap[c]) continue; // free capacity: an exit
      const d = dist[c];
      for (const k of neighbors[c]) {
        const t = topValid(pairHeaps.get(c * nC + k), c);
        if (!t) continue;
        const nd = d + t[0];
        if (nd < dist[k] - 1e-9) {
          dist[k] = nd;
          parFrom[k] = c;
          parBidder[k] = t[1];
          if (!inQueue[k]) {
            inQueue[k] = 1;
            queue.push(k);
          }
        }
      }
      const ev = topValid(evictHeaps[c], c);
      if (ev) {
        const nd = d + ev[0] + 1e-7;
        if (nd < dist[OUT] - 1e-9) {
          dist[OUT] = nd;
          parFrom[OUT] = c;
          parBidder[OUT] = ev[1];
        }
      }
    }

    // Pick the best exit: any cell with residual capacity, or OUT (eviction).
    let exit = -1;
    let best = Infinity;
    for (let c = 0; c < nC; c++) {
      if (dist[c] < best - 1e-12 && assigned[c].length < cap[c]) {
        best = dist[c];
        exit = c;
      }
    }
    if (dist[OUT] < best - 1e-9) {
      best = dist[OUT];
      exit = OUT;
    }
    if (exit === -1) return;
    if (best > 1e-9) return; // no non-negative-gain way in
    if (exit === OUT && best > -1e-9) return; // never zero-gain evictions

    // Apply the augmenting chain from the exit back to the entry.
    let cur = exit;
    while (parFrom[cur] !== -1) {
      const from = parFrom[cur];
      const x = parBidder[cur];
      const occ = assigned[from];
      occ.splice(occ.indexOf(x), 1);
      if (cur === OUT) {
        x.cell = -1;
        x.aval = 0;
      } else {
        x.cell = cur;
        x.aval = x.accVals[x.accCells.indexOf(cur)];
        assigned[cur].push(x);
        pushOccupant(x, cur);
      }
      cur = from;
    }
    const accI = parBidder[cur];
    r.cell = cur;
    r.aval = r.accVals[accI];
    assigned[cur].push(r);
    pushOccupant(r, cur);
  }

  // --- buyer-optimal (minimal) price extraction ---
  function extractPrices() {
    const p = new Float64Array(nC);
    for (let c = 0; c < nC; c++) p[c] = floors[c];
    for (const r of recs) {
      if (r.cell !== -1 || r.deferred) continue; // deferred bidders may not set price bounds until woken
      for (let i = 0; i < r.accCells.length; i++) {
        const c = r.accCells[i];
        const m = r.accVals[i] + floors[c];
        if (m > p[c]) p[c] = m;
      }
    }
    let pass = 0;
    for (;;) {
      let changed = false;
      for (let c = 0; c < nC; c++) {
        for (const x of assigned[c]) {
          const mc = x.aval + floors[c];
          for (let i = 0; i < x.accCells.length; i++) {
            const k = x.accCells[i];
            if (k === c) continue;
            const mk = x.accVals[i] + floors[k];
            const need = p[c] + (mk - mc);
            if (need > p[k] + 1e-9) {
              p[k] = need;
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
      if (++pass > nC + 2) throw new Error('price closure did not converge (positive cycle)');
    }
    return p;
  }

  // Insert strongest bidders first: exchange chains stay short, and among
  // equal bids the earlier joiner wins the marginal seat (stable sort over
  // join order).
  const byStrength = (list) =>
    list
      .map((r) => [r.accVals.length ? Math.max(...r.accVals) : -1, r])
      .sort((a, b) => b[0] - a[0])
      .map(([, r]) => r);

  // Hint screening: defer bidders who couldn't afford anything at the
  // previous prices; verify them against the actual result afterwards.
  const hintMap = hint ? new Map(hint) : null;
  let deferred = [];
  const active = [];
  if (hintMap) {
    for (const r of recs) {
      let affordable = false;
      for (let i = 0; i < r.accCells.length; i++) {
        const hp = hintMap.get(cellKey(r.accCells[i]));
        if (hp === undefined || r.accVals[i] + floors[r.accCells[i]] > hp) {
          affordable = true;
          break;
        }
      }
      if (affordable) {
        active.push(r);
      } else {
        r.deferred = true;
        deferred.push(r);
      }
    }
  } else {
    active.push(...recs);
  }
  for (const r of byStrength(active)) insert(r);

  let p = extractPrices();
  for (;;) {
    const wake = deferred.filter((r) => {
      if (r.cell !== -1) return false;
      for (let i = 0; i < r.accCells.length; i++) {
        if (r.accVals[i] + floors[r.accCells[i]] > p[r.accCells[i]]) return true;
      }
      return false;
    });
    if (wake.length === 0) break;
    deferred = deferred.filter((r) => !wake.includes(r));
    for (const r of wake) r.deferred = false;
    for (const r of byStrength(wake)) insert(r);
    p = extractPrices();
  }

  // --- buy-in prices ---
  // For every cell: the minimum bid that would actually seat a new bidder
  // there right now. A[c] = cheapest way to free up one seat at c: use free
  // capacity (0), evict the weakest occupant (their value, strict), or move
  // an occupant to another cell k and recurse (swap cost + A[k]). Computed
  // with one SPFA over the reverse exchange graph. buyIn = floor + A, plus
  // $1 when the cheapest route ends in an eviction (which needs strict gain).
  function computeBuyIn() {
    const revN = Array.from({ length: nC }, () => []);
    for (let c = 0; c < nC; c++) for (const k of neighbors[c]) revN[k].push(c);
    const A = new Float64Array(nC).fill(Infinity);
    const evEnd = new Uint8Array(nC);
    const q = [];
    const inq = new Uint8Array(nC);
    let qh = 0;
    for (let c = 0; c < nC; c++) {
      let a = Infinity;
      let ev = 0;
      if (assigned[c].length < cap[c]) a = 0;
      const t = topValid(evictHeaps[c], c);
      if (t && t[0] < a) {
        a = t[0];
        ev = 1;
      }
      if (a < Infinity) {
        A[c] = a;
        evEnd[c] = ev;
        q.push(c);
        inq[c] = 1;
      }
    }
    while (qh < q.length) {
      const k = q[qh++];
      inq[k] = 0;
      for (const c of revN[k]) {
        const pm = topValid(pairHeaps.get(c * nC + k), c);
        if (!pm) continue;
        const cand = pm[0] + A[k];
        const betterCost = cand < A[c] - 1e-9;
        const sameCostFreer = !betterCost && cand < A[c] + 1e-9 && evEnd[c] === 1 && evEnd[k] === 0;
        if (betterCost || sameCostFreer) {
          A[c] = Math.min(A[c], cand);
          evEnd[c] = evEnd[k];
          if (!inq[c]) {
            inq[c] = 1;
            q.push(c);
          }
        }
      }
    }
    // Contested cells (any displacement cost, or an eviction even at zero
    // cost) need a strictly winning bid: +$1 guarantees a seat in every
    // optimum. Cells with genuine slack right now buy in at the floor.
    const buyIn = new Map();
    for (let c = 0; c < nC; c++) {
      const contested = A[c] > 0 || evEnd[c] === 1;
      buyIn.set(cellKey(c), A[c] === Infinity ? null : Math.round(floors[c] + A[c] + (contested ? 1 : 0)));
    }
    return buyIn;
  }

  // Package results
  const prices = new Map();
  for (let c = 0; c < nC; c++) prices.set(cellKey(c), Math.round(p[c]));
  const assignments = new Map();
  for (let c = 0; c < nC; c++) {
    for (const x of assigned[c]) {
      assignments.set(x.id, {
        show: showings[Math.floor(c / nT)],
        tierId: tiers[c % nT].id,
        price: Math.round(p[c]),
      });
    }
  }
  return { prices, assignments, buyIn: computeBuyIn() };
}
