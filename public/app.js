let venue = null;
let tiers = [];
let state = null;
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
  renderSeatMap();
  renderYou();
  renderResults();
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
  for (const tier of tiers) {
    const price = state.prices[tier.id];
    const hist = state.priceHistory[tier.id] || [price];
    const prev = hist.length > 1 ? hist[hist.length - 2] : price;
    const d = state.demand[tier.id];
    const s = state.supply[tier.id];
    const ratio = Math.min(1, d / s);
    const over = d > s;
    const youHere = state.you && !state.you.withdrawn && state.you.targetTier === tier.id;
    const card = document.createElement('div');
    card.className = `tier-card ${tier.id}`;
    card.innerHTML = `
      <div>${tier.name}</div>
      <div><span class="price">$${price}</span>${deltaHtml(price - prev)}</div>
      <div class="meta">${d} bidding · ${s} seats${over ? ' · OVERSUBSCRIBED' : ''}</div>
      <div class="demand-bar"><div class="${over ? 'over' : ''}" style="width:${ratio * 100}%"></div></div>
      ${sparkline(hist)}
      ${youHere ? '<div class="you-here">● you are pooled here</div>' : ''}`;
    board.appendChild(card);
  }
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
  const sf = $('#join-showings');
  sf.querySelectorAll('.check-row').forEach((n) => n.remove());
  for (const s of state.showings) {
    sf.insertAdjacentHTML(
      'beforeend',
      `<label class="check-row"><input type="checkbox" name="showing" value="${s}" checked> ${s}</label>`
    );
  }
  const tf = $('#join-tiers');
  tf.querySelectorAll('.check-row').forEach((n) => n.remove());
  for (const t of tiers) {
    tf.insertAdjacentHTML(
      'beforeend',
      `<label class="check-row">
        <input type="checkbox" name="tier" value="${t.id}" ${t.id !== 't4' ? 'checked' : ''}>
        <span class="tier-dot" style="background:var(--${t.id})"></span>
        <span style="flex:1">${t.name}</span>
        max $<input type="number" name="max-${t.id}" min="1" value="${suggestedMax(t.id)}">
      </label>`
    );
  }
}

const suggestedMax = (tierId) => ({ t1: 80, t2: 55, t3: 35, t4: 20 })[tierId] ?? 30;

async function join() {
  $('#join-error').textContent = '';
  const showings = [...document.querySelectorAll('input[name="showing"]:checked')].map((i) => i.value);
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
    $('#update-btn').hidden = true;
    $('#withdraw-btn').hidden = true;
    return;
  }
  if (state.phase === 'settled') {
    $('#you-tiers').hidden = true;
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

  // maxes editor (don't rebuild while user is typing in it)
  const tf = $('#you-tiers');
  tf.hidden = false;
  $('#update-btn').hidden = false;
  $('#withdraw-btn').hidden = false;
  if (tf.dataset.built !== you.id) {
    tf.dataset.built = you.id;
    tf.querySelectorAll('.check-row').forEach((n) => n.remove());
    for (const t of tiers) {
      const tm = you.tierMaxes.find((x) => x.tierId === t.id);
      tf.insertAdjacentHTML(
        'beforeend',
        `<label class="check-row">
          <input type="checkbox" name="ytier" value="${t.id}" ${tm ? 'checked' : ''}>
          <span class="tier-dot" style="background:var(--${t.id})"></span>
          <span style="flex:1">${t.name}</span>
          max $<input type="number" name="ymax-${t.id}" min="1" value="${tm ? tm.maxPrice : suggestedMax(t.id)}">
        </label>`
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
    ${segmentTable(r.bySegment)}`;
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
  $('#update-btn').addEventListener('click', updateMaxes);
  $('#withdraw-btn').addEventListener('click', async () => {
    await api('/api/withdraw', { bidderId });
    await refresh();
  });
  document.querySelectorAll('[data-admin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.admin;
      await api(`/api/admin/${action}`, action === 'bots' ? { count: 300 } : {});
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
