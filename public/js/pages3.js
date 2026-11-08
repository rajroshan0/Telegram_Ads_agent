'use strict';
/* Audiences, Pixel, Targeting lookup, Accounts, Rules, Logs, Settings, API explorer */

const tgCall = (method, body = {}) => api(`/api/tg/${method}`, { method: 'POST', body }).then((r) => r.result);

// ======================================================= Audiences
pageRegister('audiences', {
  title: 'Audiences', icon: '☺',
  async render(view) {
    view.innerHTML = `
      <div class="note">Audiences are lists of phone numbers you already have (for example people who shared their number with your bot). Use them to <b>retarget</b> them or to <b>exclude</b> them from cold ads. Only upload numbers you have permission to use. Use international format with country code (e.g. +919876543210). If you are unsure about hashing, leave it off: numbers are then sent as typed digits.</div>
      <div class="grid g2 gap">
        <div class="card"><h2>New audience</h2>
          <label class="f"><span>Title</span><input type="text" id="aTitle"></label>
          <label class="f gap"><span>Phone numbers (one per line, up to 10,000 per request — more are sent in parts)</span><textarea id="aPh" style="min-height:140px"></textarea></label>
          <div class="row gap"><input type="file" id="aFile" accept=".csv,.txt"><label class="chk"><input type="checkbox" id="aHash"> Send SHA-256 hashes instead of numbers</label><span class="grow"></span><button class="btn primary" id="aCreate">Create audience</button></div>
        </div>
        <div class="card"><h2>My audiences</h2><div id="aTbl"></div></div>
      </div>`;
    $('#aFile', view).onchange = async (e) => { const f = e.target.files[0]; if (f) $('#aPh', view).value = await readText(f); };
    const load = async () => {
      const r = await tgCall('getAudiencesList', {});
      dataTable($('#aTbl', view), { cols: [
        { k: 'title', t: 'Title' }, { k: 'size', t: 'Size', num: true, html: (a) => (a.size === 50 ? '<100' : nf(a.size)) }, { k: 'ads_count', t: 'Ads', num: true }, { k: 'updated_date', t: 'Updated', html: (a) => esc(dt(a.updated_date)) },
        { k: 'x', t: '', html: (a) => `<button class="btn sm" data-au="add" data-id="${a.audience_id}">Add</button> <button class="btn sm" data-au="remove" data-id="${a.audience_id}">Remove</button> <button class="btn sm" data-au="reset" data-id="${a.audience_id}">Replace</button> <button class="btn sm" data-au="rename" data-id="${a.audience_id}">Rename</button> <button class="btn sm danger" data-au="delete" data-id="${a.audience_id}">Delete</button>` },
      ], rowKey: 'audience_id', empty: 'No audiences yet.' }).set(r.audiences || []);
      $$('[data-au]', view).forEach((b) => { b.onclick = () => busy(b, () => audAction(b.dataset.au, Number(b.dataset.id), (r.audiences || []).find((x) => x.audience_id === Number(b.dataset.id)))); });
    };
    async function audAction(a, id, aud) {
      if (a === 'delete') { if (!(await confirmBox(`Delete audience "${aud.title}"? It must not be used in any ad.`, { danger: true, okLabel: 'Delete' }))) return; await tgCall('deleteAudience', { audience_id: id }); toast('Deleted', 'good'); return load(); }
      if (a === 'rename') { const t = await promptBox('New title', aud.title); if (!t) return; await tgCall('editAudience', { audience_id: id, title: t }); toast('Renamed', 'good'); return load(); }
      const hash = $('#aHash', view).checked;
      const text = await new Promise((resolve) => { const m = modal({ title: `${{ add: 'Add numbers to', remove: 'Remove numbers from', reset: 'Replace all numbers in' }[a]} "${aud.title}"`, body: '<textarea id="mPh" style="min-height:160px"></textarea><div class="hint">One number per line.</div>', buttons: [{ label: 'Cancel', onClick: () => resolve(null) }, { label: 'Apply', cls: 'primary', onClick: ({ el }) => resolve($('#mPh', el).value) }] }); $('[data-x]', m.el).addEventListener('click', () => resolve(null)); });
      if (text === null) return;
      if (a === 'reset' && !(await confirmBox('This removes all current numbers first.', { danger: true }))) return;
      const r = await api('/api/audiences/upload', { method: 'POST', body: { audience_id: id, phones: text, hash, mode: a } });
      toast(`Sent ${r.sent} numbers`, 'good'); load();
    }
    $('#aCreate', view).onclick = (e) => busy(e.target, async () => {
      const r = await api('/api/audiences/upload', { method: 'POST', body: { title: $('#aTitle', view).value.trim(), phones: $('#aPh', view).value, hash: $('#aHash', view).checked } });
      toast(`Audience created with ${r.sent} numbers`, 'good'); $('#aPh', view).value = ''; load();
    });
    await load();
  },
});

// ======================================================= Pixel
pageRegister('pixel', {
  title: 'Pixel & conversions', icon: '◉',
  async render(view) {
    view.innerHTML = `<div class="note info">The pixel tracks actions on <b>your website</b> (page view, lead, purchase, registration …). Put the base code in every page, create an event, and select it as "Pixel event id" in an ad that promotes an external website. Channel joins and bot starts are counted without a pixel.</div><div id="px" class="gap"></div><div id="ev" class="card"></div>`;
    const loadPixel = async () => {
      const box = $('#px', view);
      try {
        const p = await tgCall('getPixel', {});
        box.innerHTML = `<div class="card"><h2>Base code <span class="muted small">pixel ${esc(p.pixel_id)}</span></h2><p class="muted">Paste before the closing &lt;/head&gt; tag on all pages of the website.</p><pre>${esc(p.code_snippet)}</pre><div class="row gap"><button class="btn" id="cpPx">Copy</button></div></div>`;
        $('#cpPx', box).onclick = () => copyText(p.code_snippet);
        return true;
      } catch (e) {
        box.innerHTML = `<div class="card"><h2>No pixel yet</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" id="mkPx">Create pixel</button></div>`;
        $('#mkPx', box).onclick = (b) => busy(b.target, async () => { await tgCall('createPixel', {}); toast('Pixel created', 'good'); loadPixel(); loadEvents(); });
        return false;
      }
    };
    const TYPES = ['page_view', 'add_to_cart', 'add_to_wishlist', 'customize_product', 'initiate_checkout', 'add_payment_info', 'purchase', 'contact', 'lead', 'schedule', 'complete_registration', 'submit_application', 'start_trial', 'subscribe', 'view_content', 'search', 'find_location', 'donate', 'custom'];
    const loadEvents = async () => {
      const box = $('#ev', view);
      let list = [];
      try { list = (await tgCall('getPixelEventsList', {})).events || []; } catch (e) { box.innerHTML = `<h2>Events</h2><p class="muted">${esc(e.message)}</p>`; return; }
      box.innerHTML = `<h2>Events</h2><div id="evT"></div>
        <h3 class="gap">New event</h3><div class="row"><input type="text" id="eTitle" placeholder="Title, e.g. Registration" style="max-width:260px"><select id="eType">${TYPES.map((t) => `<option>${t}</option>`).join('')}</select><button class="btn primary" id="eMk">Create event</button></div>`;
      dataTable($('#evT', box), { cols: [
        { k: 'title', t: 'Title' }, { k: 'type', t: 'Type' }, { k: 'status', t: 'Status' }, { k: 'ads_count', t: 'Ads', num: true }, { k: 'event_id', t: 'Event id', html: (x) => `<span class="mono">${esc(x.event_id)}</span> <button class="btn sm" data-cp="${esc(x.event_id)}">copy</button>` },
        { k: 'last_triggered_date', t: 'Last seen', html: (x) => esc(x.last_triggered_date ? dt(x.last_triggered_date) : 'never (7 days)') },
        { k: 'x', t: '', html: (x) => `<button class="btn sm" data-code="${esc(x.event_id)}">Code</button>${x.auto_created ? '' : ` <button class="btn sm" data-ren="${esc(x.event_id)}">Rename</button> <button class="btn sm danger" data-del="${esc(x.event_id)}">Delete</button>`}` },
      ], rowKey: 'event_id', empty: 'No events yet.' }).set(list);
      $$('[data-cp]', box).forEach((b) => { b.onclick = () => copyText(b.dataset.cp); });
      $$('[data-code]', box).forEach((b) => { b.onclick = () => { const ev = list.find((x) => x.event_id === b.dataset.code); modal({ title: `Code for ${ev.title}`, body: ev.code_snippet ? `<pre>${esc(ev.code_snippet)}</pre>` : '<p class="muted">This event needs no extra code. The base code is enough.</p>' }); }; });
      $$('[data-ren]', box).forEach((b) => { b.onclick = () => busy(b, async () => { const t = await promptBox('New title'); if (!t) return; await tgCall('editPixelEvent', { event_id: b.dataset.ren, title: t }); loadEvents(); }); });
      $$('[data-del]', box).forEach((b) => { b.onclick = () => busy(b, async () => { if (!(await confirmBox('Delete this event? It must not be used by any ad.', { danger: true, okLabel: 'Delete' }))) return; await tgCall('deletePixelEvent', { event_id: b.dataset.del }); loadEvents(); }); });
      $('#eMk', box).onclick = (e) => busy(e.target, async () => { await tgCall('createPixelEvent', { title: $('#eTitle', box).value.trim(), type: $('#eType', box).value }); toast('Event created', 'good'); loadEvents(); });
    };
    if (await loadPixel()) await loadEvents(); else $('#ev', view).innerHTML = '<span class="muted">Create the pixel to manage events.</span>';
  },
});

// ======================================================= Targeting lookup
pageRegister('targets', {
  title: 'Targeting lookup', icon: '⌖',
  async render(view) {
    view.innerHTML = `<div class="tabs" id="tt"><button data-t="topics" class="on">Topics</button><button data-t="languages">Languages</button><button data-t="countries">Countries</button><button data-t="locations">Cities / locations</button><button data-t="channel">Check channel / bot</button></div><div id="tb"></div>`;
    const tb = $('#tb', view);
    const showList = async (kind) => {
      const list = await api(`/api/targets/${kind}`);
      const idKey = { topics: 'topic_id', languages: 'language_code', countries: 'country_code' }[kind];
      tb.innerHTML = `<div class="card"><input type="text" id="f" placeholder="Filter…" style="max-width:260px"><span class="muted small"> click a row to copy its ${idKey}</span><div id="lt" class="gap"></div></div>`;
      const t = dataTable($('#lt', tb), { cols: [{ k: 'name', t: 'Name' }, { k: idKey, t: idKey }], rowKey: idKey, sortKey: 'name', sortDir: 'asc', onRow: (r) => copyText(String(r[idKey])) });
      const apply = () => { const f = $('#f', tb).value.toLowerCase(); t.set(list.filter((x) => !f || `${x.name} ${x[idKey]}`.toLowerCase().includes(f))); };
      $('#f', tb).oninput = apply; apply();
    };
    const showLoc = async () => {
      const countries = await api('/api/targets/countries');
      tb.innerHTML = `<div class="card"><div class="row"><select id="lc">${countries.map((c) => `<option value="${esc(c.country_code)}" ${c.country_code === 'IN' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input type="text" id="lq" placeholder="City / district name" style="max-width:260px"><button class="btn primary" id="lg">Search</button></div><div id="lr" class="gap"></div></div>`;
      $('#lg', tb).onclick = (e) => busy(e.target, async () => {
        const r = await api(`/api/targets/locations?country=${$('#lc', tb).value}&q=${encodeURIComponent($('#lq', tb).value)}`);
        dataTable($('#lr', tb), { cols: [{ k: 'name', t: 'Name' }, { k: 'region', t: 'Region' }, { k: 'location_id', t: 'Location id' }], rowKey: 'location_id', onRow: (x) => copyText(String(x.location_id)), empty: 'No matches.' }).set(r.locations || []);
      });
    };
    const showCheck = () => {
      tb.innerHTML = `<div class="card"><h2>Check a channel or bot</h2><div class="row"><input type="text" id="cn" placeholder="@channelname or t.me/…" style="max-width:300px"><button class="btn" id="cc">Check channel</button><button class="btn" id="cbb">Check bot</button></div><pre id="cr" class="gap hidden"></pre><p class="hint">Telegram only lets you use numeric ids of channels you looked up by username first. Checking here counts as looking it up.</p></div>`;
      const go2 = (kind) => (e) => busy(e.target, async () => { const r = await api(`/api/targets/${kind}?name=${encodeURIComponent($('#cn', tb).value)}`); const pre = $('#cr', tb); pre.classList.remove('hidden'); pre.textContent = JSON.stringify(r, null, 2); });
      $('#cc', tb).onclick = go2('channel'); $('#cbb', tb).onclick = go2('bot');
    };
    const tab = (t) => { $$('#tt button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === t)); (['topics', 'languages', 'countries'].includes(t) ? showList(t) : t === 'locations' ? showLoc() : Promise.resolve(showCheck())).catch(fail); };
    $$('#tt button', view).forEach((b) => { b.onclick = () => tab(b.dataset.t); });
    tab('topics');
  },
});

// ======================================================= Accounts & money
pageRegister('accounts', {
  title: 'Accounts & money', icon: '◈',
  async render(view) {
    view.innerHTML = '<div class="muted">Loading…</div>';
    const [acct, info, rel] = await Promise.all([api('/api/account'), tgCall('getAccountInfo', {}).catch(() => null), api('/api/related-accounts').catch(() => ({ accounts: [], total_count: 0 }))]);
    setCurrencyFrom(acct);
    view.innerHTML = `
      <div class="grid g2">
        <div class="card"><h2>${esc(acct.title)} <span class="muted small">#${esc(acct.account_id)}</span></h2>
          <div class="kpis"><div class="kpi"><div class="l">Balance</div><div class="v">${money(acct.remaining_budget)}</div></div><div class="kpi"><div class="l">Spent</div><div class="v">${money(acct.spent_budget)}</div></div><div class="kpi"><div class="l">In ads</div><div class="v">${money(acct.ads_budget)}</div></div></div>
          <div class="muted small">Currency: ${esc(acct.currency)} (fixed when the account was created)</div>
          ${info ? `<details class="gap"><summary>Company info</summary><div class="form-grid gap" id="info">${['full_name', 'email', 'phone_number', 'country', 'city', 'legal_name'].map((k) => `<label class="f"><span>${k}</span><input type="text" name="${k}" value="${esc(info[k] || '')}"></label>`).join('')}</div><button class="btn primary gap" id="saveInfo">Save company info</button><div class="hint">The legal name is shown to users together with "additional info" in ads.</div></details>` : ''}
        </div>
        <div class="card"><h2>Look up a transaction</h2><div class="row"><input type="text" id="trId" placeholder="Transaction id" style="max-width:260px"><button class="btn" id="trGo">Check status</button></div><pre id="trOut" class="gap hidden"></pre></div>
      </div>
      <div class="card"><h2>Sub-accounts (${rel.total_count || 0})</h2><div id="relT"></div>
        <details class="gap"><summary>Create a sub-account</summary><div class="form-grid gap" id="newAcc">${['title', 'full_name', 'email', 'phone_number', 'country', 'city', 'legal_name'].map((k) => `<label class="f"><span>${k}${k === 'legal_name' ? ' (optional)' : ''}</span><input type="text" name="${k}"></label>`).join('')}</div><button class="btn primary gap" id="mkAcc">Create sub-account</button></details></div>
      <div class="card"><h2>Transactions</h2><div class="row"><label class="f"><span>Ad id (optional)</span><input type="number" id="txAd" style="width:140px"></label><button class="btn" id="txGo" style="align-self:flex-end">Load</button></div><div id="txT" class="gap"></div></div>`;
    if (info) $('#saveInfo', view).onclick = (e) => busy(e.target, async () => { const b = {}; $$('#info input', view).forEach((i) => { if (i.value.trim()) b[i.name] = i.value.trim(); }); await tgCall('editAccountInfo', b); toast('Saved', 'good'); });
    $('#trGo', view).onclick = (e) => busy(e.target, async () => { const r = await tgCall('getTransactionStatus', { transaction_id: $('#trId', view).value.trim() }); const o = $('#trOut', view); o.classList.remove('hidden'); o.textContent = JSON.stringify(r, null, 2); });
    const relT = dataTable($('#relT', view), { cols: [{ k: 'account_id', t: 'Id' }, { k: 'title', t: 'Title' }, { k: 'remaining_budget', t: 'Balance', num: true, html: (a) => money(a.remaining_budget) }, { k: 'spent_budget', t: 'Spent', num: true, html: (a) => money(a.spent_budget) },
      { k: 'x', t: '', html: (a) => `<button class="btn sm" data-inc="${esc(a.account_id)}">+ Funds</button> <button class="btn sm" data-dec="${esc(a.account_id)}">− Funds</button>` }], rowKey: 'account_id', empty: 'No sub-accounts.' });
    relT.set(rel.accounts || []);
    const move = (kind) => (b) => busy(b.target, async () => {
      const amount = await promptBox(`${kind === 'increaseAccountBudget' ? 'Move funds from your main balance to' : 'Withdraw funds from'} account ${b.target.dataset.inc || b.target.dataset.dec}`, '', { type: 'number', hint: `Amount in ${cur()}` });
      if (!amount) return;
      const r = await tgCall(kind, { account_id: b.target.dataset.inc || b.target.dataset.dec, amount: Number(amount) });
      toast(`Transaction ${r.status}${r.error ? `: ${r.error}` : ''}`, r.status === 'completed' ? 'good' : 'bad'); S.pages.accounts.render(view);
    });
    $$('[data-inc]', view).forEach((b) => { b.onclick = move('increaseAccountBudget'); }); $$('[data-dec]', view).forEach((b) => { b.onclick = move('decreaseAccountBudget'); });
    $('#mkAcc', view).onclick = (e) => busy(e.target, async () => { const b = {}; $$('#newAcc input', view).forEach((i) => { if (i.value.trim()) b[i.name] = i.value.trim(); }); const r = await tgCall('createAccount', b); toast(`Created account #${r.account_id}`, 'good'); S.pages.accounts.render(view); });
    $('#txGo', view).onclick = (e) => busy(e.target, async () => {
      const adId = $('#txAd', view).value;
      const r = await api(`/api/transactions?limit=100${adId ? `&ad_id=${adId}` : ''}`);
      dataTable($('#txT', view), { cols: [{ k: 'date', t: 'Date', html: (t) => esc(dt(t.date)), val: (t) => t.date }, { k: 'peer', t: 'Peer', html: (t) => esc(`${t.peer.type}${t.peer.ad_title ? `: ${t.peer.ad_title}` : ''}${t.peer.comment ? `: ${t.peer.comment}` : ''}${t.peer.account_title ? `: ${t.peer.account_title}` : ''}${t.peer.views ? `: ${t.peer.views} views` : ''}`), val: (t) => t.peer.type }, { k: 'amount', t: 'Amount', num: true, d: 4, html: (t) => `<span class="${t.amount < 0 ? 'bad' : 'good'}">${money(t.amount, 4)}</span>` }, { k: 'currency', t: '' }], rowKey: 'date', sortKey: 'date' }).set(r.transactions || []);
    });
  },
});

// ======================================================= Rules
pageRegister('rules', {
  title: 'Auto rules & alerts', icon: '⚙',
  async render(view) {
    const meta = await api('/api/rules');
    view.innerHTML = `
      <div class="note info">Rules watch your ads and act automatically, for example <b>pause an ad that spent 5 and has CPA above 1</b>. Every rule starts in <b>test mode</b> (it only reports what it would do). The monitor checks all ads every few minutes and sends alerts to your Telegram bot. Turn the monitor on in <a href="#/settings">Settings</a>.</div>
      <div class="row gap"><button class="btn primary" id="newRule">+ New rule</button><button class="btn" id="presets">Add starter rules</button><span class="grow"></span><span class="pill">Monitor: ${meta.monitor.running ? 'on' : 'off'}${meta.monitor.lastRun ? ` · last run ${esc(new Date(meta.monitor.lastRun).toLocaleTimeString())}` : ''}</span><button class="btn" id="tick">Run monitor now</button></div>
      <div id="rl" class="gap"></div><div id="rres"></div>`;
    const cond = (r) => r.conditions.map((c) => `${c.metric} ${c.op} ${c.value}`).join(' AND ');
    const act = (r) => `${r.action.type}${r.action.amount !== undefined ? ` ${r.action.amount}` : ''}`;
    const draw = () => {
      dataTable($('#rl', view), { cols: [
        { k: 'enabled', t: 'On', html: (r) => `<input type="checkbox" data-en="${esc(r.id)}" ${r.enabled ? 'checked' : ''}>` },
        { k: 'name', t: 'Rule', cls: 'wrap', html: (r) => `<b>${esc(r.name)}</b><div class="muted small">${esc((r.scope.statuses || []).join('/'))}${r.scope.titleContains ? ` · title has "${esc(r.scope.titleContains)}"` : ''}${r.scope.titleRegex ? ` · /${esc(r.scope.titleRegex)}/` : ''}</div>` },
        { k: 'c', t: 'When', cls: 'wrap', html: (r) => `<span class="mono">${esc(cond(r))}</span>` }, { k: 'a', t: 'Then', html: (r) => esc(act(r)) },
        { k: 'dryRun', t: 'Mode', html: (r) => (r.dryRun ? '<span class="badge">test only</span>' : '<span class="st active">live</span>') }, { k: 'cooldownMinutes', t: 'Cooldown', num: true, html: (r) => (r.cooldownMinutes ? `${r.cooldownMinutes} min` : '–') },
        { k: 'x', t: '', html: (r) => `<button class="btn sm" data-t="${esc(r.id)}">Test</button> <button class="btn sm" data-e="${esc(r.id)}">Edit</button> <button class="btn sm danger" data-d="${esc(r.id)}">Delete</button>` },
      ], rowKey: 'id', empty: 'No rules yet. Add the starter rules or create your own.' }).set(meta.rules);
      $$('[data-en]', view).forEach((c) => { c.onchange = () => busy(c, async () => { const r = meta.rules.find((x) => x.id === c.dataset.en); r.enabled = c.checked; await api('/api/rules', { method: 'POST', body: r }); toast(r.enabled ? 'Rule enabled' : 'Rule disabled', 'good'); }); });
      $$('[data-t]', view).forEach((b) => { b.onclick = () => test(b.dataset.t, b); });
      $$('[data-e]', view).forEach((b) => { b.onclick = () => edit(meta.rules.find((x) => x.id === b.dataset.e)); });
      $$('[data-d]', view).forEach((b) => { b.onclick = () => busy(b, async () => { if (!(await confirmBox('Delete this rule?', { danger: true, okLabel: 'Delete' }))) return; await api(`/api/rules/${b.dataset.d}`, { method: 'DELETE' }); await reload(); }); });
    };
    const reload = async () => { const m = await api('/api/rules'); meta.rules = m.rules; draw(); };
    async function test(id, btn) {
      await busy(btn, async () => {
        const r = await api('/api/rules/run', { method: 'POST', body: { ruleId: id, dry: true } });
        $('#rres', view).innerHTML = `<div class="card"><h2>Test result: ${r.hits.length} ad(s) would match</h2><div class="muted small">${r.evaluated} ads checked. Nothing was changed.</div><div id="hits" class="gap"></div></div>`;
        dataTable($('#hits', view), { cols: [{ k: 'title', t: 'Ad' }, { k: 'action', t: 'Action' }, { k: 'reasons', t: 'Because', cls: 'wrap', html: (h) => esc(h.reasons.join(' · ')) }], rowKey: 'ad_id', empty: 'No ads match this rule right now.' }).set(r.hits);
      });
    }
    function edit(rule) {
      const R = rule || { name: '', enabled: false, dryRun: true, cooldownMinutes: 0, scope: { statuses: ['active'] }, conditions: [{ metric: 'spent', op: '>=', value: 5 }], action: { type: 'pause' } };
      const sOpts = ['active', 'in_review', 'on_hold', 'ready_for_review', 'declined', 'stopped'];
      const m = modal({ title: rule ? 'Edit rule' : 'New rule', wide: true, body: `
        <label class="f"><span>Name</span><input type="text" id="rn" value="${esc(R.name)}"></label>
        <h3 class="gap">Applies to ads that are</h3><div class="row">${sOpts.map((s) => `<label class="chk"><input type="checkbox" class="rs" value="${s}" ${(R.scope.statuses || []).includes(s) ? 'checked' : ''}>${s.replace(/_/g, ' ')}</label>`).join('')}</div>
        <div class="form-grid gap"><label class="f"><span>Title contains (optional)</span><input type="text" id="rtc" value="${esc(R.scope.titleContains || '')}"></label><label class="f"><span>Title matches regex (optional)</span><input type="text" id="rtr" value="${esc(R.scope.titleRegex || '')}"></label><label class="f"><span>Only these ad ids (optional)</span><input type="text" id="rids" value="${esc((R.scope.adIds || []).join(', '))}"></label></div>
        <h3 class="gap">When ALL of these are true</h3><div id="conds"></div><button class="btn sm" id="addC">+ Condition</button>
        <div class="hint gap">CPA counts as "infinite" when an ad has spent money but has no actions, so <span class="mono">cpa &gt; 1</span> also catches ads burning money with zero results. Metrics: spent, clicks, views, actions, remaining (budget left), ctr, cvr, cpm, cpc, cpa, age_hours, daily_spent.</div>
        <h3 class="gap">Then</h3><div class="row"><select id="ra">${meta.actions.map((a) => `<option value="${a}" ${R.action.type === a ? 'selected' : ''}>${a}</option>`).join('')}</select><input type="number" step="any" id="ram" placeholder="amount" value="${R.action.amount ?? ''}" style="width:130px"><span class="hint" id="ahint"></span></div>
        <div class="row gap"><label class="f"><span>Cooldown per ad (minutes)</span><input type="number" id="rcd" value="${R.cooldownMinutes || 0}" style="width:140px"></label><label class="chk"><input type="checkbox" id="ronce" ${R.once ? 'checked' : ''}> act only once per ad</label><label class="chk"><input type="checkbox" id="rdry" ${R.dryRun !== false ? 'checked' : ''}> <b>Test mode</b> (report only, change nothing)</label><label class="chk"><input type="checkbox" id="ren" ${R.enabled ? 'checked' : ''}> enabled</label></div>`,
      buttons: [{ label: 'Cancel', onClick: () => {} }, { label: 'Save rule', cls: 'primary', onClick: async ({ el }) => {
        const body = { id: rule && rule.id, name: $('#rn', el).value, enabled: $('#ren', el).checked, dryRun: $('#rdry', el).checked, once: $('#ronce', el).checked, cooldownMinutes: Number($('#rcd', el).value) || 0,
          scope: { statuses: $$('.rs:checked', el).map((x) => x.value), titleContains: $('#rtc', el).value.trim(), titleRegex: $('#rtr', el).value.trim(), adIds: $('#rids', el).value.split(/[\s,;]+/).filter(Boolean).map(Number) },
          conditions: $$('.cond', el).map((r) => ({ metric: $('.cm', r).value, op: $('.co', r).value, value: $('.cv', r).value })),
          action: { type: $('#ra', el).value, amount: $('#ram', el).value } };
        await api('/api/rules', { method: 'POST', body }); toast('Rule saved', 'good'); await reload();
      } }] });
      const addCond = (c = { metric: 'spent', op: '>=', value: '' }) => {
        const d = document.createElement('div'); d.className = 'cond';
        d.innerHTML = `<select class="cm">${meta.metrics.map((x) => `<option ${x === c.metric ? 'selected' : ''}>${x}</option>`).join('')}</select><select class="co">${meta.ops.map((x) => `<option ${x === c.op ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><input type="number" step="any" class="cv" value="${esc(c.value)}"><button class="btn sm danger">✕</button>`;
        $('button', d).onclick = () => d.remove(); $('#conds', m.el).appendChild(d);
      };
      R.conditions.forEach(addCond); $('#addC', m.el).onclick = () => addCond();
      const hint = () => { const a = $('#ra', m.el).value; $('#ahint', m.el).textContent = { add_budget: 'amount added to the ad budget', set_daily_limit: 'new daily limit', set_cpm: 'new CPM', increase_cpm_pct: 'percent increase', decrease_cpm_pct: 'percent decrease', pause: 'pauses the ad', resume: 'resumes the ad', notify: 'only sends a Telegram message' }[a] || ''; };
      $('#ra', m.el).onchange = hint; hint();
    }
    $('#newRule', view).onclick = () => edit(null);
    $('#presets', view).onclick = (e) => busy(e.target, async () => { for (const p of meta.presets) await api('/api/rules', { method: 'POST', body: p }); toast('Starter rules added (disabled, test mode)', 'good'); await reload(); });
    $('#tick', view).onclick = (e) => busy(e.target, async () => { const r = await api('/api/monitor/tick', { method: 'POST', body: {} }); toast(r.error ? r.error : r.skipped ? 'Already running' : `Checked ${r.ads} ads · ${r.alerts} alerts · ${r.rules.hits.length} rule hits`, r.error ? 'bad' : 'good'); });
    draw();
  },
});

// ======================================================= Logs
pageRegister('logs', {
  title: 'Activity log', icon: '☷',
  async render(view) {
    view.innerHTML = `<div class="row"><select id="lt"><option value="">All</option>${['create', 'ad-action', 'rule', 'alert', 'api', 'error', 'system'].map((t) => `<option>${t}</option>`).join('')}</select><button class="btn" id="lr">↻ Refresh</button></div><div id="lg" class="gap"></div>`;
    const load = async () => { const r = await api(`/api/logs?limit=300${$('#lt', view).value ? `&type=${$('#lt', view).value}` : ''}`); dataTable($('#lg', view), { cols: [{ k: 't', t: 'Time', html: (l) => esc(new Date(l.t).toLocaleString()) }, { k: 'type', t: 'Type', html: (l) => `<span class="badge">${esc(l.type)}</span>` }, { k: 'message', t: 'Message', cls: 'wrap', html: (l) => `<span class="${l.type === 'error' ? 'bad' : ''}">${esc(l.message)}</span>` }], rowKey: 't', sortKey: 't', empty: 'Nothing logged yet.' }).set(r.logs); };
    $('#lr', view).onclick = load; $('#lt', view).onchange = load; await load();
  },
});

// ======================================================= Settings
pageRegister('settings', {
  title: 'Settings', icon: '⚒',
  async render(view) {
    const s = await api('/api/settings');
    const a = s.alerts;
    view.innerHTML = `
      <div class="grid g2">
        <div class="card"><h2>Telegram Ads API</h2>
          <label class="f"><span>API access token ${s.adsTokenSet ? `<span class="ok">· saved (${esc(s.adsToken)})</span>` : '<span class="bad">· missing</span>'}${s.adsTokenFromEnv ? ' · from .env' : ''}</span><input type="password" id="sTok" placeholder="${s.adsTokenSet ? 'Leave empty to keep the saved token' : 'Paste token from Ads account → settings'}" autocomplete="off"></label>
          <label class="f gap"><span>Default sub-account id (optional)</span><input type="text" id="sAcct" value="${esc(s.accountId)}"></label>
          <label class="f gap"><span>Parameter encoding</span><select id="sEnc"><option value="json" ${s.paramEncoding === 'json' ? 'selected' : ''}>JSON (default)</option><option value="form" ${s.paramEncoding === 'form' ? 'selected' : ''}>Form (use only if the API rejects arrays/objects)</option></select></label>
          <label class="f gap"><span>Pause between bulk requests (ms)</span><input type="number" id="sDelay" value="${esc(s.requestDelayMs)}"></label>
          <div class="row gap"><button class="btn" id="tAds">Test connection</button>${s.adsTokenSet && !s.adsTokenFromEnv ? '<button class="btn danger" id="cAds">Remove token</button>' : ''}</div></div>
        <div class="card"><h2>Alerts bot</h2><p class="muted small">Create a bot with @BotFather, send it any message, then paste its token and your chat id (the number of your chat with the bot; the @userinfobot shows it).</p>
          <label class="f"><span>Bot token ${s.botTokenSet ? `<span class="ok">· saved (${esc(s.botToken)})</span>` : ''}${s.botTokenFromEnv ? ' · from .env' : ''}</span><input type="password" id="sBot" placeholder="${s.botTokenSet ? 'Leave empty to keep' : '123456:ABC…'}" autocomplete="off"></label>
          <label class="f gap"><span>Chat id</span><input type="text" id="sChat" value="${esc(s.botChatId)}"></label>
          <div class="row gap"><button class="btn" id="tBot">Check bot</button><button class="btn" id="tMsg">Send test message</button>${s.botTokenSet && !s.botTokenFromEnv ? '<button class="btn danger" id="cBot">Remove token</button>' : ''}</div></div>
      </div>
      <div class="grid g2">
        <div class="card"><h2>Monitor</h2><label class="chk"><input type="checkbox" id="mOn" ${s.monitorEnabled ? 'checked' : ''}> Watch my ads automatically (runs while this app is running)</label>
          <label class="f gap"><span>Check every (minutes)</span><input type="number" id="mInt" min="1" value="${esc(s.monitorIntervalMinutes)}" style="width:120px"></label>
          <h3 class="gap">Send me a message when</h3>
          <label class="chk"><input type="checkbox" id="aDecl" ${a.declined !== false ? 'checked' : ''}> an ad is declined (with the reason)</label>
          <label class="chk"><input type="checkbox" id="aStat" ${a.statusChange !== false ? 'checked' : ''}> an ad changes status</label>
          <label class="chk"><input type="checkbox" id="aRule" ${a.ruleActions !== false ? 'checked' : ''}> an auto rule acts</label>
          <label class="chk"><input type="checkbox" id="aErr" ${a.errors !== false ? 'checked' : ''}> the monitor has an error</label>
          <div class="row gap"><label class="f"><span>Ad budget below (0 = off)</span><input type="number" step="any" id="aLowAd" value="${esc(a.lowAdBudget)}" style="width:140px"></label><label class="f"><span>Account balance below (0 = off)</span><input type="number" step="any" id="aLowAcc" value="${esc(a.lowAccountBudget)}" style="width:170px"></label></div></div>
        <div class="card"><h2>Google Sheets</h2><p class="muted small">Public "anyone with the link" sheets can be read without setup. To read private sheets or write results back, create a Google service account, enable the Sheets API, download its JSON key, paste it here, and share your sheet with its email as Editor.</p>
          <div class="muted small">${s.googleSet ? `Service account: <b>${esc(s.googleEmail || 'configured')}</b>` : 'Not configured'}</div>
          <label class="f gap"><span>Service-account JSON</span><textarea id="sG" placeholder="${s.googleSet ? 'Leave empty to keep the saved key' : '{ "type": "service_account", … }'}" style="min-height:90px"></textarea></label>
          <div class="row gap">${s.googleSet ? '<button class="btn danger" id="cG">Remove key</button>' : ''}</div></div>
      </div>
      <div class="row"><button class="btn primary" id="save">Save settings</button><span class="grow"></span><button class="btn" id="logout">Sign out</button></div>
      <div class="muted small gap">Tokens are stored in <span class="mono">data/settings.json</span> on the machine that runs this app, never sent to the browser in full. On a server, prefer putting them in <span class="mono">.env</span>.</div>`;
    const v = (id) => $(id, view);
    const body = () => ({ adsToken: v('#sTok').value, accountId: v('#sAcct').value, paramEncoding: v('#sEnc').value, requestDelayMs: Number(v('#sDelay').value), botToken: v('#sBot').value, botChatId: v('#sChat').value, googleServiceAccountJson: v('#sG').value,
      monitorEnabled: v('#mOn').checked, monitorIntervalMinutes: Number(v('#mInt').value),
      alerts: { declined: v('#aDecl').checked, statusChange: v('#aStat').checked, ruleActions: v('#aRule').checked, errors: v('#aErr').checked, lowAdBudget: Number(v('#aLowAd').value) || 0, lowAccountBudget: Number(v('#aLowAcc').value) || 0 } });
    const save = async () => { await api('/api/settings', { method: 'POST', body: body() }); toast('Saved', 'good'); await bootAccount(); S.pages.settings.render(view); };
    v('#save').onclick = (e) => busy(e.target, save);
    v('#tAds').onclick = (e) => busy(e.target, async () => { if (v('#sTok').value.trim()) await save(); const r = await api('/api/settings/test', { method: 'POST', body: { what: 'ads' } }); toast(`Connected: ${r.account.title} · balance ${money(r.account.remaining_budget)} ${r.account.currency}`, 'good', 6000); });
    v('#tBot').onclick = (e) => busy(e.target, async () => { if (v('#sBot').value.trim()) await save(); const r = await api('/api/settings/test', { method: 'POST', body: { what: 'bot' } }); toast(r.ok ? `Bot OK: @${r.bot.username}` : `Bot problem: ${r.error}`, r.ok ? 'good' : 'bad'); });
    v('#tMsg').onclick = (e) => busy(e.target, async () => { await save(); const r = await api('/api/settings/test', { method: 'POST', body: { what: 'notify' } }); toast(r.ok ? 'Message sent' : `Failed: ${r.error}`, r.ok ? 'good' : 'bad'); });
    for (const [id, key] of [['#cAds', 'adsToken'], ['#cBot', 'botToken'], ['#cG', 'googleServiceAccountJson']]) { const b = v(id); if (b) b.onclick = () => busy(b, async () => { if (!(await confirmBox('Remove the saved value?', { danger: true }))) return; await api('/api/settings', { method: 'POST', body: { clear: [key] } }); S.pages.settings.render(view); }); }
    v('#logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: {} }); location.reload(); };
  },
});

// ======================================================= API explorer
pageRegister('explorer', {
  title: 'API explorer', icon: '‹›',
  async render(view) {
    const methods = await api('/api/methods');
    const EX = {
      getAdsList: { limit: 20, return_target: true }, getAdsById: { ad_ids: [1], return_target: true }, createAd: { title: 'api test', text: 'Hello', promote_url: 'https://t.me/yourchannel', cpm: 1, placement: 'channel_post', target: { type: 'channels', channel_ids: ['@channel1'] }, initial_budget: 1 },
      editAd: { ad_id: 1, is_paused: true }, increaseAdBudget: { ad_id: 1, amount: 1 }, getAdStats: { ad_id: 1, from_time: Math.floor(Date.now() / 1000) - 7 * 86400, to_time: Math.floor(Date.now() / 1000), interval: 86400 },
      getAccountReport: { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 }, getTargetChannel: { channel_id: '@channelname' }, getTargetBot: { bot_id: '@botname' }, getTargetLocationsList: { country_code: 'IN', query: 'Delhi' },
      createAudience: { title: 'test', add_phones: ['+10000000000'] }, createPixelEvent: { title: 'Lead', type: 'lead' },
    };
    view.innerHTML = `<div class="note">Direct access to every Telegram Ads API method. Request body = JSON parameters. The account id and idempotency key are added automatically. Careful: write methods act on your real account.</div>
      <div class="card gap"><div class="row"><select id="xm" style="min-width:260px">${methods.filter((m) => !m.upload).map((m) => `<option value="${m.name}">${m.name}${m.destructive ? ' ⚠' : ''}</option>`).join('')}</select><span class="grow"></span><button class="btn primary" id="xs">Send</button></div>
      <textarea id="xb" class="gap" style="min-height:200px">{}</textarea><div class="muted small gap" id="xi"></div><pre id="xo" class="gap hidden"></pre></div>`;
    const sel = () => { const m = $('#xm', view).value; $('#xb', view).value = JSON.stringify(EX[m] || {}, null, 2); const meta = methods.find((x) => x.name === m); $('#xi', view).textContent = meta.destructive ? '⚠ Deletes data permanently.' : meta.money ? 'Moves money.' : meta.write ? 'Changes data.' : 'Read only.'; };
    $('#xm', view).onchange = sel; sel();
    $('#xs', view).onclick = (e) => busy(e.target, async () => {
      const m = $('#xm', view).value; const meta = methods.find((x) => x.name === m);
      let b; try { b = JSON.parse($('#xb', view).value || '{}'); } catch (_) { return toast('The body is not valid JSON', 'bad'); }
      if ((meta.destructive || meta.money) && !(await confirmBox(`${m} ${meta.destructive ? 'deletes data permanently' : 'moves money'}. Send it?`, { danger: true, okLabel: 'Send' }))) return;
      const o = $('#xo', view); o.classList.remove('hidden');
      try { const r = await api(`/api/tg/${m}`, { method: 'POST', body: b }); o.textContent = JSON.stringify(r.result, null, 2); } catch (err) { o.textContent = `Error: ${err.message}`; }
    });
  },
});
