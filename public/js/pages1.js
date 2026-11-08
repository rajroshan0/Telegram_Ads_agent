'use strict';
/* Dashboard, Ads manager, Create ad */

/** Poll a bulk job and call onUpdate(job) until finished. */
async function pollJob(jobId, onUpdate) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    onUpdate(job);
    if (job.status !== 'running') return job;
    await sleep(700);
  }
}

function plainText(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent || ''; }

// ======================================================= Dashboard
pageRegister('dashboard', {
  title: 'Dashboard', icon: '◧',
  async render(view) {
    view.innerHTML = '<div class="muted">Loading…</div>';
    const [acct, adsRes, lb] = await Promise.all([api('/api/account'), getAds({ refresh: true }), api('/api/leaderboard?minClicks=100')]);
    setCurrencyFrom(acct); S.account = acct;
    const ads = adsRes.ads;
    const sum = (k) => ads.reduce((a, x) => a + (x[k] || 0), 0);
    const views = sum('views'); const clicks = sum('clicks'); const actions = sum('actions'); const spent = sum('spent_budget');
    const by = {}; ads.forEach((a) => { by[a.status] = (by[a.status] || 0) + 1; });
    const declined = ads.filter((a) => a.status === 'declined');
    const c = cur();
    view.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="l">Balance</div><div class="v">${money(acct.remaining_budget)} <span class="muted small">${esc(c)}</span></div></div>
        <div class="kpi"><div class="l">Total spent (account)</div><div class="v">${money(acct.spent_budget)}</div></div>
        <div class="kpi"><div class="l">Money inside ads</div><div class="v">${money(acct.ads_budget)}</div></div>
        <div class="kpi"><div class="l">Ads</div><div class="v">${ads.length}</div></div>
        <div class="kpi"><div class="l">Views</div><div class="v">${nf(views)}</div></div>
        <div class="kpi"><div class="l">Clicks · CTR</div><div class="v">${nf(clicks)} <span class="muted small">${pct(views ? clicks / views * 100 : null)}</span></div></div>
        <div class="kpi"><div class="l">Actions · CVR</div><div class="v">${nf(actions)} <span class="muted small">${pct(clicks ? actions / clicks * 100 : null)}</span></div></div>
        <div class="kpi"><div class="l">Avg CPA (all ads)</div><div class="v">${actions ? money(spent / actions, 3) : '–'}</div></div>
      </div>
      <div class="card"><h2>Status</h2><div class="chips">${Object.entries(by).map(([s, n]) => `<button class="chip" data-st="${esc(s)}">${esc(s.replace(/_/g, ' '))}: ${n}</button>`).join('') || '<span class="muted">No ads yet</span>'}</div></div>
      ${declined.length ? `<div class="card"><h2 class="bad">Declined ads (${declined.length})</h2><div class="tablewrap"><table><thead><tr><th>Ad</th><th>Reason</th></tr></thead><tbody>${declined.map((a) => `<tr class="click" data-open="${a.ad_id}"><td>${esc(a.title)}</td><td class="wrap">${esc(a.decline_reason ? a.decline_reason.text : '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="grid g2">
        <div class="card"><h2>Best CPA <span class="muted small">(≥100 clicks)</span></h2><div id="best"></div></div>
        <div class="card"><h2>Worst / money burners <span class="muted small">(≥100 clicks)</span></h2><div id="worst"></div></div>
      </div>
      <div class="muted small">${lb.tooEarly} ads have fewer than 100 clicks and are not judged yet. Judge ads by CPA and CVR, not CTR alone.</div>`;
    const cols = [
      { k: 'title', t: 'Ad', html: (r) => esc(r.title) }, { k: 'clicks', t: 'Clicks', num: true }, { k: 'actions', t: 'Actions', num: true },
      { k: 'cvr', t: 'CVR', num: true, html: (r) => pct(r.cvr) }, { k: 'cpa', t: 'CPA', num: true, html: (r) => money(r.cpa, 3) }, { k: 'spent_budget', t: 'Spent', num: true, html: (r) => money(r.spent_budget) },
    ];
    dataTable($('#best', view), { cols, rowKey: 'ad_id', sortKey: 'cpa', sortDir: 'asc', onRow: (r) => openAd(r.ad_id), empty: 'No ad has 100 clicks yet.' }).set(lb.best);
    dataTable($('#worst', view), { cols, rowKey: 'ad_id', sortKey: 'spent_budget', onRow: (r) => openAd(r.ad_id), empty: 'Nothing to flag yet.' }).set(lb.worst);
    $$('[data-open]', view).forEach((tr) => { tr.onclick = () => openAd(Number(tr.dataset.open)); });
    $$('[data-st]', view).forEach((b) => { b.onclick = () => { handoff.set('adsFilter', { status: b.dataset.st }); go('ads'); }; });
  },
});

// ======================================================= Ads manager
async function openAd(adId) {
  const ad = await api(`/api/ads/${adId}`).catch(fail);
  if (!ad) return;
  const d = drawer(`<div class="muted">Loading…</div>`);
  const c = esc(ad.currency || cur());
  const paused = ad.is_paused || ad.status === 'on_hold';
  const reason = ad.decline_reason ? `<div class="note gap"><b>Declined:</b> ${esc(ad.decline_reason.text)}<div class="small">${esc(plainText(ad.decline_reason.description_html))}</div></div>` : '';
  d.body.innerHTML = `
    <h2>${esc(ad.title)} <span class="muted small">#${ad.ad_id}</span> ${stBadge(ad.status)}</h2>
    <div class="muted small">${esc(ad.placement || '')} · created ${esc(dt(ad.created_date))} · <a href="${esc(ad.promote_url)}" target="_blank" rel="noopener noreferrer">${esc(ad.promote_url)}</a></div>
    ${reason}
    <div class="kpis gap">
      <div class="kpi"><div class="l">Views</div><div class="v">${nf(ad.views)}</div></div><div class="kpi"><div class="l">Clicks</div><div class="v">${nf(ad.clicks)}</div></div>
      <div class="kpi"><div class="l">Actions</div><div class="v">${nf(ad.actions)}</div></div><div class="kpi"><div class="l">CTR</div><div class="v">${pct(ad.ctr)}</div></div>
      <div class="kpi"><div class="l">CVR</div><div class="v">${pct(ad.cvr)}</div></div><div class="kpi"><div class="l">CPA</div><div class="v">${money(ad.cpa, 3)}</div></div>
      <div class="kpi"><div class="l">Spent</div><div class="v">${money(ad.spent_budget)} <span class="small muted">${c}</span></div></div><div class="kpi"><div class="l">Budget left</div><div class="v">${money(ad.remaining_budget)}</div></div>
    </div>
    <div class="row">
      <button class="btn" data-a="${paused ? 'resume' : 'pause'}">${paused ? '▶ Resume' : '⏸ Pause'}</button>
      <button class="btn" data-a="submit">Submit for review</button>
      <button class="btn" data-a="add_budget">+ Budget</button><button class="btn" data-a="remove_budget">− Budget</button>
      <button class="btn" data-a="dup">⎘ Duplicate</button><button class="btn danger" data-a="delete">Delete</button>
    </div>
    <h3 class="gap">Edit</h3>
    <div class="form-grid" id="edForm">
      <label class="f span2"><span>Title</span><input type="text" name="title" value="${esc(ad.title)}"></label>
      <label class="f full"><span>Text (<span id="edCount"></span>/160)</span><textarea name="text" style="font-family:inherit">${esc(ad.text || '')}</textarea></label>
      <label class="f span2"><span>Promote URL</span><input type="text" name="promote_url" value="${esc(ad.promote_url || '')}"></label>
      <label class="f"><span>CPM (${c})</span><input type="number" step="0.01" name="cpm" value="${esc(ad.cpm)}"></label>
      <label class="f"><span>Daily budget limit (0 = none)</span><input type="number" step="0.01" name="daily_budget_limit" value="${esc(ad.daily_budget_limit ?? 0)}"></label>
      <label class="f"><span>Impressions / user / day (1-4)</span><input type="number" min="1" max="4" name="impression_frequency" value="${esc(ad.impression_frequency ?? '')}"></label>
      <label class="f"><span>Website name</span><input type="text" name="website_name" value="${esc(ad.website_name || '')}"></label>
      <label class="f"><span>Button</span><select name="button"><option value="">(default)</option>${['subscribe', 'view', 'read', 'learn_more', 'download', 'open', 'sign_up', 'buy', 'order', 'play', 'try', 'leave_request'].map((b) => `<option ${ad.button === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
      <label class="chk"><input type="checkbox" name="show_userpic" ${ad.show_userpic ? 'checked' : ''}> Show channel picture (+30% CPM)</label>
    </div>
    <div class="row gap"><button class="btn primary" id="edSave">Save changes</button><span class="hint">Changing an ad sends it to review again.</span></div>
    <h3 class="gap">Stats (daily, last 14 days)</h3><canvas class="chart" id="adChart"></canvas><div id="adLegend"></div>
    <h3 class="gap">Targeting</h3><pre>${esc(JSON.stringify(ad.target || {}, null, 2))}</pre>
    <details class="gap"><summary class="muted">Raw ad JSON</summary><pre>${esc(JSON.stringify(ad, null, 2))}</pre></details>`;
  const cnt = () => { $('#edCount', d.body).textContent = [...$('[name=text]', d.body).value].length; };
  $('[name=text]', d.body).oninput = cnt; cnt();
  const refresh = () => { d.close(); if (S.currentPage === 'ads') S.pages.ads.reload && S.pages.ads.reload(); };

  $$('[data-a]', d.body).forEach((b) => { b.onclick = () => busy(b, async () => {
    const a = b.dataset.a;
    if (a === 'dup') { const r = await api(`/api/ads/${adId}/row`); handoff.set('createRow', r.row); d.close(); return go('create'); }
    if (a === 'delete') { if (!(await confirmBox(`Delete "${ad.title}"? Ads must be inactive for 10 minutes. This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return; }
    let amount;
    if (a === 'add_budget' || a === 'remove_budget') { amount = await promptBox(`${a === 'add_budget' ? 'Add' : 'Remove'} budget (${ad.currency || ''})`, '1', { type: 'number' }); if (!amount) return; }
    const r = await api('/api/ads/action', { method: 'POST', body: { ids: [adId], action: a, amount } });
    if (!r.results[0].ok) throw new Error(r.results[0].error);
    toast('Done', 'good'); refresh();
  }); });

  $('#edSave', d.body).onclick = (e) => busy(e.target, async () => {
    const fields = {};
    const val = (n) => $(`[name=${n}]`, d.body);
    for (const n of ['title', 'text', 'promote_url', 'website_name', 'button']) { const v = val(n).value; if (v !== (ad[n] || '')) fields[n] = v; }
    for (const n of ['cpm', 'daily_budget_limit', 'impression_frequency']) { const v = val(n).value; if (v !== '' && Number(v) !== Number(ad[n] ?? '')) fields[n] = Number(v); }
    const sp = val('show_userpic').checked; if (sp !== !!ad.show_userpic) fields.show_userpic = sp;
    if (!Object.keys(fields).length) return toast('No changes');
    const r = await api('/api/ads/action', { method: 'POST', body: { ids: [adId], action: 'edit', fields } });
    if (!r.results[0].ok) throw new Error(r.results[0].error);
    toast('Saved', 'good'); refresh();
  });

  api(`/api/ads/${adId}/stats?interval=86400`).then((st) => {
    const labels = st.map((x) => new Date(x.from_time * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    const series = [{ name: 'Views', color: PALETTE[0], data: st.map((x) => x.views) }, { name: 'Clicks', color: PALETTE[1], data: st.map((x) => x.clicks) }, { name: 'Actions', color: PALETTE[2], data: st.map((x) => x.actions) }];
    drawChart($('#adChart', d.body), labels, series); $('#adLegend', d.body).innerHTML = legend(series);
  }).catch(() => { $('#adChart', d.body).replaceWith(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Stats not available.' })); });
}

pageRegister('ads', {
  title: 'Ads', icon: '▤',
  async render(view) {
    const pre = handoff.take('adsFilter') || {};
    view.innerHTML = `
      <div class="row">
        <input type="text" id="q" placeholder="Search title / URL…" style="max-width:260px" value="${esc(pre.q || '')}">
        <select id="stf"><option value="">All statuses</option>${['active', 'in_review', 'ready_for_review', 'on_hold', 'declined', 'stopped'].map((s) => `<option value="${s}" ${pre.status === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="withT"> show targeting</label>
        <span class="grow"></span>
        <span class="muted small" id="fetched"></span>
        <button class="btn" id="reload">↻ Refresh</button>
        <button class="btn" id="csv">Export CSV</button>
        <button class="btn" id="toSheet">Export to Google Sheet</button>
        <button class="btn primary" id="newAd">+ New ad</button>
      </div>
      <div id="tbl" class="gap"></div>
      <div id="bar" class="bar hidden"></div>`;
    let all = []; let withT = false;
    const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const ratio = (a, b, m = 1) => (b > 0 ? (a / b) * m : null);
    const cols = () => [
      { k: 'title', t: 'Title', cls: 'wrap', html: (r) => `<b>${esc(r.title)}</b><div class="muted small">#${r.ad_id}${r.is_paused ? ' · paused' : ''}</div>` },
      { k: 'status', t: 'Status', html: (r) => stBadge(r.status) },
      ...(withT ? [{ k: 'target_summary', t: 'Target', cls: 'wrap' }] : []),
      { k: 'views', t: 'Views', num: true, total: (R) => sum(R, 'views') }, { k: 'clicks', t: 'Clicks', num: true, total: (R) => sum(R, 'clicks') }, { k: 'actions', t: 'Actions', num: true, total: (R) => sum(R, 'actions') },
      { k: 'ctr', t: 'CTR', num: true, html: (r) => pct(r.ctr), total: (R) => ratio(sum(R, 'clicks'), sum(R, 'views'), 100), totalHtml: pct }, { k: 'cvr', t: 'CVR', num: true, html: (r) => pct(r.cvr), total: (R) => ratio(sum(R, 'actions'), sum(R, 'clicks'), 100), totalHtml: pct },
      { k: 'cpm', t: 'CPM', num: true, html: (r) => money(r.cpm, 2) }, { k: 'cpc', t: 'CPC', num: true, html: (r) => money(r.cpc, 4), total: (R) => ratio(sum(R, 'spent_budget'), sum(R, 'clicks')), totalHtml: (v) => money(v, 4) },
      { k: 'cpa', t: 'CPA', num: true, html: (r) => money(r.cpa, 3), total: (R) => ratio(sum(R, 'spent_budget'), sum(R, 'actions')), totalHtml: (v) => money(v, 3) }, { k: 'spent_budget', t: 'Spent', num: true, html: (r) => money(r.spent_budget), total: (R) => sum(R, 'spent_budget'), totalHtml: (v) => money(v) },
      { k: 'remaining_budget', t: 'Left', num: true, html: (r) => money(r.remaining_budget), total: (R) => sum(R, 'remaining_budget'), totalHtml: (v) => money(v) }, { k: 'daily_budget_limit', t: 'Daily cap', num: true, html: (r) => (r.daily_budget_limit ? money(r.daily_budget_limit) : '–') },
      { k: 'created_date', t: 'Created', html: (r) => esc(dt(r.created_date)) },
    ];
    let table;
    const build = () => { table = dataTable($('#tbl', view), { cols: cols(), rowKey: 'ad_id', selectable: true, sortKey: 'created_date', onRow: (r) => openAd(r.ad_id), onSelect: renderBar, empty: 'No ads match.', filters: true, totals: true }); applyFilter(); };
    function applyFilter() {
      const q = $('#q', view).value.trim().toLowerCase(); const st = $('#stf', view).value;
      table.set(all.filter((a) => (!st || a.status === st) && (!q || `${a.title} ${a.promote_url} ${a.text}`.toLowerCase().includes(q))));
    }
    function renderBar(sel) {
      const bar = $('#bar', view);
      if (!sel.length) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      bar.innerHTML = `<b>${sel.length} selected</b>
        <button class="btn sm" data-b="pause">⏸ Pause</button><button class="btn sm" data-b="resume">▶ Resume</button><button class="btn sm" data-b="submit">Submit for review</button>
        <button class="btn sm" data-b="add_budget">+ Budget</button><button class="btn sm" data-b="remove_budget">− Budget</button>
        <button class="btn sm" data-b="set_cpm">Set CPM</button><button class="btn sm" data-b="set_daily_limit">Daily cap</button><button class="btn sm" data-b="set_frequency">Frequency</button>
        <button class="btn sm danger" data-b="delete">Delete</button><span class="grow"></span><button class="btn sm" data-b="clear">Clear</button>`;
      $$('[data-b]', bar).forEach((b) => { b.onclick = () => bulkAction(b.dataset.b, sel, b); });
    }
    async function bulkAction(a, sel, btn) {
      if (a === 'clear') return table.clearSelection();
      const body = { ids: sel.map((x) => x.ad_id), action: a };
      const ask = { add_budget: ['Add budget to each ad', 'amount'], remove_budget: ['Remove budget from each ad', 'amount'], set_cpm: ['New CPM', 'cpm'], set_daily_limit: ['Daily budget limit (0 = none)', 'daily_budget_limit'], set_frequency: ['Impressions per user per day (1-4)', 'impression_frequency'] }[a];
      if (ask) { const v = await promptBox(`${ask[0]} (${sel.length} ads)`, '', { type: 'number' }); if (v === null || v === '') return; body[ask[1]] = Number(v); }
      if (a === 'delete' && !(await confirmBox(`Delete ${sel.length} ads? They must be inactive for 10 minutes. This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
      if (['pause', 'resume', 'submit', 'add_budget', 'remove_budget'].includes(a) && sel.length > 5 && !(await confirmBox(`Apply "${a}" to ${sel.length} ads?`))) return;
      await busy(btn, async () => {
        const r = await api('/api/ads/action', { method: 'POST', body });
        const bad = r.results.filter((x) => !x.ok);
        toast(bad.length ? `${r.results.length - bad.length} done, ${bad.length} failed: ${bad[0].error}` : `Done for ${r.results.length} ads`, bad.length ? 'bad' : 'good');
        await load(true);
      });
    }
    async function load(force) {
      const r = await getAds({ target: withT, refresh: force });
      all = r.ads; $('#fetched', view).textContent = `updated ${new Date(r.fetchedAt).toLocaleTimeString()}`;
      applyFilter();
    }
    S.pages.ads.reload = () => load(true);
    $('#q', view).oninput = applyFilter; $('#stf', view).onchange = applyFilter;
    $('#withT', view).onchange = async (e) => { withT = e.target.checked; build(); await load(true).catch(fail); };
    $('#reload', view).onclick = (e) => busy(e.target, () => load(true));
    $('#newAd', view).onclick = () => go('create');
    $('#csv', view).onclick = () => { const rows = table.rows(); const keys = ['ad_id', 'title', 'status', 'placement', 'views', 'clicks', 'actions', 'ctr', 'cvr', 'cpm', 'cpc', 'cpa', 'spent_budget', 'remaining_budget', 'daily_budget_limit', 'promote_url', 'text']; download(`telegram-ads-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, keys)); };
    $('#toSheet', view).onclick = async (e) => {
      const url = await promptBox('Google Sheet link', localStorage.getItem('tga_sheet') || '', { hint: 'Share the sheet with your service-account email (Settings) as Editor. A tab named "Telegram Ads" is created / replaced.' });
      if (!url) return; localStorage.setItem('tga_sheet', url);
      await busy(e.target, async () => { const r = await api('/api/sheets/export-ads', { method: 'POST', body: { url } }); toast(`Exported ${r.rows} ads`, 'good'); });
    };
    build(); await load(false);
  },
});

// ======================================================= Create ad
const TARGET_TYPES = { channels: 'Channels (by list, topics or languages)', users: 'Users (country, interests, device, audiences)', bots: 'Bots', search: 'Search queries' };
const FIELD_DEFS = [
  // [key, label, kind, forTypes(null=all), span, hint, options]
  ['title', 'Ad title (only you see it)', 'text', null, 2],
  ['target_type', 'Targeting type', 'select', null, 1, '', Object.keys(TARGET_TYPES)],
  ['placement', 'Placement', 'select', null, 1, 'Auto = based on targeting type', ['', 'channel_post', 'bot_banner', 'search_result', 'video_banner']],
  ['text', 'Ad text (max 160 characters)', 'textarea', ['channels', 'users', 'bots'], 4, 'Not needed for search ads.'],
  ['promote_url', 'Link to promote (t.me channel / post / bot, or website)', 'text', null, 2],
  ['cpm', 'CPM (price per 1000 views)', 'number', null, 1, 'Photos need +50-80%, videos +70-100% CPM'],
  ['button', 'Button (external links only)', 'select', null, 1, '', ['', 'subscribe', 'view', 'read', 'learn_more', 'download', 'open', 'sign_up', 'buy', 'order', 'play', 'try', 'leave_request']],
  ['channels', 'Channels (one per line: @name or t.me link)', 'textarea', ['channels'], 2, 'Up to 100 including excluded. Leave empty to use topics / languages.'],
  ['exclude_channels', 'Exclude channels', 'textarea', ['channels', 'users'], 2],
  ['topics', 'Topics (names or ids)', 'lookup:topics', ['channels', 'users'], 2, 'Channels: needs exactly one language when topics are used.'],
  ['exclude_topics', 'Exclude topics', 'lookup:topics', ['channels', 'users'], 2],
  ['languages', 'Languages (codes or names)', 'lookup:languages', ['channels', 'users'], 2, 'Channel language (channels) or user language (users)'],
  ['countries', 'Countries (codes or names, max 8)', 'lookup:countries', ['users'], 2],
  ['locations', 'Location ids (needs exactly one country)', 'text', ['users'], 2, 'Find ids on the Targeting lookup page'],
  ['device', 'Device', 'select', ['users'], 1, '', ['', 'ios', 'android', 'mobile', 'desktop']],
  ['audiences', 'Audience ids (retargeting)', 'text', ['users'], 1],
  ['exclude_audiences', 'Exclude audience ids', 'text', ['users'], 1],
  ['intersect_topics', 'Users must match ALL interests', 'check', ['users'], 2],
  ['exclude_political_channels', 'Do not show in political channels', 'check', ['users'], 2],
  ['political_channels_only', 'Political channels only', 'check', ['users'], 2],
  ['bots', 'Bots (one per line: @botname)', 'textarea', ['bots'], 4],
  ['search_queries', 'Search keywords / phrases (max 10, one per line)', 'textarea', ['search'], 4],
  ['initial_budget', 'Starting budget (taken from account)', 'number', null, 1, 'Ads with 0 budget stay "ready for review" until funded'],
  ['daily_budget_limit', 'Daily budget limit (0 = none)', 'number', null, 1],
  ['impression_frequency', 'Views per user per day (1-4)', 'number', null, 1],
  ['is_paused', 'Create paused', 'check', null, 1],
  ['activate_date', 'Start at (your local time)', 'datetime-local', null, 1],
  ['deactivate_date', 'Stop at (your local time)', 'datetime-local', null, 1],
  ['schedule_hours', 'Show only in hours (e.g. 10-23 or 9-12,18-23)', 'text', null, 1],
  ['schedule_days', 'Days (1=Mon … 7=Sun, e.g. 1-5)', 'text', null, 1],
  ['schedule_tz', 'Schedule time zone (UTC offset like 5.5, or "viewer")', 'text', null, 1],
  ['website_name', 'Website name (required for non-Telegram links)', 'text', null, 1],
  ['additional_info', 'Advertiser info line (max 64)', 'text', null, 1],
  ['show_userpic', 'Show channel/bot picture (+30% CPM)', 'check', null, 1],
  ['conversion_event_id', 'Pixel event id (website conversions)', 'text', null, 1],
  ['photo_id', 'Photo id', 'media:photo', ['channels', 'users'], 1, 'Upload below, or paste an existing id'],
  ['video_id', 'Video id', 'media:video', ['channels', 'users'], 1],
  ['website_photo_id', 'Website photo id', 'media:website', null, 1],
  ['photo_url', 'Or photo URL (uploaded automatically)', 'text', ['channels', 'users'], 2],
  ['video_url', 'Or video URL (uploaded automatically)', 'text', ['channels', 'users'], 2],
];

/** Builds the ad form. Returns {el, get(), set(row)} */
function adForm(host, prefill = {}) {
  const field = ([k, label, kind, types, span, hint, opts]) => {
    const forAttr = types ? `data-for="${types.join(' ')}"` : '';
    const sp = span === 4 ? 'full' : span === 2 ? 'span2' : '';
    if (kind === 'check') return `<label class="chk ${sp}" ${forAttr}><input type="checkbox" name="${k}"> ${esc(label)}</label>`;
    let input;
    if (kind === 'textarea') input = `<textarea name="${k}" ${k === 'text' ? 'style="font-family:inherit" maxlength="400"' : ''}></textarea>`;
    else if (kind === 'select') input = `<select name="${k}">${opts.map((o) => `<option value="${esc(o)}">${esc(o ? (TARGET_TYPES[o] ? TARGET_TYPES[o] : o) : '(auto)')}</option>`).join('')}</select>`;
    else if (kind.startsWith('lookup:')) input = `<div class="row" style="flex-wrap:nowrap"><textarea name="${k}" style="min-height:40px;height:40px"></textarea><button type="button" class="btn sm" data-lookup="${kind.slice(7)}" data-for-field="${k}">Browse</button></div>`;
    else if (kind.startsWith('media:')) input = `<div class="row" style="flex-wrap:nowrap"><input type="text" name="${k}"><label class="btn sm" style="margin:0">Upload<input type="file" hidden data-upload="${kind.slice(6)}" data-for-field="${k}" accept="${kind === 'media:video' ? 'video/mp4' : 'image/png,image/jpeg'}"></label></div>`;
    else input = `<input type="${kind}" name="${k}" ${kind === 'number' ? 'step="any" min="0"' : ''}>`;
    return `<label class="f ${sp}" ${forAttr}><span>${esc(label)}${k === 'text' ? ' · <span id="txtCount">0</span>/160' : ''}</span>${input}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
  };
  host.innerHTML = `<div class="form-grid">${FIELD_DEFS.map(field).join('')}</div>`;
  const q = (n) => $(`[name="${n}"]`, host);
  const sync = () => {
    const t = q('target_type').value;
    $$('[data-for]', host).forEach((el) => el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(t)));
    const len = [...(q('text').value || '')].length; const c = $('#txtCount', host); if (c) { c.textContent = len; c.style.color = len > 160 ? 'var(--bad)' : ''; }
  };
  q('target_type').onchange = sync; q('text').oninput = sync;

  $$('[data-lookup]', host).forEach((b) => { b.onclick = () => lookupPicker(b.dataset.lookup, (vals) => { const t = q(b.dataset.forField); t.value = [t.value.trim(), ...vals].filter(Boolean).join(', '); }); });
  $$('[data-upload]', host).forEach((inp) => { inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { toast('Uploading…'); const r = await api('/api/upload', { method: 'POST', body: { kind: inp.dataset.upload, filename: f.name, mime: f.type, dataBase64: await readB64(f) } });
      q(inp.dataset.forField).value = r.photo_id || r.video_id; toast('Uploaded', 'good'); (r.notes || []).forEach((n) => toast(n, 'warn', 9000)); } catch (e) { fail(e); }
    inp.value = '';
  }; });

  const api2 = {
    el: host,
    get() {
      const row = {};
      $$('[name]', host).forEach((el) => {
        const k = el.name;
        if (el.type === 'checkbox') { if (el.checked) row[k] = true; return; }
        let v = el.value.trim(); if (v === '') return;
        if (el.type === 'datetime-local') v = new Date(v).toISOString();
        row[k] = v;
      });
      return row;
    },
    set(row) {
      $$('[name]', host).forEach((el) => {
        const v = row[el.name];
        if (el.type === 'checkbox') el.checked = v === true || v === 'true' || v === 'TRUE';
        else el.value = v === undefined || v === null ? '' : String(v);
      });
      sync();
    },
  };
  api2.set({ target_type: 'channels', ...prefill });
  return api2;
}

/** Modal to browse topics / languages / countries and pick several. */
async function lookupPicker(kind, onPick) {
  const list = await api(`/api/targets/${kind}`).catch(fail);
  if (!list) return;
  const idKey = { topics: 'topic_id', languages: 'language_code', countries: 'country_code' }[kind];
  const m = modal({ title: `Pick ${kind}`, wide: false, body: `<input type="text" id="lkQ" placeholder="Filter…"><div id="lkList" class="gap" style="max-height:50vh;overflow:auto"></div>`, buttons: [
    { label: 'Cancel', onClick: () => {} },
    { label: 'Add selected', cls: 'primary', onClick: ({ el }) => { const vals = $$('[data-v]:checked', el).map((c) => c.dataset.label); onPick(vals); } },
  ] });
  const draw = () => {
    const f = $('#lkQ', m.el).value.toLowerCase();
    $('#lkList', m.el).innerHTML = list.filter((x) => !f || `${x.name} ${x[idKey]}`.toLowerCase().includes(f)).map((x) => `<label class="chk" style="padding:3px 0"><input type="checkbox" data-v="${esc(x[idKey])}" data-label="${esc(x.name)}"> ${esc(x.name)} <span class="muted small">${esc(x[idKey])}</span></label>`).join('');
  };
  $('#lkQ', m.el).oninput = draw; draw();
}

pageRegister('create', {
  title: 'Create ad', icon: '＋',
  async render(view) {
    view.innerHTML = `
      <div class="note info">Fill the form, press <b>Check</b> to see exactly what will be sent, then <b>Create</b>. Need many ads? Use <b>Batch builder</b> or <b>Bulk create</b> in the sidebar.</div>
      <div class="card gap"><div id="formHost"></div></div>
      <div class="row">
        <button class="btn" id="resolve">Resolve channels / bots</button>
        <span class="grow"></span>
        <button class="btn" id="check">Check</button>
        <button class="btn primary" id="create">Create ad</button>
      </div>
      <div id="out" class="gap"></div>`;
    const pre = handoff.take('createRow');
    const form = adForm($('#formHost', view), pre || {});
    if (pre) toast('Form filled from the duplicated ad. Change the title and targeting, then create.');
    const out = $('#out', view);

    const preview = async () => {
      const row = form.get();
      console.log('[cpm] 1 form input:', JSON.stringify(row.cpm), typeof row.cpm);
      const r = await api('/api/bulk/preview', { method: 'POST', body: { rows: [row] } });
      const p = r.rows[0];
      console.log('[cpm] 3 payload from server:', JSON.stringify(p.payload.cpm), typeof p.payload.cpm);
      out.innerHTML = `<div class="card"><h2>${p.valid ? '<span class="ok">✓ Ready to create</span>' : '<span class="bad">✗ Fix these first</span>'}</h2>
        ${p.errors.length ? `<ul class="bad">${p.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${p.warnings.length ? `<ul class="warn">${p.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <details ${p.valid ? '' : 'open'}><summary class="muted">Payload sent to the API</summary><pre>${esc(JSON.stringify(p.payload, null, 2))}</pre></details></div>`;
      return p;
    };
    $('#check', view).onclick = (e) => busy(e.target, preview);
    $('#resolve', view).onclick = (e) => busy(e.target, async () => {
      const row = form.get();
      const kind = row.target_type === 'bots' ? 'bot' : 'channel';
      const list = kind === 'bot' ? row.bots : [row.channels, row.exclude_channels].filter(Boolean).join('\n');
      if (!list) return toast('Add channels or bots first');
      const r = await api('/api/channels/resolve', { method: 'POST', body: { list, kind } });
      out.innerHTML = `<div class="card"><h2>Resolved ${r.found.length} of ${r.total}</h2>
        ${r.missing.length ? `<p class="bad">Not found: ${r.missing.map((m) => esc(`${m.value} (${m.error})`)).join(', ')}</p>` : '<p class="ok">All found.</p>'}
        ${r.invalid.length ? `<p class="warn">Invalid names ignored: ${r.invalid.map(esc).join(', ')}</p>` : ''}
        ${r.found.length ? `<div class="tablewrap"><table><thead><tr><th>Title</th><th>Username</th><th>Id</th></tr></thead><tbody>${r.found.map((c) => `<tr><td>${esc(c.title)}</td><td>${esc(c.username ? '@' + c.username : '')}</td><td>${esc(c.channel_id || c.bot_id)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
      toast('Resolving also unlocks numeric ids for this account');
    });
    $('#create', view).onclick = (e) => busy(e.target, async () => {
      const p = await preview();
      if (!p.valid) return;
      const row = form.get();
      const budget = Number(row.initial_budget || 0);
      if (!(await confirmBox(`Create "${row.title}"${budget ? ` with a starting budget of ${budget} ${cur()}` : ' with no budget'}?`, { okLabel: 'Create' }))) return;
      const { jobId } = await api('/api/bulk/run', { method: 'POST', body: { rows: [row], options: { delayMs: 0 } } });
      const job = await pollJob(jobId, () => {});
      const r = job.results[0];
      if (r.ok) { toast(`Created ad #${r.ad_id} (${r.status})`, 'good'); out.innerHTML += `<div class="card"><span class="ok">Created ad #${r.ad_id}, status: ${esc(r.status)}.</span> <a href="#/ads">Open ads list</a></div>`; }
      else { out.innerHTML += `<div class="card bad">Failed: ${esc(r.error)}</div>`; }
    });
  },
});
