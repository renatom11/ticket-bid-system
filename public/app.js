let venue = null;
let tiers = [];
let showClasses = {};
let state = null;
let pendingTier = null;
const FLAT_PRICE = 30;
// Your typed max for every tier, kept even while a tier is switched off, so
// toggling a tier never destroys a number you entered.
let myMaxes = {};
let selectedShow = null; // settlement seat explorer
let bidderId = sessionStorage.getItem('bidderId');

const $ = (sel) => document.querySelector(sel);
const tierById = (id) => tiers.find((t) => t.id === id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function boot() {
  const v = await api('/api/venue');
  venue = v.venue;
  tiers = v.tiers;
  showClasses = v.classes ?? {};
  renderLegend();
  await refresh();
  buildJoinForm();
  setInterval(refresh, 1000);
  wireButtons();
  wireSeatExplorer();
}

async function refresh() {
  try {
    state = await api(`/api/state${bidderId ? `?bidderId=${bidderId}` : ''}`);
  } catch {
    return; // server restarting; keep polling
  }
  if (bidderId && !state.you) {
    // server was reset — our bidder is gone
    bidderId = null;
    sessionStorage.removeItem('bidderId');
    buildJoinForm();
  }
  renderHeader();
  renderTierBoard();
  renderPendingBar();
  renderSeatMap();
  renderYou();
  renderResults();
  $('#bot-count').textContent = state.bidderCount.toLocaleString();
  $('#show-count').textContent = state.showings.length;
}

/* ---------- header ---------- */

function renderHeader() {
  $('#drop-name').textContent = state.name;
  const pill = $('#phase-pill');
  pill.textContent = state.phase === 'lobby' && !state.dropOpen ? 'not open yet' : state.phase;
  pill.className = `pill ${state.phase}`;
  const cd = $('#countdown');
  if (state.phase === 'lobby' && state.lobbyEndsAt) {
    cd.textContent = `Bidding starts in ${secs(state.lobbyEndsAt)}s — get your filters in`;
  } else if (state.phase === 'bidding' && state.nextTickAt) {
    cd.textContent = `Round ${state.round} · next price tick in ${secs(state.nextTickAt)}s`;
  } else if (state.phase === 'settled') {
    cd.textContent = `Settled after ${state.round} rounds`;
  } else {
    cd.textContent = 'Use demo controls to open the drop';
  }
}

const secs = (t) => Math.max(0, Math.ceil((t - Date.now()) / 1000));

/* ---------- tier board ---------- */

function renderTierBoard() {
  const board = $('#tier-board');
  // Persistent card nodes: rebuilding them every poll used to eat clicks.
  const sig = tiers.map((t) => t.id).join(',');
  if (board.dataset.sig !== sig) {
    board.dataset.sig = sig;
    board.innerHTML = tiers.map((t) => `<div class="tier-card ${t.id}" data-tier="${t.id}"></div>`).join('');
  }
  const you = state.you;
  const editable = you && !you.withdrawn && state.phase !== 'settled';
  const comp = state.phase === 'bidding' ? state.competition : null;
  const scoped = you && !you.withdrawn && you.showings.length < state.showings.length;
  const targetId = editable ? you.targetTier : you && you.assignment ? you.assignment.tierId : null;
  const targetIdx = targetId ? tiers.findIndex((t) => t.id === targetId) : -1;
  for (const tier of tiers) {
    const price = state.prices[tier.id];
    const pMax = state.priceMax?.[tier.id] ?? price;
    const hist = state.priceHistory[tier.id] || [price];
    const prev = hist.length > 1 ? hist[hist.length - 2] : price;
    const d = state.demand[tier.id];
    const s = state.supply[tier.id];
    const ratio = Math.min(1, d / s);
    const isCurrent = tier.id === targetId;
    const clickable = editable && !isCurrent;
    let footer = '';
    if (isCurrent) {
      footer = `<div class="you-here">✓ ${state.phase === 'settled' ? 'your tier' : 'seated — guaranteed at settlement'}</div>`;
    } else if (clickable) {
      const b = tierBuyInOf(tier.id, you);
      if (b !== null) {
        const idx = tiers.findIndex((t) => t.id === tier.id);
        const verb = targetIdx === -1 ? 'Buy in' : idx < targetIdx ? 'Buy up' : 'Buy down';
        footer = `<div class="switch-hint">${verb} — $${b} guarantees a seat now</div>`;
      }
    }
    const card = board.children[tiers.indexOf(tier)];
    card.className = `tier-card ${tier.id}${isCurrent ? ' current' : ''}${clickable ? ' clickable' : ''}${tier.id === pendingTier ? ' pending' : ''}`;
    card.innerHTML = `
      <div>${tier.name}</div>
      <div><span class="price">$${price}</span>${pMax > price ? `<span class="delta up">hot shows to $${pMax}</span>` : deltaHtml(price - prev)}</div>
      ${
        comp
          ? `<div class="meta" title="People who accept one of your shows in this tier and can afford it at today's price, against the seats in those shows. They may also be competing elsewhere — the market, not this ratio, sets the price.">${comp[tier.id].contenders.toLocaleString()} in the running · ${comp[tier.id].seats.toLocaleString()} seats${scoped ? ' in your shows' : ''}</div>
      <div class="demand-bar"><div class="${comp[tier.id].contenders > comp[tier.id].seats ? 'over' : ''}" style="width:${Math.min(1, comp[tier.id].contenders / Math.max(1, comp[tier.id].seats)) * 100}%"></div></div>`
          : `<div class="meta">${d} ${state.phase === 'settled' ? 'sold' : 'seated'} · ${s} seats</div>
      <div class="demand-bar"><div style="width:${ratio * 100}%"></div></div>`
      }
      ${sparkline(hist)}
      ${footer}`;
  }
}

// One rule, every time: clicking a tier makes it your target — you offer its
// buy-in price, you stop offering anything BETTER, and cheaper tiers stay on
// as fallbacks. Switched-off tiers keep their numbers, so undo is one click.
async function switchToTier(tierId) {
  const you = state?.you;
  if (!you || you.withdrawn || state.phase === 'settled') return;
  myMaxes[tierId] = tierBuyInOf(tierId, you) ?? state.prices[tierId];
  const idx = tiers.findIndex((t) => t.id === tierId);
  const fallbacks = you.tierMaxes.filter((tm) => tiers.findIndex((t) => t.id === tm.tierId) > idx);
  const tierMaxes = [{ tierId, maxPrice: myMaxes[tierId] }, ...fallbacks];
  try {
    await api('/api/update', { bidderId, tierMaxes });
    pendingTier = null;
    $('#you-tiers').dataset.built = '';
    await refresh();
  } catch (e) {
    $('#you-error').textContent = e.message;
  }
}

const shortName = (tierId) => tierById(tierId).name.split(' ·')[0];

// Minimum bid that seats this user in the tier right now (cheapest across
// the shows they accept).
function tierBuyInOf(tierId, you) {
  const shows = you && !you.withdrawn ? you.showings : state.showings;
  let best = null;
  for (const s of shows) {
    const b = state.buyIn?.[`${s}|${tierId}`];
    if (b !== null && b !== undefined && (best === null || b < best)) best = b;
  }
  return best;
}

function renderPendingBar() {
  const bar = $('#pending-bar');
  const you = state.you;
  const editable = you && !you.withdrawn && state.phase !== 'settled';
  if (!editable) pendingTier = null;
  if (pendingTier && you && you.targetTier === pendingTier) pendingTier = null;
  if (!pendingTier) { bar.hidden = true; return; }
  const idx = tiers.findIndex((t) => t.id === pendingTier);
  const released = you.tierMaxes.filter((tm) => tiers.findIndex((t) => t.id === tm.tierId) < idx).map((tm) => shortName(tm.tierId));
  const kept = you.tierMaxes.filter((tm) => tiers.findIndex((t) => t.id === tm.tierId) > idx).map((tm) => shortName(tm.tierId));
  const bIn = tierBuyInOf(pendingTier, you);
  $('#pending-text').innerHTML =
    `<b>Target ${tierById(pendingTier).name}</b> — offer <b>$${bIn ?? state.prices[pendingTier]}</b> (seats you now)` +
    (released.length ? ` · switch off ${released.join(', ')}` : '') +
    (kept.length ? ` · keep ${kept.join(', ')} as fallback` : '') +
    `. Switched-off tiers keep their numbers — click one to come back.`;
  bar.hidden = false;
}

function flatStatHtml(revenue, tickets) {
  const flat = tickets * FLAT_PRICE;
  const diff = revenue - flat;
  return `<p class="flat-stat">Same ${tickets.toLocaleString()} tickets at a flat $${FLAT_PRICE} each would have made <b>$${flat.toLocaleString()}</b> — the auction made <b class="${diff >= 0 ? 'lift-up' : 'lift-down'}">${diff >= 0 ? '+$' : '−$'}${Math.abs(diff).toLocaleString()}</b> vs flat pricing.</p>`;
}

function deltaHtml(d) {
  if (!d) return '';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} $${Math.abs(d)}</span>`;
}

function sparkline(hist) {
  const w = 180, h = 34, pad = 2;
  const min = Math.min(...hist), max = Math.max(...hist);
  const span = Math.max(1, max - min);
  const pts = hist
    .map((p, i) => {
      const x = pad + (i / Math.max(1, hist.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((p - min) / span) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

/* ---------- seat map ---------- */

function renderSeatMap() {
  const el = $('#seat-map');
  const r = state.phase === 'settled' ? state.results : null;
  const mine = state.you?.assignment;
  if (r && (!selectedShow || !state.showings.includes(selectedShow))) {
    selectedShow = mine ? mine.showing : state.showings[0];
  }
  const show = r ? selectedShow : null;
  const sold = r ? new Set(r.soldSeats[show] || []) : null;
  const chips = $('#seat-shows');
  chips.hidden = !r;
  if (r) {
    chips.innerHTML = state.showings
      .map((sh) => {
        const c = state.showClasses?.[sh] ?? 3;
        return `<button type="button" class="chip${sh === show ? ' on' : ''}" data-show="${sh}" data-class="${c}" title="${sh} · ${showClasses[c]?.label ?? ''}">${sh.replace(/^Showing /, '')}</button>`;
      })
      .join('');
  }
  el.innerHTML = '<div class="screen">SCREEN</div>';
  for (const row of venue.rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.innerHTML = `<span class="rl">${row.label}</span>`;
    row.seats.forEach((tierId, i) => {
      const s = document.createElement('span');
      s.className = `seat ${tierId}`;
      const id = `${row.label}${i + 1}`;
      s.dataset.seat = id;
      s.dataset.tier = tierId;
      if (r) {
        const cell = r.byShow[show][tierId];
        const isSold = sold.has(id);
        if (!isSold) s.classList.add('unsold');
        s.dataset.price = cell.price;
        s.dataset.sold = isSold ? '1' : '0';
      }
      if (mine && mine.seat && (!r || mine.showing === show) && mine.seat.row === row.label && mine.seat.seat === i + 1) {
        s.classList.add('mine');
      }
      rowEl.appendChild(s);
    });
    rowEl.innerHTML += `<span class="rl">${row.label}</span>`;
    el.appendChild(rowEl);
    if (row.label === 'H') {
      const gap = document.createElement('div');
      gap.className = 'aisle-gap';
      el.appendChild(gap);
    }
  }
}

function wireSeatExplorer() {
  $('#seat-map').addEventListener('mouseover', (e) => {
    const seat = e.target.closest('.seat');
    if (!seat) return;
    const t = tierById(seat.dataset.tier);
    const price = seat.dataset.price;
    $('#seat-detail').innerHTML =
      `<b>${seat.dataset.seat}</b> · ${t.name}` +
      (price !== undefined ? ` · <b>$${price}</b> · ${seat.dataset.sold === '1' ? 'sold' : 'unsold'}` : ` · floor $${t.floorPrice}`) +
      (seat.classList.contains('mine') ? ' · YOUR SEAT' : '');
  });
  $('#seat-shows').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectedShow = chip.dataset.show;
    renderSeatMap();
    renderResults();
  });
}

function renderLegend() {
  $('#map-legend').innerHTML = tiers
    .map(
      (t) =>
        `<span><span class="chip" style="background:var(--${t.id})"></span>${t.name} · floor $${t.floorPrice}</span>`
    )
    .join('');
}

/* ---------- join form ---------- */

function buildJoinForm() {
  if (!state) return;
  $('#join-panel').hidden = false;
  $('#you-panel').hidden = true;
  const tf = $('#join-tiers');
  tf.querySelectorAll('.tier-row').forEach((n) => n.remove());
  for (const t of tiers) {
    tf.insertAdjacentHTML(
      'beforeend',
      `<div class="tier-row">
        <label class="trow-name">
          <input type="checkbox" name="tier" value="${t.id}" ${t.id !== 't5' ? 'checked' : ''}>
          <span class="tier-dot" style="background:var(--${t.id})"></span>${t.name}
        </label>
        <span class="trow-max">max $ <input type="number" name="max-${t.id}" min="0" value="${suggestedMax(t.id)}"></span>
      </div>`
    );
  }
}

const suggestedMax = (tierId) => ({ t1: 120, t2: 80, t3: 55, t4: 35, t5: 20 })[tierId] ?? 30;

async function join() {
  $('#join-error').textContent = '';
  const showings = [...state.showings];
  const tierMaxes = tiers
    .filter((t) => document.querySelector(`input[name="tier"][value="${t.id}"]`)?.checked)
    .map((t) => ({ tierId: t.id, maxPrice: Number(document.querySelector(`input[name="max-${t.id}"]`).value) }));
  try {
    const res = await api('/api/join', { name: $('#join-name').value, showings, tierMaxes });
    bidderId = res.bidderId;
    sessionStorage.setItem('bidderId', bidderId);
    await refresh();
  } catch (e) {
    $('#join-error').textContent = e.message;
  }
}

/* ---------- your bid ---------- */

function renderYou() {
  const you = state.you;
  if (!you) return;
  $('#join-panel').hidden = true;
  $('#you-panel').hidden = false;
  const st = $('#you-status');

  if (you.withdrawn) {
    st.innerHTML = `<div class="you-status-card">You dropped out. You won't be charged.</div>`;
    $('#you-tiers').hidden = true;
    $('#you-showings').hidden = true;
    $('#update-btn').hidden = true;
    $('#withdraw-btn').hidden = true;
    return;
  }
  if (state.phase === 'settled') {
    $('#you-tiers').hidden = true;
    $('#you-showings').hidden = true;
    $('#update-btn').hidden = true;
    $('#withdraw-btn').hidden = true;
    if (you.assignment) {
      const t = tierById(you.assignment.tierId);
      st.innerHTML = `<div class="you-status-card">🎟️ <span class="big">You're in!</span><br>
        ${you.assignment.showing} · ${t.name}<br>
        Seat <b>${you.assignment.seat.row}${you.assignment.seat.seat}</b> — charged <b>$${you.assignment.pricePaid}</b> (the exact clearing price for this show's tier)</div>`;
    } else {
      st.innerHTML = `<div class="you-status-card">😔 You were priced out of every tier you accepted. You were not charged.</div>`;
    }
    return;
  }

  if (state.phase === 'lobby') {
    st.innerHTML = `<div class="you-status-card">You're in the book. Exact prices are computed from everyone's bids once bidding starts.</div>`;
  } else {
    const cur = you.current;
    let outbidHint = '';
    if (!cur && state.cells) {
      // cheapest way in across everything they accept
      let best = null;
      for (const tm of you.tierMaxes) {
        for (const s of you.showings) {
          const p = state.cells[`${s}|${tm.tierId}`];
          if (p !== undefined && (!best || p < best.p)) best = { p, s, t: tm.tierId };
        }
      }
      if (best) outbidHint = ` Cheapest way in: ${tierById(best.t).name} · ${best.s} at <b>$${best.p}</b>.`;
    }
    st.innerHTML = `<div class="you-status-card">
      ${
        cur
          ? `🎟️ <span class="big">Seated</span> — <b>${cur.show} · ${tierById(cur.tierId).name}</b> at exactly <b>$${cur.price}</b>.<br>If equilibrium is reached, this seat is <b>guaranteed yours</b> at this price. You only lose it if the market moves past your max — raise it to hold on.`
          : `You're <span class="big">standing aside</span> — at today's exact prices you're not buying, and that's a valid position: "at these prices, I'm good."${outbidHint} Click a tier card to buy in.`
      }</div>`;
  }

  // showings editor: one toggle chip per show
  const sf = $('#you-showings');
  sf.hidden = false;
  sf.querySelectorAll('.chip-row').forEach((n) => n.remove());
  const cls = (s) => state.showClasses?.[s] ?? 3;
  const label = (s) => showClasses[cls(s)]?.label ?? '';
  sf.insertAdjacentHTML(
    'beforeend',
    `<div class="chip-row">${state.showings
      .map(
        (s) =>
          `<button type="button" class="chip${you.showings.includes(s) ? ' on' : ''}" data-show="${s}" data-class="${cls(s)}" title="${s} · ${label(s)}">${s.replace('Showing ', '')}</button>`
      )
      .join('')}</div>
     <div class="class-key">Dot = how wanted the showtime is · least … most. Your max is what you'd pay at the most wanted slot; weaker slots count for proportionally less, so you are never charged above it.</div>`
  );
  $('#showing-count').textContent = `you're bidding on ${you.showings.length} of ${state.showings.length}`;
  syncTierRowStates();

  // maxes editor (don't rebuild while user is typing in it)
  const tf = $('#you-tiers');
  tf.hidden = false;
  $('#update-btn').hidden = false;
  $('#withdraw-btn').hidden = false;
  if (tf.dataset.built !== you.id) {
    tf.dataset.built = you.id;
    tf.querySelectorAll('.tier-row').forEach((n) => n.remove());
    for (const t of tiers) {
      const tm = you.tierMaxes.find((x) => x.tierId === t.id);
      if (tm) myMaxes[t.id] = tm.maxPrice;
      if (myMaxes[t.id] === undefined) myMaxes[t.id] = suggestedMax(t.id);
      const steps = (list) =>
        `<span class="steppers">${list
          .map((v) => `<button type="button" class="step" data-step="${v}" data-tier="${t.id}">${v}</button>`)
          .join('')}</span>`;
      tf.insertAdjacentHTML(
        'beforeend',
        `<div class="tier-row${tm ? '' : ' off'}">
          <label class="trow-name">
            <input type="checkbox" name="ytier" value="${t.id}" ${tm ? 'checked' : ''}>
            <span class="tier-dot" style="background:var(--${t.id})"></span>${t.name}
          </label>
          ${steps(['-100', '-10', '-1'])}
          <span class="trow-max">$ <input type="number" name="ymax-${t.id}" min="0" value="${myMaxes[t.id]}"></span>
          ${steps(['+1', '+10', '+100'])}
        </div>`
      );
    }
  }
}

function syncTierRowStates() {
  for (const row of document.querySelectorAll('#you-tiers .tier-row')) {
    const box = row.querySelector('input[name="ytier"]');
    row.classList.toggle('off', box && !box.checked);
  }
}

async function updateMaxes() {
  $('#you-error').textContent = '';
  for (const t of tiers) {
    const input = document.querySelector(`input[name="ymax-${t.id}"]`);
    if (input) myMaxes[t.id] = Math.max(0, Number(input.value || 0));
  }
  const tierMaxes = tiers
    .filter((t) => document.querySelector(`input[name="ytier"][value="${t.id}"]`)?.checked)
    .map((t) => ({ tierId: t.id, maxPrice: Number(document.querySelector(`input[name="ymax-${t.id}"]`).value) }));
  try {
    await api('/api/update', { bidderId, tierMaxes });
    await refresh();
  } catch (e) {
    $('#you-error').textContent = e.message;
  }
}

/* ---------- results ---------- */

function renderResults() {
  const panel = $('#results-panel');
  if (state.phase !== 'settled' || !state.results) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const r = state.results;
  const rows = tiers
    .map((t) => {
      const sp = r.tierSpread[t.id];
      const row = r.byTier[t.id];
      return `<tr><td>${t.name}</td><td>$${sp.min}</td><td>$${sp.avg}</td><td>$${sp.max}</td><td>${row.sold} / ${row.supply}</td></tr>`;
    })
    .join('');
  const showTable = selectedShow && r.byShow[selectedShow]
    ? `<h2 style="margin-top:1.1rem">${selectedShow} <span class="muted">— ${(showClasses[state.showClasses?.[selectedShow] ?? 3]?.label ?? '').toLowerCase()} showtime</span></h2>
       <table class="results"><tr><th>Tier</th><th>Price</th><th>Sold</th><th>Take</th></tr>${tiers
         .map((t) => {
           const c = r.byShow[selectedShow][t.id];
           return `<tr><td>${t.name}</td><td>$${c.price}</td><td>${c.sold} / ${c.seats}</td><td>$${(c.sold * c.price).toLocaleString()}</td></tr>`;
         })
         .join('')}</table>`
    : '';
  $('#results').innerHTML = `
    <p>${r.winners} of ${r.participants} bidders got seats in ${r.rounds} rounds · total revenue $${r.revenue.toLocaleString()}</p>
    <table class="results">
      <tr><th>Tier</th><th>Low</th><th>Avg paid</th><th>High</th><th>Seats sold</th></tr>${rows}
    </table>
    <p class="muted">Every seat in the same show and tier settled at the same price; the spread above is across shows. Pick a show on the seat map to price its seats one by one.</p>
    ${showTable}
    ${segmentTable(r.bySegment)}
    ${flatStatHtml(r.revenue, r.winners)}`;
}

const SEGMENT_NAMES = {
  superfan: 'Superfans / high income',
  comfortable: 'Comfortable professionals',
  middle: 'Middle income',
  budget: 'Budget-conscious',
  student: 'Students / lowest budget',
};

function segmentTable(bySegment) {
  if (!bySegment) return '';
  const rows = Object.keys(SEGMENT_NAMES)
    .filter((id) => bySegment[id])
    .map((id) => {
      const s = bySegment[id];
      const pct = Math.round((s.winners / s.bidders) * 100);
      const avg = s.winners ? Math.round(s.totalPaid / s.winners) : 0;
      return `<tr><td>${SEGMENT_NAMES[id]}</td><td>${s.winners} / ${s.bidders} (${pct}%)</td><td>$${avg}</td></tr>`;
    })
    .join('');
  if (!rows) return '';
  return `<h2 style="margin-top:1rem">Who got in, by segment</h2>
    <table class="results">
      <tr><th>Segment</th><th>Seated</th><th>Avg paid</th></tr>${rows}
    </table>`;
}

/* ---------- wiring ---------- */

function wireButtons() {
  $('#join-btn').addEventListener('click', join);
  $('#tier-board').addEventListener('click', (e) => {
    const card = e.target.closest('.tier-card.clickable');
    if (card) {
      pendingTier = card.dataset.tier;
      renderTierBoard();
      renderPendingBar();
    }
  });
  $('#confirm-switch').addEventListener('click', () => { if (pendingTier) switchToTier(pendingTier); });
  $('#cancel-switch').addEventListener('click', () => {
    pendingTier = null;
    renderTierBoard();
    renderPendingBar();
  });
  $('#you-showings').addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const you = state?.you;
    if (!you || you.withdrawn || state.phase === 'settled') return;
    const s = chip.dataset.show;
    const sel = you.showings.includes(s)
      ? you.showings.filter((x) => x !== s)
      : state.showings.filter((x) => you.showings.includes(x) || x === s);
    if (sel.length === 0) {
      $('#you-error').textContent = 'Keep at least one show';
      return;
    }
    $('#you-error').textContent = '';
    try {
      await api('/api/update', { bidderId, showings: sel });
      await refresh();
    } catch (err) {
      $('#you-error').textContent = err.message;
    }
  });
  $('#you-tiers').addEventListener('change', (e) => {
    if (e.target.name !== 'ytier') return;
    syncTierRowStates();
    updateMaxes();
  });
  $('#you-tiers').addEventListener('click', (e) => {
    const btn = e.target.closest('button.step');
    if (!btn) return;
    e.preventDefault();
    const you = state?.you;
    if (!you || you.withdrawn || state.phase === 'settled') return;
    const tierId = btn.dataset.tier;
    const input = document.querySelector(`input[name="ymax-${tierId}"]`);
    input.value = Math.max(0, Number(input.value || 0) + Number(btn.dataset.step));
    if (Number(btn.dataset.step) > 0) {
      document.querySelector(`input[name="ytier"][value="${tierId}"]`).checked = true;
    }
    updateMaxes(); // apply immediately
  });
  $('#update-btn').addEventListener('click', updateMaxes);
  $('#withdraw-btn').addEventListener('click', async () => {
    const you = state?.you;
    if (!you || state.phase === 'settled') return;
    const tierMaxes = you.tierMaxes.map((tm) => ({ ...tm, maxPrice: 0 }));
    await api('/api/update', { bidderId, tierMaxes });
    tierMaxes.forEach((tm) => {
      const input = document.querySelector(`input[name="ymax-${tm.tierId}"]`);
      if (input) input.value = 0;
    });
    await refresh();
  });
  document.querySelectorAll('[data-admin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.admin;
      const needsCount = action === 'bots' || action === 'shows';
      await api(`/api/admin/${action}`, needsCount ? { count: Number(btn.dataset.count) } : {});
      if (action === 'shows') $('#you-showings').dataset.built = '';
      if (action === 'reset') {
        bidderId = null;
        sessionStorage.removeItem('bidderId');
        await refresh();
        buildJoinForm();
      } else {
        await refresh();
      }
    });
  });
}

boot();
