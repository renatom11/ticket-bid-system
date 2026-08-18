# Ticket Bid System

Prototype of a fairer way to run high-demand ticket drops (movie premieres, concerts): instead of
"whoever hammers the crashing website fastest wins," the drop is a **uniform-price clearing
auction**. Everyone states what they'd pay, the price discovers itself in public rounds, and
everyone who stays in is **guaranteed a seat** and pays the **same settled price** for their tier —
even if the price spiked higher mid-auction.

Zero dependencies — plain Node 18+.

```bash
npm start          # web UI at http://localhost:3000
npm run sim        # CLI: 2500-bot drop, prints round-by-round convergence
npm test           # engine unit tests
```

## How a drop works

1. **Lobby (the "first 10 minutes").** The drop opens at an announced time. Everyone joins and sets
   their filters: which of the 5 showings they'd attend, which seat tiers they'd take, and the max
   they'd pay for each tier. No speed advantage — joining 1 second or 9 minutes in is identical.
2. **Bidding rounds (price ticks).** Every tier has a price clock starting at its floor
   (~$15–30). Each round, the platform counts how many people are pooled in each tier:
   - **Demand > seats** → price rises, proportionally to how oversubscribed it is.
   - **Demand < seats** → price falls back toward the floor. This is the "$110 → $80" case: a
     spike scares people off, so the next tick is cheaper for everyone who held on.
   - Get priced out of a tier and you **cascade automatically** into the next tier you accepted
     (e.g. Tier 1 passes your $90 max → you join the Tier 2 pool). If prices fall back within your
     max, you re-enter the better pool.
   - You can raise your maxes or drop out between any two ticks.
3. **Settlement.** When prices stop moving and every tier fits its seats, the drop settles.
   Everyone still pooled is charged their tier's final price — the same for all winners in that
   tier, never more than the max they stated — and gets a concrete seat assigned (best seats first,
   load-balanced across the showings they accepted). Nobody who dropped out or got priced out is
   charged anything.

If the clock hasn't converged after `maxRounds`, it force-settles: earlier joiners win ties in
oversubscribed tiers and the overflow cascades down.

## The venue

`src/venue.js` models an AMC Lincoln Square-style auditorium (rows A–M, no I, cross-aisle after H).
The zones are our own, based on geometry rather than AMC's recommended-seat colors:

| Tier | Zone | Seats/showing | Floor |
|---|---|---|---|
| T1 Prime Center | center blocks of G, H, J, K | 88 | $30 |
| T2 Great | sides of G–K, centers of L, M | 98 | $25 |
| T3 Okay | centers of E, F; far sides of L, M | 96 | $20 |
| T4 Front | rows A–D, edges of E, F | 154 | $15 |

One drop = 5 simultaneous showings of that room, so e.g. Tier 1 has 440 seats total.

## The simulated crowd

Demo bidders are drawn from five socioeconomic segments (`src/bots.js`), each with a lognormal
budget distribution — real long tails, so a superfan can be worth $500+ for prime seats while a
student caps out near $20:

| Segment | Share | Median budget (top tier) | Behavior |
|---|---|---|---|
| Superfans / high income | 7% | $260 | want Prime Center, won't sit up front |
| Comfortable professionals | 18% | $110 | Tier 1–2, some flexibility |
| Middle income | 40% | $55 | spread across Tiers 1–3 |
| Budget-conscious | 25% | $28 | Tiers 2–4, any seat beats none |
| Students / lowest budget | 10% | $16 | Tiers 3–4 |

Settlement reports a per-segment equity breakdown (who got seated, at what average price).

## What a run looks like

`npm run sim` (2500 bidders, deterministic seed):

```
Round | t1 price (demand/supply) | t2 price          | t3 price          | t4 price
start | $  30 ( 756/440)         | $ 25 ( 648/490)   | $ 20 ( 494/480)   | $ 15 (316/770)
    3 | $  60 ( 604/440)         | $ 38 ( 612/490)   | $ 22 ( 512/480)   | $ 15 (316/770)
    7 | $  73 ( 471/440)         | $ 47 ( 535/490)   | $ 26 ( 493/480)   | $ 15 (373/770)
   15 | $  78 ( 434/440)         | $ 50 ( 478/490)   | $ 28 ( 467/480)   | $ 15 (419/770)

Settled in 15 rounds · 1798/2500 bidders seated · revenue $77,113

Who got in, by segment:
Superfans / high income       187/188  seated ( 99%) · avg paid $75
Comfortable professionals     418/444  seated ( 94%) · avg paid $63
Middle income                 638/1018 seated ( 63%) · avg paid $41
Budget-conscious              435/593  seated ( 73%) · avg paid $20
Students / lowest budget      120/257  seated ( 47%) · avg paid $15
```

Prices climb, priced-out bidders cascade into lower tiers, and the system finds equilibrium. Note
the uniform-price property at work: superfans willing to pay $300–700 for Tier 1 still pay the
$78 clearing price, because the *marginal* winner sets the price, not the richest one. Scarcity is
what moves the number — `node sim/simulate.js 6000` settles Tier 1 at $164.

## Demoing the web UI

Open http://localhost:3000, expand **Demo controls**:

1. **Add 300 bots** a few times to create a crowd (bots have randomized tastes/budgets).
2. Join the drop yourself with your own filters.
3. **Open drop** (45s lobby) or **Skip lobby** to start ticks immediately (one every 12s —
   configurable via `LOBBY_SECONDS` / `ROUND_SECONDS` env vars; **Force next price tick** fast-forwards).
4. Watch the tier cards: prices move each tick, your card shows which pool you're in, and at
   settlement your exact seat lights up on the map.

## Layout

```
src/venue.js    seat map, zone definitions, capacities
src/engine.js   the auction: pools, price clocks, cascade, settlement
src/bots.js     randomized demo crowd
src/server.js   zero-dep HTTP server + JSON API
public/         web UI (vanilla JS, polls /api/state)
sim/simulate.js CLI convergence demo
test/           engine unit tests (node --test)
```

## Known simplifications / stretch goals

- **Per-showing granularity.** The price clock treats a tier's 5 showings as one pool. A bidder
  who only accepts one showing can, rarely, find that specific showing full even though the tier
  cleared in aggregate (constrained bidders are seated first to minimize this). Real version:
  per-(showing, tier) clocks or a matching-aware clearing step.
- **Different dates/times per showing** with separate demand curves — the original full design;
  the engine's "acceptable showings" set is already the hook for it.
- Payments, auth, holds on cards at commit time, anti-bot/identity checks, seat *choice* within
  your tier (currently auto-assigned best-first), persistence (state is in-memory), and real-time
  push (currently 1s polling).
