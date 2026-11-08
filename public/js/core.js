'use strict';
/* Shared helpers: DOM, API calls, toasts, modals, tables, charts. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { currency: '', acct: localStorage.getItem('tga_acct') || '', pages: {}, account: null };

async function api(path, { method = 'GET', body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (S.acct) h['X-Account-Id'] = S.acct;
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error('Cannot reach the server. Is it still running?'); }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (res.status === 401 && data && data.login) { showLogin(); throw new Error('Please sign in'); }
  if (!res.ok) { console.error('[api error]', path, res.status, data); const err = new Error(data && data.tg ? `${data.method || 'Telegram'}: ${data.error}${data.status ? ` (HTTP ${data.status})` : ''}` : ((data && data.error) || `HTTP ${res.status}`)); err.data = data; throw err; }
  return data;
}

function toast(msg, kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const fail = (e) => { toast(e.message || String(e), 'bad', 7000); console.error(e); };

function modal({ title, body, wide = false, buttons = [] }) {
  const root = $('#modalRoot');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog"><div class="row"><h2 class="grow">${esc(title || '')}</h2><button class="btn sm" data-x>✕</button></div><div class="mbody">${body || ''}</div><div class="row end gap mfoot"></div></div>`;
  root.appendChild(bg);
  const close = () => bg.remove();
  $('[data-x]', bg).onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  const foot = $('.mfoot', bg);
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.cls || ''}`; btn.textContent = b.label;
    btn.onclick = async () => { try { const r = await b.onClick({ el: bg, close }); if (b.close !== false && r !== false) close(); } catch (e) { fail(e); } };
    foot.appendChild(btn);
  }
  return { el: bg, close, body: $('.mbody', bg) };
}

function confirmBox(message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title: 'Please confirm', body: `<p style="white-space:pre-wrap">${esc(message)}</p>`, buttons: [
      { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
      { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
    ] });
    $('[data-x]', m.el).addEventListener('click', () => { if (!done) resolve(false); });
    m.el.addEventListener('mousedown', (e) => { if (e.target === m.el && !done) resolve(false); });
  });
}
function promptBox(label, value = '', { type = 'text', hint = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title: label, body: `<input id="pbIn" type="${type}" value="${esc(value)}">${hint ? `<div class="hint gap">${esc(hint)}</div>` : ''}`, buttons: [
      { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
      { label: 'OK', cls: 'primary', onClick: ({ el }) => { done = true; resolve($('#pbIn', el).value); } },
    ] });
    const inp = $('#pbIn', m.el); inp.focus(); inp.select();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(inp.value); m.close(); } });
    $('[data-x]', m.el).addEventListener('click', () => { if (!done) resolve(null); });
  });
}
function drawer(html) {
  const bg = document.createElement('div');
  bg.className = 'drawer-bg';
  bg.innerHTML = `<div class="drawer"><div class="row end"><button class="btn sm" data-x>✕ Close</button></div><div class="dbody">${html}</div></div>`;
  $('#modalRoot').appendChild(bg);
  const close = () => bg.remove();
  $('[data-x]', bg).onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  return { el: bg, body: $('.dbody', bg), close };
}

// ---------- formatting ----------
const nf = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const money = (v, d = 2) => (v === null || v === undefined ? '–' : `${nf(v, d)}`);
const pct = (v) => (v === null || v === undefined ? '–' : `${nf(v, 2)}%`);
const dt = (unix) => (unix ? new Date(unix * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const stBadge = (s) => `<span class="st ${esc(s)}">${esc(String(s || '').replace(/_/g, ' '))}</span>`;
const cur = () => S.currency || '';

function download(filename, text, mime = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}
function toCSV(rows, cols) {
  const q = (v) => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Copied', 'good', 1500); } catch (_) { toast('Copy failed', 'bad'); } }
const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
const readB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Busy-state wrapper for buttons. */
async function busy(btn, fn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { return await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = label; }
}

// ---------- sortable, selectable table ----------
/**
 * cols: [{k, t, num?, html?: row=>safeHtml, val?: row=>sortValue, cls?}]
 * Returns {set(rows), selected(): rows[], el}
 */
function dataTable(host, { cols, rowKey, selectable = false, onRow, onSelect, empty = 'Nothing here yet.', sortKey, sortDir = 'desc', rowClass }) {
  const st = { rows: [], sortKey, dir: sortDir, sel: new Set() };
  host.innerHTML = '<div class="tablewrap"><table><thead></thead><tbody></tbody></table></div>';
  const thead = $('thead', host); const tbody = $('tbody', host);
  const cell = (c, r) => (c.html ? c.html(r) : esc(c.num ? nf(r[c.k], c.d ?? 0) : r[c.k]));
  function sorted() {
    const rows = st.rows.slice();
    const col = cols.find((c) => c.k === st.sortKey);
    if (!col) return rows;
    const val = (r) => { const v = col.val ? col.val(r) : r[col.k]; return v === null || v === undefined ? (st.dir === 'asc' ? Infinity : -Infinity) : v; };
    rows.sort((a, b) => { const x = val(a); const y = val(b); const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : x - y; return st.dir === 'asc' ? c : -c; });
    return rows;
  }
  function draw() {
    thead.innerHTML = `<tr>${selectable ? '<th><input type="checkbox" data-all></th>' : ''}${cols.map((c) => `<th class="${c.num ? 'num' : ''}" data-k="${esc(c.k)}">${esc(c.t)}${st.sortKey === c.k ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
    const rows = sorted();
    tbody.innerHTML = rows.length ? rows.map((r) => {
      const id = rowKey ? r[rowKey] : '';
      return `<tr data-id="${esc(id)}" class="${onRow ? 'click' : ''} ${st.sel.has(String(id)) ? 'sel' : ''} ${rowClass ? esc(rowClass(r)) : ''}">${selectable ? `<td><input type="checkbox" data-sel ${st.sel.has(String(id)) ? 'checked' : ''}></td>` : ''}${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${cell(c, r)}</td>`).join('')}</tr>`;
    }).join('') : `<tr><td colspan="${cols.length + (selectable ? 1 : 0)}" class="muted" style="padding:22px;text-align:center">${esc(empty)}</td></tr>`;
    const all = $('[data-all]', thead);
    if (all) { all.checked = rows.length > 0 && rows.every((r) => st.sel.has(String(r[rowKey]))); all.onchange = () => { rows.forEach((r) => (all.checked ? st.sel.add(String(r[rowKey])) : st.sel.delete(String(r[rowKey])))); draw(); onSelect && onSelect(api2.selected()); }; }
    $$('th[data-k]', thead).forEach((th) => { th.onclick = () => { const k = th.dataset.k; if (st.sortKey === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sortKey = k; st.dir = 'desc'; } draw(); }; });
    $$('tr[data-id]', tbody).forEach((tr) => {
      const id = tr.dataset.id;
      const cb = $('[data-sel]', tr);
      if (cb) cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) st.sel.add(id); else st.sel.delete(id); tr.classList.toggle('sel', cb.checked); const a = $('[data-all]', thead); if (a) a.checked = rows.every((r) => st.sel.has(String(r[rowKey]))); onSelect && onSelect(api2.selected()); };
      if (onRow) tr.onclick = () => onRow(st.rows.find((r) => String(r[rowKey]) === id));
    });
  }
  const api2 = {
    el: host,
    set(rows) { st.rows = rows; const ids = new Set(rows.map((r) => String(r[rowKey]))); st.sel = new Set([...st.sel].filter((x) => ids.has(x))); draw(); onSelect && onSelect(api2.selected()); },
    selected() { return st.rows.filter((r) => st.sel.has(String(r[rowKey]))); },
    clearSelection() { st.sel.clear(); draw(); onSelect && onSelect([]); },
    rows() { return sorted(); },
  };
  draw();
  return api2;
}

// ---------- tiny line chart on <canvas> ----------
function drawChart(canvas, labels, series) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line').trim() || '#ddd'; const mut = css.getPropertyValue('--muted').trim() || '#888';
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 46, r: 12, t: 10, b: 26 };
  const max = Math.max(1e-9, ...series.flatMap((s) => s.data.map((v) => v || 0)));
  const x = (i) => pad.l + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * (w - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v || 0) / max) * (h - pad.t - pad.b);
  ctx.strokeStyle = line; ctx.fillStyle = mut; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i; const yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(nf(v, v < 10 ? 2 : 0), pad.l - 6, yy + 3);
  }
  ctx.textAlign = 'center';
  const step = Math.ceil(labels.length / 8);
  labels.forEach((l, i) => { if (i % step === 0) ctx.fillText(l, x(i), h - 8); });
  series.forEach((s) => {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
    s.data.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    if (labels.length < 40) { ctx.fillStyle = s.color; s.data.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2.5, 0, 6.3); ctx.fill(); }); }
  });
}
const PALETTE = ['#2a9de6', '#e8833a', '#1e9e5a', '#a05ccf', '#d64545', '#c9a400', '#2fb5b5', '#7a8794'];
function legend(series) { return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`; }

/** Pass data between pages (e.g. builder -> bulk, duplicate -> create). */
const handoff = {
  set(k, v) { sessionStorage.setItem(`tga_${k}`, JSON.stringify(v)); },
  take(k) { const v = sessionStorage.getItem(`tga_${k}`); sessionStorage.removeItem(`tga_${k}`); try { return v ? JSON.parse(v) : null; } catch (_) { return null; } },
};

function go(page) { location.hash = `#/${page}`; }

/** Load ads once per view with an optional force refresh. */
async function getAds({ target = false, refresh = false } = {}) {
  const r = await api(`/api/ads?target=${target ? 1 : 0}${refresh ? '&refresh=1' : ''}`);
  return r;
}
function setCurrencyFrom(obj) { if (obj && obj.currency) S.currency = obj.currency; }

function pageRegister(id, def) { S.pages[id] = def; }
