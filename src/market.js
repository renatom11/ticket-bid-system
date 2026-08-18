// Exact market clearing for a capacitated unit-demand assignment market
// (Shapley-Shubik with item multiplicities).
//
// Input: bidders with acceptance sets (shows x tiers) and stated ceilings per
// tier. Output: a maximum-surplus assignment plus the buyer-optimal (minimal)
// clearing price for every (show, tier) cell, satisfying:
//   - no cell is filled over capacity,
//   - every assigned bidder is in a best cell for them at these prices
//     (utility >= 0 and >= utility at every other cell they accept),
//   - every unassigned bidder has utility <= 0 at every cell they accept,
//   - cells with unsold seats price at their floor,
//   - no price can be lowered without breaking one of the above.
//
// Algorithm: incremental successive-shortest-path assignment over the cell
// graph (each insertion finds the maximum-gain augmenting chain of
// seat-swaps via SPFA — safe with the negative edge weights this graph has,
// and terminating because an optimal assignment admits no negative cycle),
// with a virtual "stay out" column so evictions and non-participation are
// ordinary path exits. The minimal price vector is then extracted with a
// difference-constraint closure over the optimal assignment.

export function solveMarket({ showings, tiers, capacityPerShowing, bidders }) {
  const nT = tiers.length;
  const nS = showings.length;
  const nC = nS * nT; // cell index = showIdx * nT + tierIdx
  const OUT = nC; // virtual "stay out" column, dual fixed at 0
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

  // --- one row insertion: max-gain augmenting chain via SPFA ---
  // Costs minimize -gain. Entry into cell c costs -value; moving occupant x
  // from c to k costs (val_x@c - val_x@k); evicting x costs +val_x@c. The
  // best exit is a cell with free capacity (cost +0) or OUT. Edges can be
  // negative but the graph has no negative cycle while the current
  // assignment is optimal, so SPFA terminates.
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
      if (assigned[c].length < cap[c]) continue; // free capacity: an exit, no need to push through
      const d = dist[c];
      const occ = assigned[c];
      for (let oi = 0; oi < occ.length; oi++) {
        const x = occ[oi];
        const base = d + x.aval;
        for (let i = 0; i < x.accCells.length; i++) {
          const k = x.accCells[i];
          if (k === c) continue;
          const nd = base - x.accVals[i];
          if (nd < dist[k] - 1e-9) {
            dist[k] = nd;
            parFrom[k] = c;
            parBidder[k] = x;
            if (!inQueue[k]) {
              inQueue[k] = 1;
              queue.push(k);
            }
          }
        }
        // ...or evict x entirely
        if (base < dist[OUT] - 1e-9) {
          dist[OUT] = base;
          parFrom[OUT] = c;
          parBidder[OUT] = x;
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
      // strictly better via eviction (never augment zero-gain evictions)
      best = dist[OUT];
      exit = OUT;
    }
    if (exit === -1) return;
    // Augment on strict gain, or zero gain that fills a free seat.
    if (best > 1e-9) return;
    if (exit === OUT && best > -1e-9) return;

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
      }
      cur = from;
    }
    const accI = parBidder[cur];
    r.cell = cur;
    r.aval = r.accVals[accI];
    assigned[cur].push(r);
  }

  // Insert strongest bidders first: exchange chains stay short, and among
  // equal bids the earlier joiner wins the marginal seat (recs arrive in
  // join order and the sort is stable).
  const order = recs
    .map((r, i) => [r.accVals.length ? Math.max(...r.accVals) : -1, i])
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) insert(recs[i]);

  // --- buyer-optimal (minimal) prices ---
  // Lower bounds: floors, and no unassigned bidder may strictly afford a cell.
  const p = new Float64Array(nC);
  for (let c = 0; c < nC; c++) p[c] = floors[c];
  for (const r of recs) {
    if (r.cell !== -1) continue;
    for (let i = 0; i < r.accCells.length; i++) {
      const c = r.accCells[i];
      const m = r.accVals[i] + floors[c];
      if (m > p[c]) p[c] = m;
    }
  }
  // Closure over assigned-bidder stability: x at c must weakly prefer c,
  // so p[k] >= p[c] + (m_x[k] - m_x[c]) for every k that x accepts.
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

  // Package results
  const prices = new Map(); // "show|tierId" -> price
  const cellOf = (c) => `${showings[Math.floor(c / nT)]}|${tiers[c % nT].id}`;
  for (let c = 0; c < nC; c++) prices.set(cellOf(c), Math.round(p[c]));
  const assignments = new Map(); // bidderId -> {show, tierId, price}
  for (let c = 0; c < nC; c++) {
    for (const x of assigned[c]) {
      assignments.set(x.id, {
        show: showings[Math.floor(c / nT)],
        tierId: tiers[c % nT].id,
        price: Math.round(p[c]),
      });
    }
  }
  return { prices, assignments };
}
