let venue = null;
let tiers = [];
let state = null;
let pendingTier = null;
const FLAT_PRICE = 30;
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
  renderLegend();
  await refresh();
  buildJoinForm();
  setInterval(refresh, 1000);
  wireButtons();
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
  const you = state.you;
  $('#bot-count').textContent = Math.max(0, state.bidderCount - (you && !you.withdrawn ? 1 : 0)).toLocaleString();
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
  board.innerHTML = '';
  const you = state.you;
  const editable = you && !you.withdrawn && state.phase !== 'settled';
  const targetId = editable ? you.targetTier : you && you.assignment ? you.assignment.tierId : null;
  const targetIdx = targetId ? tiers.findIndex((t) => t.id === targetId) : -1;
  for (const tier of tiers) {
    const price = state.prices[tier.id];
    const hist = state.priceHistory[tier.id] || [price];
    const prev = hist.length > 1 ? hist[hist.length - 2] : price;
    const d = state.demand[tier.id];
    const s = state.supply[tier.id];
    const ratio = Math.min(1, d / s);
    const over = d > s;
    const isCurrent = tier.id === targetId;
    const clickable = editable && !isCurrent;
    let footer = '';
    if (isCurrent) {
      footer = `<div class="you-here">✓ ${state.phase === 'settled' ? 'your tier' : "you're getting this tier"}</div>`;
    } else if (clickable) {
      const idx = tiers.findIndex((t) => t.id === tier.id);
      const verb = targetIdx === -1 ? 'jump in' : idx < targetIdx ? 'move up' : 'drop down';
      footer = `<div class="switch-hint">Click to ${verb} — sets your bid to $${price}</div>`;
    }
    const card = document.createElement('div');
    card.className = `tier-card ${tier.id}${isCurrent ? ' current' : ''}${clickable ? ' clickable' : ''}${tier.id === pendingTier ? ' pending' : ''}`;
    card.dataset.tier = tier.id;
    card.innerHTML = `
      <div>${tier.name}</div>
      <div><span class="price">$${price}</span>${deltaHtml(price - prev)}</div>
      <div class="meta">${d} bidding · ${s} seats${over ? ' · OVERSUBSCRIBED' : ''}</div>
      <div class="demand-bar"><div class="${over ? 'over' : ''}" style="width:${ratio * 100}%"></div></div>
      ${sparkline(hist)}
      ${footer}`;
    board.appendChild(card);
  }
}

// Clicking a tier card stages a switch; Confirm applies it: the clicked
// tier's max becomes exactly its clock price, better tiers are released,
// and worse tiers stay as fallbacks.
async function switchToTier(tierId) {
  const you = state?.you;
  if (!you || you.withdrawn || state.phase === 'settled') return;
  const idx = tiers.findIndex((t) => t.id === tierId);
  const fallbacks = you.tierMaxes.filter((tm) => tiers.findIndex((t) => t.id === tm.tierId) > idx);
  const tierMaxes = [{ tierId, maxPrice: state.prices[tierId] }, ...fallbacks];
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
  $('#pending-text').innerHTML =
    `Switch to <b>${tierById(pendingTier).name}</b> at <b>$${state.prices[pendingTier]}</b>?` +
    (released.length ? ` Releases ${released.join(' and ')}.` : '') +
    (kept.length ? ` Keeps ${kept.join(' and ')} as fallback.` : '');
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
  el.innerHTML = '<div class="screen">SCREEN</div>';
  const mine = state.you?.assignment;
  for (const row of venue.rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.innerHTML = `<span class="rl">${row.label}</span>`;
    row.seats.forEach((tierId, i) => {
      const s = document.createElement('span');
      s.className = `seat ${tierId}`;
      if (mine && mine.seat && mine.seat.row === row.label && mine.seat.seat === i + 1) {
        s.classList.add('mine');
        s.title = 'Your seat';
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
        <span class="trow-max">max $ <input type="number" name="max-${t.id}" min="1" value="${suggestedMax(t.id)}"></span>
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
        Seat <b>${you.assignment.seat.row}${you.assignment.seat.seat}</b> — charged <b>$${you.assignment.pricePaid}</b> (same as everyone in your tier)</div>`;
    } else {
      st.innerHTML = `<div class="you-status-card">😔 You were priced out of every tier you accepted. You were not charged.</div>`;
    }
    return;
  }

  const target = you.targetTier ? tierById(you.targetTier) : null;
  st.innerHTML = `<div class="you-status-card">
    ${
      target
        ? `You're pooled in <b>${target.name}</b> at the current price of <b>$${state.prices[target.id]}</b>. If it settles here, that's what you pay — guaranteed seat.`
        : `⚠️ Every tier you accepted is priced above your max. You're out unless prices fall or you raise a max.`
    }</div>`;

  // showings editor: one toggle chip per show
  const sf = $('#you-showings');
  sf.hidden = false;
  sf.querySelectorAll('.chip-row').forEach((n) => n.remove());
  sf.insertAdjacentHTML(
    'beforeend',
    `<div class="chip-row">${state.showings
      .map(
        (s) =>
          `<button type="button" class="chip${you.showings.includes(s) ? ' on' : ''}" data-show="${s}" title="${s}">${s.replace('Showing ', '')}</button>`
      )
      .join('')}</div>`
  );
  $('#showing-count').textContent = `you're bidding on ${you.showings.length} of ${state.showings.length}`;

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
      const steppers = ['-100', '-10', '-1', '+1', '+10', '+100']
        .map((s) => `<button type="button" class="step" data-step="${s}" data-tier="${t.id}">${s}</button>`)
        .join('');
      tf.insertAdjacentHTML(
        'beforeend',
        `<div class="tier-row">
          <label class="trow-name">
            <input type="checkbox" name="ytier" value="${t.id}" ${tm ? 'checked' : ''}>
            <span class="tier-dot" style="background:var(--${t.id})"></span>${t.name}
          </label>
          <span class="trow-max">max $ <input type="number" name="ymax-${t.id}" min="1" value="${tm ? tm.maxPrice : suggestedMax(t.id)}"></span>
          <span class="steppers">${steppers}</span>
        </div>`
      );
    }
  }
}

async function updateMaxes() {
  $('#you-error').textContent = '';
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
      const row = r.byTier[t.id];
      return `<tr><td>${t.name}</td><td>$${row.finalPrice}</td><td>${row.sold} / ${row.supply}</td></tr>`;
    })
    .join('');
  $('#results').innerHTML = `
    <p>${r.winners} of ${r.participants} bidders got seats in ${r.rounds} rounds · total revenue $${r.revenue.toLocaleString()}</p>
    <table class="results">
      <tr><th>Tier</th><th>Settled price</th><th>Seats sold</th></tr>${rows}
    </table>
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
  $('#you-tiers').addEventListener('click', (e) => {
    const btn = e.target.closest('button.step');
    if (!btn) return;
    e.preventDefault();
    const you = state?.you;
    if (!you || you.withdrawn || state.phase === 'settled') return;
    const tierId = btn.dataset.tier;
    const input = document.querySelector(`input[name="ymax-${tierId}"]`);
    input.value = Math.max(1, Number(input.value || 0) + Number(btn.dataset.step));
    if (Number(btn.dataset.step) > 0) {
      document.querySelector(`input[name="ytier"][value="${tierId}"]`).checked = true;
    }
    updateMaxes(); // apply immediately
  });
  $('#update-btn').addEventListener('click', updateMaxes);
  $('#withdraw-btn').addEventListener('click', async () => {
    await api('/api/withdraw', { bidderId });
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
