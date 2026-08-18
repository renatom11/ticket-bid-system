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
| T1 Center of Center | middle 12 seats of H and J (the core, guaranteed) | 24 | $40 |
| T2 Prime Center | rest of the center blocks of G–K | 64 | $30 |
| T3 Great | sides of G–K, centers of L, M | 98 | $25 |
| T4 Okay | centers of E, F; far sides of L, M | 96 | $20 |
| T5 Front | rows A–D, edges of E, F | 154 | $15 |

One drop = 5 simultaneous showings of that room, so e.g. Tier 1 has 120 seats total (and the
Shows control can add more rooms mid-drop).

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
Round | t1 price (demand)   | t2 price          | t3 price          | t4 price          | t5 price
start | $  40 (173/120)     | $ 30 (547/320)    | $ 25 (640/490)    | $ 20 (543/480)    | $ 15 (316/770)
    3 | $  69 (172/120)     | $ 58 (428/320)    | $ 36 (600/490)    | $ 24 (512/480)    | $ 15 (339/770)
    6 | $  98 (162/120)     | $ 67 (345/320)    | $ 43 (542/490)    | $ 26 (474/480)    | $ 15 (399/770)
final | $ 160 (120/120)     | $ 72 (320/320)    | $ 48 (482/490)    | $ 29 (460/480)    | $ 15 (436/770)

Settled: Center of Center sells out at $160, Prime Center at $72 · 1818/2500 seated

Who got in, by segment:
Superfans / high income       179/188  seated ( 95%) · avg paid $126
Comfortable professionals     402/444  seated ( 91%) · avg paid $61
Middle income                 685/1018 seated ( 67%) · avg paid $40
Budget-conscious              433/593  seated ( 73%) · avg paid $20
Students / lowest budget      119/257  seated ( 46%) · avg paid $15
```

Prices climb, priced-out bidders cascade into lower tiers, and the system finds equilibrium. The
tiny Center of Center tier (120 seats against superfan demand) settles at more than double Prime
Center — real scarcity pricing — while the uniform-price property still holds: superfans willing
to pay $300–700 pay the same $160 clearing price as the marginal winner.

## Demoing the web UI

Open http://localhost:3000, expand **Demo controls**:

1. **Add 100 / 1,000 / 10,000 bots** to create a crowd (bots are drawn from the socioeconomic
   segments above).
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
