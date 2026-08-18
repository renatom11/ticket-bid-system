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
2. **Exact clearing, every tick.** There is no heuristic price walk. Each tick, the platform
   re-solves the entire book — everyone's live acceptance sets and stated ceilings — as a
   capacitated assignment market (Shapley–Shubik) and publishes the **buyer-optimal
   market-clearing price for every (show, tier) cell** (`src/market.js`, exhaustively tested
   against a brute-force oracle). Properties, by construction:
   - a hot show prices itself up until its demand exactly fits its seats — the "90 people
     insisting on Show 7's 76 seats" failure case cannot happen;
   - flexibility is precisely rewarded: your price is the cheapest cell you accept, so flexible
     bidders are steered to slack shows at the floor while single-hot-show bidders pay that
     show's true premium;
   - the marginal loser sets the price (second-price flavor): you never pay your own max, and
     **truthful bidding is provably your best strategy**;
   - nobody who can afford any cell they accept is ever left unseated.
   You can raise your maxes, add shows, or drop out between any two ticks.
3. **Settlement.** Ticks matter because people react between them. When the book stops changing
   for two ticks (or `maxRounds` hits), the last solve is final: winners are charged their cell's
   exact price — never more than their stated max — and get concrete seats (best seats first,
   earlier joiners first). Nobody who dropped out or was outbid pays anything.

## The venue

`src/venue.js` models an AMC Lincoln Square-style auditorium (rows A–M, no I, cross-aisle after H).
The zones are our own, based on geometry rather than AMC's recommended-seat colors:

| Tier | Zone | Seats/showing | Floor |
|---|---|---|---|
| T1 Center of Center | middle 6 seats of H and J (the core, guaranteed) | 12 | $40 |
| T2 Prime Center | rest of the center blocks of G–K | 76 | $30 |
| T3 Great | sides of G–K, centers of L, M | 98 | $25 |
| T4 Okay | centers of E, F; far sides of L, M | 96 | $20 |
| T5 Front | rows A–D, edges of E, F | 154 | $15 |

One drop = 5 simultaneous showings of that room, so e.g. Tier 1 has just 60 seats total (and the
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

Bots bid *behaviorally*: they anchor low near the floor (the way real buyers do) and raise
toward their private true budget while they're losing — or give up. Prices published each tick
are exact for the stated book, and the drop settles when the crowd stops moving. Settlement
reports a per-segment equity breakdown (who got seated, at what average price).

## What a run looks like

`npm run sim` (2500 bidders, deterministic seed): prices open at the floors, climb tick by tick
as losing bots raise their stated ceilings, and freeze when the crowd stops moving:

```
Round | t1 $ (seated)   | t2 $ (seated)   | t3 $ (seated)   | t4 $ (seated)   | t5 $ (seated) | moved
start | $40  (34/60)    | $30 (380/380)   | $25 (490/490)   | $20 (480/480)   | $15 (652/770) |   -
    5 | $73  (60/60)    | $32 (380/380)   | $27 (490/490)   | $21 (480/480)   | $15 (669/770) | 176
   15 | $170 (60/60)    | $34 (380/380)   | $28 (490/490)   | $22 (480/480)   | $15 (669/770) |  11
   30 | $184 (60/60)    | $34 (380/380)   | $28 (490/490)   | $22 (480/480)   | $15 (669/770) |   0

Settled: Center of Center $184 (60/60) · Prime Center $34 · Front stays at the $15 floor
Guarantee check: PASS — no unseated bidder can afford any cell they accept.
```

The 60-seat Center of Center is bid up 5x by dueling superfans while uncontested tiers stay
near their floors — and the final line is the point: at exact clearing prices, being left out
*means* the market price exceeded your ceiling, never bad luck.

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
src/venue.js       seat map, zone definitions, capacities
src/market.js      exact clearing: capacitated assignment market solver
                   (successive shortest paths + minimal-price extraction)
src/engine.js      drop lifecycle: book, ticks (= re-solve + publish), settlement
src/bots.js        behavioral demo crowd (anchor low, raise while losing)
src/server.js      zero-dep HTTP server + JSON API
public/            web UI (vanilla JS, polls /api/state)
web-demo/          single-file demo, BUILT from src/ (node web-demo/build.mjs)
sim/simulate.js    CLI convergence demo
test/              solver tests (vs brute-force oracle) + engine tests
```

## Known simplifications / stretch goals

- **Scale.** The exact solve runs in-browser: ~0.3s per tick at 2,500 bidders and 5 shows,
  a few seconds at 10,000+. Ticks self-pace around the solve. A production backend would run
  the same algorithm in a compiled solver and handle hundreds of thousands live.
- **Closing dynamics.** Final prices come from the final book, so a real drop wants an activity
  rule (raises any time; lowering locks earlier) or a soft close to blunt last-second swings.
- **Rationing ties.** At the exact clearing price, tied marginal bidders are split by join order;
  a lottery among the tied would be the fairer production rule.
- **Different dates/times per showing** with separate demand curves — the per-cell market
  already supports it; it's a labeling change.
- Payments, auth, holds on cards at commit time, anti-bot/identity checks, seat *choice* within
  your tier (currently auto-assigned best-first), persistence (state is in-memory), and real-time
  push (currently 1s polling).
