// Uniform-price clearing auction engine for a ticket drop.
//
// One drop = N simultaneous showings of the same venue, each split into seat
// tiers. Every tier has a price clock that starts at its floor. Each round:
//   1. Every bidder is pooled into the best tier (by their own preference
//      order) whose current price is within their max for that tier. Bidders
//      priced out of a tier cascade into the pool of the next tier they accept.
//   2. Tiers with more demand than seats raise their price; tiers with spare
//      seats let the price fall back toward the floor (so a spike that scares
//      people off settles back down — the $110 -> $80 case).
//   3. When no price moves and every tier has demand <= supply, the drop
//      settles: everyone still pooled is guaranteed a seat and pays the same
//      final price for their tier, and concrete seats are assigned.

import { TIERS, TIER_ORDER, VENUE, seatsForTier } from './venue.js';

const PRICE_K = 0.6; // base aggressiveness of price moves
const MAX_EXCESS_RATIO = 4; // cap on (demand-supply)/supply used for a single jump
const STABLE_ROUNDS_TO_SETTLE = 2;

export class Drop {
  constructor({ name = 'Prototype Drop', showings, maxRounds = 25 } = {}) {
    this.name = name;
    this.showings = showings ?? ['Showing 1', 'Showing 2', 'Showing 3', 'Showing 4', 'Showing 5'];
    this.maxRounds = maxRounds;
    this.phase = 'lobby'; // lobby -> bidding -> settled
    this.round = 0;
    this.stableRounds = 0;
    this.bidders = new Map();
    this.nextBidderId = 1;
    this.prices = Object.fromEntries(TIERS.map((t) => [t.id, t.floorPrice]));
    this.floors = Object.fromEntries(TIERS.map((t) => [t.id, t.floorPrice]));
    this.priceHistory = Object.fromEntries(TIER_ORDER.map((t) => [t, [this.prices[t]]]));
    this.lastDemand = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
    this.supply = Object.fromEntries(
      TIER_ORDER.map((t) => [t, VENUE.capacityPerShowing[t] * this.showings.length])
    );
    this.results = null;
  }

  // tierMaxes: ordered array of {tierId, maxPrice} — order is the bidder's
  // preference; they cascade down the list as prices climb past their maxes.
  addBidder({ name, showings, tierMaxes, segment }) {
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    const accepted = (showings ?? []).filter((s) => this.showings.includes(s));
    if (accepted.length === 0) throw new UserError('Pick at least one showing');
    const cleaned = (tierMaxes ?? [])
      .filter((tm) => TIER_ORDER.includes(tm.tierId) && Number(tm.maxPrice) > 0)
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
      assignment: null, // {tierId, showing, seat: {row, seat}, pricePaid} once settled
    };
    this.bidders.set(id, bidder);
    return bidder;
  }

  updateBidder(id, { tierMaxes, showings }) {
    const bidder = this.mustGet(id);
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    if (tierMaxes !== undefined) {
      const cleaned = (tierMaxes ?? [])
        .filter((tm) => TIER_ORDER.includes(tm.tierId) && Number(tm.maxPrice) > 0)
        .map((tm) => ({ tierId: tm.tierId, maxPrice: Math.floor(Number(tm.maxPrice)) }));
      if (cleaned.length === 0) throw new UserError('Keep at least one tier, or withdraw instead');
      bidder.tierMaxes = cleaned;
    }
    if (showings !== undefined) {
      const accepted = (showings ?? []).filter((s) => this.showings.includes(s));
      if (accepted.length === 0) throw new UserError('Keep at least one showing');
      bidder.showings = accepted;
    }
    return bidder;
  }

  // Add more simultaneous shows mid-drop, growing every tier's supply.
  // Bidders who accepted every show stay fully flexible and pick up the new
  // ones; bidders with a hand-picked subset keep their subset.
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
    return added;
  }

  // Money the platform would collect if the drop settled right now: every
  // pooled bidder pays their target tier's current price.
  committedTotal() {
    let total = 0;
    let bidders = 0;
    for (const b of this.bidders.values()) {
      const t = this.targetTier(b);
      if (t) {
        total += this.prices[t];
        bidders += 1;
      }
    }
    return { total, bidders };
  }

  withdraw(id) {
    const bidder = this.mustGet(id);
    if (this.phase === 'settled') throw new UserError('Drop already settled');
    bidder.withdrawn = true;
    return bidder;
  }

  mustGet(id) {
    const bidder = this.bidders.get(id);
    if (!bidder) throw new UserError('Unknown bidder');
    return bidder;
  }

  openBidding() {
    if (this.phase !== 'lobby') return;
    this.phase = 'bidding';
    this.lastDemand = this.computeDemand();
  }

  // The tier pool this bidder currently sits in: first tier in their
  // preference list whose clock price is <= their max for that tier.
  targetTier(bidder, prices = this.prices) {
    if (bidder.withdrawn) return null;
    for (const { tierId, maxPrice } of bidder.tierMaxes) {
      if (prices[tierId] <= maxPrice) return tierId;
    }
    return null; // priced out of everything they accept (they re-enter if prices fall)
  }

  computeDemand(prices = this.prices) {
    const demand = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
    for (const bidder of this.bidders.values()) {
      const t = this.targetTier(bidder, prices);
      if (t) demand[t] += 1;
    }
    return demand;
  }

  // One price tick. Returns a summary of what happened.
  tick() {
    if (this.phase === 'lobby') this.openBidding();
    if (this.phase !== 'bidding') return this.summary();

    this.round += 1;
    const demand = this.computeDemand();
    const k = PRICE_K / (1 + this.round / 5); // damp moves over time so the clock converges
    let anyMove = false;

    for (const t of TIER_ORDER) {
      const D = demand[t];
      const S = this.supply[t];
      const P = this.prices[t];
      const F = this.floors[t];
      let next = P;
      if (D > S) {
        const excess = Math.min((D - S) / S, MAX_EXCESS_RATIO);
        next = Math.max(P + 1, Math.ceil(P * (1 + k * excess)));
      } else if (D < S && P > F) {
        next = Math.max(F, Math.round(P - k * (P - F) * ((S - D) / S)));
      }
      if (next !== P) anyMove = true;
      this.prices[t] = next;
      this.priceHistory[t].push(next);
    }

    this.lastDemand = demand;
    const cleared = TIER_ORDER.every((t) => demand[t] <= this.supply[t]);
    this.stableRounds = !anyMove && cleared ? this.stableRounds + 1 : 0;

    if (this.stableRounds >= STABLE_ROUNDS_TO_SETTLE || this.round >= this.maxRounds) {
      this.settle();
    }
    return this.summary();
  }

  // Assign concrete seats and charge everyone their tier's final price.
  // Normally runs after the clock has cleared (demand <= supply everywhere);
  // if we hit maxRounds with excess demand, earlier joiners win ties and the
  // overflow cascades to the next tier they accept.
  settle() {
    const seatPools = new Map(); // tierId -> showing -> array of seats (best first)
    for (const t of TIER_ORDER) {
      const perShowing = new Map();
      for (const s of this.showings) perShowing.set(s, seatsForTier(t).slice());
      seatPools.set(t, perShowing);
    }

    const pools = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
    for (const bidder of this.bidders.values()) {
      const t = this.targetTier(bidder);
      if (t) pools[t].push(bidder);
    }

    const takeSeat = (bidder, tierId) => {
      const perShowing = seatPools.get(tierId);
      // Prefer the acceptable showing with the most seats left, so load balances.
      let best = null;
      for (const s of bidder.showings) {
        const seats = perShowing.get(s);
        if (seats.length > 0 && (!best || seats.length > perShowing.get(best).length)) best = s;
      }
      if (!best) return false;
      const seat = perShowing.get(best).shift();
      bidder.assignment = { tierId, showing: best, seat, pricePaid: this.prices[tierId] };
      return true;
    };

    for (const t of TIER_ORDER) {
      // Bidders with fewer acceptable showings are harder to place — seat them
      // first; join order breaks ties (and rations a forced settle fairly).
      const queue = pools[t].sort(
        (a, b) => a.showings.length - b.showings.length || a.joinedAt - b.joinedAt
      );
      for (const bidder of queue) {
        if (takeSeat(bidder, t)) continue;
        // Tier full (forced settle or unlucky showing split): cascade down
        // their remaining preference list.
        const rest = bidder.tierMaxes.slice(bidder.tierMaxes.findIndex((tm) => tm.tierId === t) + 1);
        let placed = false;
        for (const { tierId, maxPrice } of rest) {
          if (this.prices[tierId] <= maxPrice && takeSeat(bidder, tierId)) {
            placed = true;
            break;
          }
        }
        if (!placed) bidder.assignment = null; // missed out — not charged
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
          finalPrice: this.prices[t],
          sold: winners.filter((b) => b.assignment.tierId === t).length,
          supply: this.supply[t],
        },
      ])
    );
    const active = [...this.bidders.values()].filter((b) => !b.withdrawn);
    // Equity view: who got in, per socioeconomic segment (when bidders carry one).
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

  summary() {
    return {
      phase: this.phase,
      round: this.round,
      prices: { ...this.prices },
      demand: { ...this.lastDemand },
      supply: { ...this.supply },
      results: this.results,
    };
  }
}

export class UserError extends Error {}
