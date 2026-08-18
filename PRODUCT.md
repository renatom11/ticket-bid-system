# Drop Clock — Product Description

*A fair-launch ticketing platform that replaces the checkout stampede with a public clearing
auction. Everyone who commits is guaranteed a seat, and everyone in the same seat tier pays the
same settled price.*

## The problem

High-demand ticket on-sales are broken in the same way everywhere — AMC for a hyped premiere,
Ticketmaster for a tour:

- The site crashes or rate-limits you at the moment of sale, so access is decided by luck,
  connection speed, and bot ownership — not by who actually wants to go.
- Fixed prices under massive demand guarantee a lottery: the tickets sell out in seconds and
  reappear on StubHub at 5x, with the margin going to scalpers instead of the venue or artist.
- Buyers get no honest way to say what they actually want ("any of these three nights, good seats
  preferred, but I'd take okay seats before I'd pay $200").

## The core idea

Turn the drop from a race into a **uniform-price clearing auction**:

1. **Announced drop, no speed advantage.** The drop opens at a published time with a join window
   (e.g. 10 minutes). Joining first gains nothing — the window exists so everyone gets on.
2. **Preferences, not clicks-per-second.** Each buyer states their filters once: which
   dates/showtimes they'd attend, which seat tiers they'd accept, and the most they'd pay for each
   tier. That's the whole interaction — no refreshing, no seat-grab race.
3. **Public price discovery.** Every seat tier has a price clock starting at a low floor. On a
   fixed cadence (a "tick", e.g. every 5 minutes), the platform counts how many buyers are pooled
   in each tier at the current price:
   - More buyers than seats → the price rises in proportion to how oversubscribed it is.
   - Fewer buyers than seats → the price falls back toward the floor. A spike that scares people
     off corrects itself: if $110 sheds half the crowd, the next tick might read $80.
   - Priced out of your preferred tier → you automatically cascade into the pool of the next tier
     you accepted, and you re-enter the better pool if its price falls back within your max.
4. **Settlement.** When prices stop moving and every tier's demand fits its seats, the drop
   settles. Everyone still pooled:
   - is **guaranteed a seat** matching their filters,
   - pays their tier's **final settled price — the same as everyone else in that tier**, never
     more than the max they stated, and never the mid-auction peak,
   - gets a concrete seat assigned (best seats first, balanced across the showtimes they accepted).

   Anyone who dropped out or was priced out pays nothing.

## Why this design wins

- **Fair by construction.** No advantage for bots, fast fingers, or refresh scripts — the only
  input that matters is what you'd genuinely pay. The join window removes the time race entirely.
- **Kills the scalper margin.** The settled price *is* the market price, so the resale spread —
  the money scalpers currently capture — goes to the venue/artist instead. Tickets can be
  name-bound because there's no reason to buy more than you'll use.
- **Honest for buyers.** You never overpay relative to the market (uniform price = you pay what
  the marginal buyer pays, not your own max — so there's no penalty for bidding your true value,
  and no winner's curse). Cheap tiers stay cheap when demand is soft: floors, not surge minimums.
- **Transparent.** Every tick is public. You watch the price form instead of discovering "Sold
  out" after 40 minutes in a queue.
- **Load-friendly.** Demand is expressed as stored preferences evaluated in batch ticks, not as
  millions of simultaneous checkout attempts — the architecture that keeps crashing is simply gone.

## The venue model

A venue is divided into seat tiers by desirability. The prototype models an AMC Lincoln
Square-style auditorium (rows A–M, cross-aisle after H) with four custom zones:

| Tier | Zone | Character |
|---|---|---|
| Tier 1 · Center of Center | middle 6 seats of rows H–J | the best of the best, guaranteed the core |
| Tier 2 · Prime Center | rest of the center of G–K | the seats everyone fights for |
| Tier 3 · Great | sides of G–K, center of L–M | great rows, off-center |
| Tier 4 · Okay | centers of E–F, edges of L–M | closer or farther, still fine |
| Tier 5 · Front | rows A–D, edges of E–F | neck-craning territory, priced accordingly |

One drop covers many showtimes at once (the prototype: five simultaneous showings), and a buyer's
"acceptable showings" set is the hook for the full vision — different dates, different times, each
with its own demand.

## User journey (buyer)

1. Drop announced for Friday 12:00. You open the app at 12:03 — doesn't matter.
2. You check Showings 1–3, tick Tier 1 (max $90) and Tier 2 (max $60), and go back to work.
3. Prices tick publicly. Tier 1 spikes to $109 — you're moved to the Tier 2 pool. Two ticks
   later Tier 1 sags to $85 — you're automatically back in.
4. It settles at Tier 1 = $88. You're charged $88 — same as every Tier 1 winner — and get seat
   H14 in Showing 2. If you'd been priced out of both tiers, you'd have paid nothing.

## Current prototype (this repo)

- Full auction engine with price clocks, tier cascade, re-entry, convergence, forced-settle
  rationing, and seat assignment — pure JS, unit-tested.
- Web UI: live tier boards with price history, the seat map with our zones, join/raise-max/drop-out
  flow, and a demo crowd drawn from five socioeconomic segments — students on a ~$16 budget up to
  superfans whose lognormal budget tail passes $500 for prime seats.
- CLI simulation: 2,500 bidders reproducibly converging to equilibrium, with a per-segment equity
  report (who got seated, at what average price). A key property shows up here: the wealthy don't
  set the settled price — the marginal winner does — so a $400-budget superfan pays the same
  clearing price as everyone else in the tier.
- A single-file browser version of the whole thing, publishable as a static page.

## Roadmap / stretch goals

- Per-(showtime, tier) price clocks so single-showing buyers are never squeezed by aggregate
  clearing (today: rare edge, constrained buyers are seated first).
- Real drops across different dates and times with custom filter combinations — the original full
  design.
- Payments: card hold at commit, capture at settlement; identity checks and per-person ticket
  limits; transfer rules that keep resale at face value.
- Seat *choice* within your tier at settlement (currently auto-assigned best-first).
- Persistence, accounts, real-time push, and multi-drop operations for venue partners.
