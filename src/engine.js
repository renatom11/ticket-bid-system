// Drop engine built on exact market clearing.
//
// One drop = N simultaneous shows of the venue, each split into seat tiers.
// Every (show, tier) cell is its own market. On every tick the engine
// re-solves the whole book — everyone's live acceptance sets and stated
// ceilings — for the exact buyer-optimal clearing prices and provisional
// assignment (src/market.js). There is no heuristic price walk: the numbers
// published each tick are the precise prices at which demand fits supply for
// the book as it stands. Ticks matter because people (and the demo bots)
// react between them; when the book stops changing, the drop settles and the
// last solve is final: winners are charged their cell's price and get seats.

import { TIERS, TIER_ORDER, VENUE, seatsForTier } from './venue.js';
import { solveMarket } from './market.js';

const STABLE_ROUNDS_TO_SETTLE = 2;

export class Drop {
  constructor({ name = 'Prototype Drop', showings, maxRounds = 60 } = {}) {
    this.name = name;
    this.showings = [...(showings ?? ['Showing 1', 'Showing 2', 'Showing 3', 'Showing 4', 'Showing 5'])];
    this.maxRounds = maxRounds;
    this.phase = 'lobby'; // lobby -> bidding -> settled
    this.round = 0;
    this.stableRounds = 0;
    this.bidders = new Map();
    this.nextBidderId = 1;
    this.bookVersion = 0;
    this.lastSolvedVersion = -1;
    this.results = null;

    this.floors = Object.fromEntries(TIERS.map((t) => [t.id, t.floorPrice]));
    this.cellPrices = new Map(); // "show|tier" -> exact price (last solve)
    this.cellBuyIn = new Map(); // "show|tier" -> minimum bid that seats you now
    this.assignments = new Map(); // bidderId -> {show, tierId, price}
    this.prices = { ...this.floors }; // per-tier MIN cell price (headline number)
    this.priceMax = { ...this.floors }; // per-tier max cell price
    this.priceHistory = Object.fromEntries(TIER_ORDER.map((t) => [t, [this.floors[t]]]));
    this.seated = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
    this.supply = Object.fromEntries(
      TIER_ORDER.map((t) => [t, VENUE.capacityPerShowing[t] * this.showings.length])
    );
  }

  touch() {
    this.bookVersion += 1;
  }

  addBidder({ name, showings, tierMaxes, segment }) {
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    const accepted = (showings ?? []).filter((s) => this.showings.includes(s));
    if (accepted.length === 0) throw new UserError('Pick at least one showing');
    const cleaned = (tierMaxes ?? [])
      .filter((tm) => TIER_ORDER.includes(tm.tierId) && Number(tm.maxPrice) >= 0)
      .map((tm) => ({ tierId: tm.tierId, maxPrice: Math.floor(Number(tm.maxPrice)) }));
    if (cleaned.length === 0) throw new UserError('Pick at least one tier with a max price');
    const id = `b${this.nextBidderId++}`;
    const bidder = {
      id,
      name: name?.trim() || `Bidder ${id}`,
      showings: accepted,
      tierMaxes: cleaned,
      joinedAt: this.bidders.size,
      segment: segment ?? null,
      withdrawn: false,
      pending: false, // in the drop but hasn't placed a bid yet
      assignment: null, // final: {tierId, showing, seat, pricePaid}
    };
    this.bidders.set(id, bidder);
    this.touch();
    return bidder;
  }

  updateBidder(id, { tierMaxes, showings }) {
    const bidder = this.mustGet(id);
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    if (tierMaxes !== undefined) {
      const cleaned = (tierMaxes ?? [])
        .filter((tm) => TIER_ORDER.includes(tm.tierId) && Number(tm.maxPrice) >= 0)
        .map((tm) => ({ tierId: tm.tierId, maxPrice: Math.floor(Number(tm.maxPrice)) }));
      if (cleaned.length === 0) throw new UserError('Keep at least one tier, or withdraw instead');
      bidder.tierMaxes = cleaned;
    }
    if (showings !== undefined) {
      const accepted = (showings ?? []).filter((s) => this.showings.includes(s));
      if (accepted.length === 0) throw new UserError('Keep at least one showing');
      bidder.showings = accepted;
    }
    this.touch();
    return bidder;
  }

  withdraw(id) {
    const bidder = this.mustGet(id);
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    bidder.withdrawn = true;
    this.touch();
    return bidder;
  }

  mustGet(id) {
    const bidder = this.bidders.get(id);
    if (!bidder) throw new UserError('Unknown bidder');
    return bidder;
  }

  // Add more simultaneous shows mid-drop, growing every tier's supply.
  // Bidders who accepted every show stay fully flexible; hand-picked
  // subsets are kept as-is.
  addShowings(count) {
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    const prevAll = this.showings.length;
    const added = [];
    for (let i = 0; i < count; i++) {
      const name = `Showing ${this.showings.length + 1}`;
      this.showings.push(name);
      added.push(name);
    }
    for (const b of this.bidders.values()) {
      if (b.showings.length === prevAll) b.showings.push(...added);
    }
    for (const t of TIER_ORDER) this.supply[t] += VENUE.capacityPerShowing[t] * count;
    this.touch();
    return added;
  }

  openBidding() {
    if (this.phase !== 'lobby') return;
    this.phase = 'bidding';
  }

  // The solver's input for the current book — also used by the browser build
  // to ship the book to a Web Worker. Last tick's prices ride along as a
  // screening hint (the solver verifies against the real result, so this
  // never changes the answer, only the speed).
  bookInput() {
    return {
      showings: this.showings,
      tiers: TIERS,
      capacityPerShowing: VENUE.capacityPerShowing,
      hint: this.cellPrices.size ? [...this.cellPrices] : undefined,
      bidders: [...this.bidders.values()]
        .filter((b) => !b.withdrawn && !b.pending)
        .map((b) => ({ id: b.id, showings: b.showings, tierMaxes: b.tierMaxes })),
    };
  }

  // Exact clearing of the current book, synchronously.
  solve() {
    this.applySolveResult(solveMarket(this.bookInput()));
  }

  applySolveResult({ prices, assignments, buyIn }) {
    this.cellPrices = prices;
    this.cellBuyIn = buyIn ?? new Map();
    this.assignments = assignments;
    for (const t of TIER_ORDER) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of this.showings) {
        const p = prices.get(`${s}|${t}`);
        if (p < min) min = p;
        if (p > max) max = p;
      }
      this.prices[t] = min;
      this.priceMax[t] = max;
      this.seated[t] = 0;
    }
    for (const a of assignments.values()) this.seated[a.tierId] += 1;
  }

  // Provisional standing of one bidder in the last solve.
  currentOf(bidder) {
    return this.assignments.get(bidder.id) ?? null;
  }

  targetTier(bidder) {
    return this.assignments.get(bidder.id)?.tierId ?? null;
  }

  // One tick: re-solve the book, publish, settle once the book has been
  // still for two consecutive ticks (or maxRounds is hit).
  tick() {
    if (this.phase === 'lobby') this.openBidding();
    if (this.phase !== 'bidding') return this.summary();
    const snapshotVersion = this.bookVersion;
    this.solve();
    return this.finishTick(snapshotVersion);
  }

  // Async variant for the browser: the caller snapshots bookInput() and its
  // version, solves elsewhere (a Web Worker), then applies the result here.
  // Edits made while the solve was in flight keep the book "changed" so the
  // next tick picks them up.
  tickWith(result, snapshotVersion) {
    if (this.phase === 'lobby') this.openBidding();
    if (this.phase !== 'bidding') return this.summary();
    this.applySolveResult(result);
    return this.finishTick(snapshotVersion);
  }

  finishTick(snapshotVersion) {
    this.round += 1;
    const unchanged = snapshotVersion === this.lastSolvedVersion;
    this.lastSolvedVersion = snapshotVersion;
    for (const t of TIER_ORDER) this.priceHistory[t].push(this.prices[t]);
    this.stableRounds = unchanged ? this.stableRounds + 1 : 0;
    if (this.stableRounds >= STABLE_ROUNDS_TO_SETTLE || this.round >= this.maxRounds) {
      this.settle();
    }
    return this.summary();
  }

  // Finalize: the last solve is the outcome. Winners are charged their
  // cell's exact price and receive concrete seats (best seats first within
  // each cell, earlier joiners first).
  settle() {
    if (this.phase === 'settled') return this.results;
    if (this.assignments.size === 0 && this.bidders.size > 0) this.solve();

    const seatPools = new Map(); // "show|tier" -> ordered seats
    const winnersByCell = new Map();
    for (const [id, a] of this.assignments) {
      const b = this.bidders.get(id);
      const key = `${a.show}|${a.tierId}`;
      if (!winnersByCell.has(key)) winnersByCell.set(key, []);
      winnersByCell.get(key).push(b);
    }
    for (const [key, winners] of winnersByCell) {
      const [show, tierId] = key.split('|');
      if (!seatPools.has(tierId)) seatPools.set(tierId, seatsForTier(tierId));
      const seats = seatPools.get(tierId).slice();
      winners.sort((a, b) => a.joinedAt - b.joinedAt);
      for (const w of winners) {
        const a = this.assignments.get(w.id);
        w.assignment = {
          tierId,
          showing: show,
          seat: seats.shift(),
          pricePaid: a.price,
        };
      }
    }

    this.phase = 'settled';
    this.results = this.buildResults();
    return this.results;
  }

  buildResults() {
    const winners = [...this.bidders.values()].filter((b) => b.assignment);
    const byTier = Object.fromEntries(
      TIER_ORDER.map((t) => [
        t,
        {
          priceMin: this.prices[t],
          priceMax: this.priceMax[t],
          sold: winners.filter((b) => b.assignment.tierId === t).length,
          supply: this.supply[t],
        },
      ])
    );
    const active = [...this.bidders.values()].filter((b) => !b.withdrawn);
    let bySegment = null;
    if (active.some((b) => b.segment)) {
      bySegment = {};
      for (const b of active) {
        const key = b.segment ?? 'unlabeled';
        const row = (bySegment[key] ??= { bidders: 0, winners: 0, totalPaid: 0 });
        row.bidders += 1;
        if (b.assignment) {
          row.winners += 1;
          row.totalPaid += b.assignment.pricePaid;
        }
      }
    }
    return {
      rounds: this.round,
      winners: winners.length,
      participants: active.length,
      revenue: winners.reduce((sum, b) => sum + b.assignment.pricePaid, 0),
      byTier,
      bySegment,
    };
  }

  // Everyone in the drop, whether or not they have a live bid.
  get participantCount() {
    return this.bidders.size;
  }

  // Live competition for one bidder's scope: for each tier, how many people
  // could take one of the seats this bidder is going for (they accept one of
  // the same shows in that tier and can afford it at today's price), against
  // how many such seats exist. Exact for the scope; a contender may also be
  // competing elsewhere, which is why the market — not this number — sets the
  // price.
  competitionFor(bidder) {
    const myShows = new Set(bidder && !bidder.withdrawn ? bidder.showings : this.showings);
    const out = {};
    for (const t of TIER_ORDER) {
      out[t] = { contenders: 0, seats: myShows.size * VENUE.capacityPerShowing[t] };
    }
    for (const b of this.bidders.values()) {
      if (b.withdrawn || b.pending) continue;
      for (const tm of b.tierMaxes) {
        const row = out[tm.tierId];
        if (!row) continue;
        for (const s of b.showings) {
          if (!myShows.has(s)) continue;
          const p = this.cellPrices.get(`${s}|${tm.tierId}`);
          if (p !== undefined && tm.maxPrice >= p) {
            row.contenders += 1;
            break;
          }
        }
      }
    }
    return out;
  }

  // Money the drop would collect if it settled right now.
  committedTotal() {
    let total = 0;
    for (const a of this.assignments.values()) total += a.price;
    return { total, bidders: this.assignments.size };
  }

  summary() {
    return {
      phase: this.phase,
      round: this.round,
      prices: { ...this.prices },
      priceMax: { ...this.priceMax },
      demand: { ...this.seated },
      supply: { ...this.supply },
      results: this.results,
    };
  }
}

export class UserError extends Error {}
