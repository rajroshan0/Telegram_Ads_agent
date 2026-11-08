'use strict';
/* Router, navigation, login, account switcher. */
const NAV = [
  ['dashboard', 'Overview'], ['ads', null], ['create', null], ['bulk', null], ['batch', null],
  ['sep', 'Analyse'], ['stats', null], ['overlap', null],
  ['sep', 'Audience & tracking'], ['audiences', null], ['pixel', null], ['targets', null],
  ['sep', 'Automation'], ['rules', null], ['logs', null],
  ['sep', 'Account'], ['accounts', null], ['settings', null], ['explorer', null],
];

function buildNav() {
  $('#nav').innerHTML = NAV.map(([id, label]) => (id === 'sep' ? `<div class="sep">${esc(label)}</div>` : `<a href="#/${id}" data-p="${id}"><span>${esc(S.pages[id].icon)}</span><span>${esc(S.pages[id].title)}</span></a>`)).join('');
}

async function route() {
  const id = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const page = S.pages[id] || S.pages.dashboard;
  const key = S.pages[id] ? id : 'dashboard';
  S.currentPage = key;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.p === key));
  $('#pageTitle').textContent = page.title;
  const view = $('#view');
  view.innerHTML = '<div class="muted">Loading…</div>';
  try {
    await page.render(view);
  } catch (e) {
    if (S.currentPage !== key) return;
    const noToken = /NO_ADS_TOKEN/.test(e.message);
    view.innerHTML = `<div class="card"><h2 class="bad">${noToken ? 'Add your Telegram Ads token first' : 'Something went wrong'}</h2><p>${esc(e.message)}</p>${noToken ? '<a class="btn primary" href="#/settings">Open Settings</a>' : '<button class="btn" onclick="route()">Try again</button>'}</div>`;
  }
  // page-specific hand-offs that need the DOM to exist
  if (key === 'batch') { const pre = handoff.take('batchChannels'); if (pre) { const t = $('#chs', view); if (t) { t.value = pre; t.dispatchEvent(new Event('input')); } } }
}

function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); setTimeout(() => $('#loginPw').focus(), 50); }

async function bootAccount() {
  try {
    const a = await api('/api/account');
    S.account = a; setCurrencyFrom(a);
    $('#balance').textContent = `${money(a.remaining_budget)} ${a.currency}`;
    $('#envBadge').textContent = `${a.title}`;
  } catch (e) {
    $('#balance').textContent = /NO_ADS_TOKEN/.test(e.message) ? 'no token' : 'offline';
    $('#envBadge').textContent = '';
  }
}

async function bootAccounts() {
  const sel = $('#acctSel');
  let rel = { accounts: [] };
  try { rel = await api('/api/related-accounts'); } catch (_) { /* optional */ }
  sel.innerHTML = `<option value="">Default</option><option value="main">Main account</option>${(rel.accounts || []).map((a) => `<option value="${esc(a.account_id)}">${esc(a.title)} (#${esc(a.account_id)})</option>`).join('')}`;
  sel.value = S.acct;
  if (sel.value !== S.acct) { S.acct = ''; sel.value = ''; }
  sel.onchange = async () => { S.acct = sel.value; localStorage.setItem('tga_acct', S.acct); await bootAccount(); route(); toast(`Working in: ${sel.options[sel.selectedIndex].text}`); };
}

async function start() {
  buildNav();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  await bootAccount();
  bootAccounts();
  window.addEventListener('hashchange', route);
  route();
}

(async function init() {
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { password: $('#loginPw').value } }); location.reload(); } catch (err) { $('#loginErr').textContent = err.message; }
  };
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    if (me.auth && !me.loggedIn) return showLogin();
  } catch (_) { /* server down */ }
  await start();
})();
