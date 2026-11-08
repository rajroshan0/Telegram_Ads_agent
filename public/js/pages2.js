'use strict';
/* Bulk create, Batch builder, Overlap checker, Stats */

// ======================================================= Bulk create
pageRegister('bulk', {
  title: 'Bulk create', icon: '☰',
  async render(view) {
    const B = { rows: handoff.take('bulkRows') || [], preview: null, results: [], sheetUrl: localStorage.getItem('tga_sheet') || '' };
    view.innerHTML = `
      <div class="note info">Create many ads at once. Every row = one ad. Columns are the same fields as the Create form. <a href="/api/bulk/template" download>Download the CSV template</a> · Works with Excel, Google Sheets and CSV.</div>
      <div class="card gap">
        <div class="tabs" id="tabs"><button data-t="paste" class="on">Paste CSV</button><button data-t="file">Upload file</button><button data-t="sheet">Google Sheet</button></div>
        <div id="srcPaste"><textarea id="csvText" placeholder="title,text,promote_url,cpm,channels,initial_budget&#10;bazi_A_b1,Free tips,https://t.me/mychan,1,&quot;@ch1&#10;@ch2&quot;,3" style="min-height:140px"></textarea></div>
        <div id="srcFile" class="hidden"><input type="file" id="csvFile" accept=".csv,.tsv,.txt"><div class="hint gap">In Excel / Google Sheets: File → Download → CSV.</div></div>
        <div id="srcSheet" class="hidden"><input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(B.sheetUrl)}"><div class="hint gap">Public "anyone with the link" sheets work as they are. Private sheets: share with your service-account email (Settings). The first row must be column names.</div></div>
        <div class="row gap"><button class="btn" id="load">Load rows</button><span id="loaded" class="muted"></span></div>
      </div>
      <div class="card"><h3>Options</h3>
        <div class="row">
          <label class="chk"><input type="checkbox" id="oPause"> Create all ads paused</label>
          <label class="chk"><input type="checkbox" id="oSubmit" checked> Submit ads without budget for review automatically</label>
          <label class="chk"><input type="checkbox" id="oResolve" checked> Convert topic / language / country names to ids</label>
          <label class="f" style="flex-direction:row;align-items:center;gap:6px"><span>Pause between ads (ms)</span><input type="number" id="oDelay" value="400" style="width:90px"></label>
        </div>
        <div class="row gap"><button class="btn" id="validate">1 · Validate</button><button class="btn primary" id="run" disabled>2 · Create valid ads</button><span id="sum" class="muted"></span></div>
      </div>
      <div id="prevBox"></div><div id="runBox"></div>`;
    const $v = (s) => $(s, view);
    const show = (t) => { $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === t)); $v('#srcPaste').classList.toggle('hidden', t !== 'paste'); $v('#srcFile').classList.toggle('hidden', t !== 'file'); $v('#srcSheet').classList.toggle('hidden', t !== 'sheet'); };
    $$('#tabs button', view).forEach((b) => { b.onclick = () => show(b.dataset.t); });
    const setRows = (rows, label) => { B.rows = rows; B.preview = null; $v('#loaded').textContent = rows.length ? `${rows.length} rows loaded ${label || ''}` : 'No rows found'; $v('#run').disabled = true; $v('#prevBox').innerHTML = ''; $v('#sum').textContent = ''; };
    if (B.rows.length) setRows(B.rows, '(from Batch builder)');

    $v('#load').onclick = (e) => busy(e.target, async () => {
      const active = $('#tabs .on', view).dataset.t;
      if (active === 'paste') setRows((await api('/api/csv/parse', { method: 'POST', body: { csv: $v('#csvText').value } })).rows);
      else if (active === 'file') { const f = $v('#csvFile').files[0]; if (!f) return toast('Choose a file'); setRows((await api('/api/csv/parse', { method: 'POST', body: { csv: await readText(f) } })).rows, `from ${f.name}`); }
      else { const url = $v('#sheetUrl').value.trim(); if (!url) return toast('Paste the sheet link'); localStorage.setItem('tga_sheet', url); B.sheetUrl = url; setRows((await api('/api/sheets/read', { method: 'POST', body: { url } })).rows, 'from Google Sheet'); }
    });
    const opts = () => ({ pauseAfterCreate: $v('#oPause').checked, submitForReview: $v('#oSubmit').checked, resolve: $v('#oResolve').checked, delayMs: Number($v('#oDelay').value) || 0 });

    $v('#validate').onclick = (e) => busy(e.target, async () => {
      if (!B.rows.length) return toast('Load rows first');
      const r = await api('/api/bulk/preview', { method: 'POST', body: { rows: B.rows, options: opts() } });
      B.preview = r;
      const budget = r.rows.filter((x) => x.valid).reduce((a, x) => a + (Number(x.payload.initial_budget) || 0), 0);
      let bal = null; try { bal = (await api('/api/account')).remaining_budget; } catch (_) { /* ignore */ }
      $v('#sum').innerHTML = `<b class="ok">${r.valid} valid</b>, <b class="${r.invalid ? 'bad' : ''}">${r.invalid} with errors</b> · total starting budget <b>${money(budget)} ${esc(cur())}</b>${bal !== null ? ` of ${money(bal)} available` : ''}${bal !== null && budget > bal ? ' <b class="bad">— not enough balance</b>' : ''}`;
      $v('#run').disabled = r.valid === 0;
      $v('#prevBox').innerHTML = `<div class="card"><h2>Validation</h2><div id="pvTbl"></div></div>`;
      dataTable($v('#pvTbl'), { cols: [
        { k: 'index', t: '#', html: (x) => String(x.index + 1) }, { k: 'title', t: 'Title' }, { k: 'valid', t: 'OK', html: (x) => (x.valid ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') },
        { k: 'type', t: 'Target', html: (x) => esc(x.payload.target ? x.payload.target.type : ''), val: (x) => (x.payload.target ? x.payload.target.type : '') },
        { k: 'n', t: 'Channels', num: true, html: (x) => nf(((x.payload.target || {}).channel_ids || []).length), val: (x) => ((x.payload.target || {}).channel_ids || []).length },
        { k: 'cpm', t: 'CPM', num: true, html: (x) => money(x.payload.cpm) , val: (x) => x.payload.cpm }, { k: 'b', t: 'Budget', num: true, html: (x) => money(x.payload.initial_budget || 0), val: (x) => x.payload.initial_budget || 0 },
        { k: 'msg', t: 'Problems / notes', cls: 'wrap', html: (x) => `${x.errors.map((m) => `<div class="bad">${esc(m)}</div>`).join('')}${x.warnings.map((m) => `<div class="warn">${esc(m)}</div>`).join('')}` },
      ], rowKey: 'index', sortKey: 'index', sortDir: 'asc', onRow: (x) => modal({ title: x.title || `Row ${x.index + 1}`, wide: true, body: `<pre>${esc(JSON.stringify({ payload: x.payload, media: x.media }, null, 2))}</pre>` }) }).set(r.rows);
    });

    $v('#run').onclick = async (e) => {
      if (!B.preview) return;
      const goodIdx = B.preview.rows.filter((x) => x.valid).map((x) => x.index);
      const budget = B.preview.rows.filter((x) => x.valid).reduce((a, x) => a + (Number(x.payload.initial_budget) || 0), 0);
      if (!(await confirmBox(`Create ${goodIdx.length} ads${B.preview.invalid ? ` (skipping ${B.preview.invalid} with errors)` : ''}?\nStarting budget in total: ${money(budget)} ${cur()}${$v('#oPause').checked ? '\nAds will be created paused.' : ''}`, { okLabel: `Create ${goodIdx.length} ads` }))) return;
      const rows = goodIdx.map((i) => B.rows[i]);
      await busy(e.target, async () => {
        const { jobId } = await api('/api/bulk/run', { method: 'POST', body: { rows, options: opts() } });
        $v('#runBox').innerHTML = `<div class="card"><h2>Creating…</h2><div class="progress"><div id="pg" style="width:0"></div></div><div id="pgTxt" class="muted gap"></div><div id="resTbl" class="gap"></div></div>`;
        const job = await pollJob(jobId, (j) => { $v('#pg').style.width = `${(j.done / j.total) * 100}%`; $v('#pgTxt').textContent = `${j.done} / ${j.total}`; });
        B.results = job.results.map((r) => ({ ...r, title: r.title }));
        const ok = B.results.filter((r) => r.ok).length; const bad = B.results.length - ok;
        $v('#runBox').innerHTML = `<div class="card"><h2>${bad ? `<span class="warn">Finished: ${ok} created, ${bad} failed</span>` : `<span class="ok">All ${ok} ads created</span>`}</h2>
          <div class="row"><button class="btn" id="expRes">Export results CSV</button><button class="btn" id="resSheet">Write to Google Sheet</button>${bad ? '<button class="btn" id="retry">Retry failed</button>' : ''}<a class="btn" href="#/ads">Open ads</a></div><div id="resTbl" class="gap"></div></div>`;
        dataTable($v('#resTbl'), { cols: [
          { k: 'index', t: '#', html: (r) => String(r.index + 1) }, { k: 'title', t: 'Title' }, { k: 'ok', t: 'Result', html: (r) => (r.ok ? '<span class="ok">✓ created</span>' : `<span class="bad">✗ ${r.skipped ? 'skipped' : 'failed'}</span>`) },
          { k: 'ad_id', t: 'Ad id', html: (r) => (r.ad_id ? `<a href="#/ads" data-ad="${r.ad_id}">#${r.ad_id}</a>` : '') }, { k: 'status', t: 'Status', html: (r) => (r.status ? stBadge(r.status) : '') },
          { k: 'error', t: 'Error / notes', cls: 'wrap', html: (r) => `${r.error ? `<span class="bad">${esc(r.error)}</span>` : ''}${(r.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}` },
        ], rowKey: 'index', sortKey: 'index', sortDir: 'asc' }).set(B.results);
        $v('#expRes').onclick = () => download('bulk-results.csv', toCSV(B.results, ['index', 'title', 'ok', 'ad_id', 'status', 'error']));
        $v('#resSheet').onclick = async (ev) => {
          const url = B.sheetUrl || await promptBox('Google Sheet link', '', { hint: 'A tab named "Bulk results" is created.' });
          if (!url) return;
          await busy(ev.target, async () => { await api('/api/sheets/write', { method: 'POST', body: { url, tab: 'Bulk results', mode: 'append', values: [['run_at', 'title', 'ok', 'ad_id', 'status', 'error'], ...B.results.map((r) => [new Date().toISOString(), r.title, r.ok, r.ad_id || '', r.status || '', r.error || ''])] } }); toast('Written to sheet', 'good'); });
        };
        const rt = $v('#retry'); if (rt) rt.onclick = () => { const failed = B.results.filter((r) => !r.ok && !r.skipped || r.skipped).map((r) => rows[r.index]); setRows(failed, '(failed rows)'); $v('#runBox').innerHTML = ''; window.scrollTo(0, 0); toast(`${failed.length} rows ready. Press Validate.`); };
      });
    };
  },
});

// ======================================================= Batch builder
pageRegister('batch', {
  title: 'Batch builder', icon: '▦',
  async render(view) {
    view.innerHTML = `
      <div class="note info"><b>Test plan builder.</b> Paste a long channel list. It is split into batches, and every batch runs with every creative (e.g. 3 creatives × 5 batches = 15 ads). Compare CPA per batch and per creative, keep the winners, stop the losers.</div>
      <div class="grid g2 gap">
        <div class="card"><h2>1 · Channels</h2>
          <textarea id="chs" placeholder="@channel1&#10;t.me/channel2&#10;…" style="min-height:220px"></textarea>
          <div class="row gap"><span id="chCount" class="muted"></span><span class="grow"></span><label class="chk"><input type="checkbox" id="avoid" checked> Skip channels already used by my ads</label></div>
          <div class="row gap"><label class="f"><span>Batch size (max 100)</span><input type="number" id="bsize" value="80" min="1" max="100" style="width:110px"></label>
            <label class="f"><span>Name prefix</span><input type="text" id="pfx" value="test" style="width:140px"></label>
            <label class="chk"><input type="checkbox" id="shuf"> Shuffle channels first</label></div>
          <div id="stBox" class="row gap"><span class="muted small">Count as "used" ads with status:</span>${['active', 'in_review', 'on_hold', 'ready_for_review', 'stopped', 'declined'].map((s) => `<label class="chk small"><input type="checkbox" class="ust" value="${s}" ${['active', 'in_review', 'on_hold', 'ready_for_review'].includes(s) ? 'checked' : ''}>${s.replace(/_/g, ' ')}</label>`).join('')}</div>
        </div>
        <div class="card"><h2>2 · Creatives</h2>
          <div id="crs"></div><button class="btn sm" id="addCr">+ Add creative</button>
          <h3 class="gap">3 · Shared settings</h3>
          <div class="form-grid">
            <label class="f span2"><span>Link to promote</span><input type="text" id="b_url" placeholder="https://t.me/yourchannel"></label>
            <label class="f"><span>CPM</span><input type="number" id="b_cpm" step="any" value="1"></label>
            <label class="f"><span>Budget per ad</span><input type="number" id="b_budget" step="any" value="3"></label>
            <label class="f"><span>Daily cap (0 = none)</span><input type="number" id="b_daily" step="any" value="0"></label>
            <label class="f"><span>Views / user / day</span><input type="number" id="b_freq" min="1" max="4" placeholder="1"></label>
            <label class="f"><span>Photo id (optional)</span><input type="text" id="b_photo"></label>
            <label class="f"><span>Hours (e.g. 10-23)</span><input type="text" id="b_hours"></label>
          </div>
        </div>
      </div>
      <div class="row"><button class="btn primary" id="plan">Build plan</button><span class="muted small">Nothing is created yet.</span></div>
      <div id="planBox" class="gap"></div>`;
    const crs = $('#crs', view);
    const addCr = (label = '', text = '') => {
      const n = $$('.cr', crs).length;
      const d = document.createElement('div'); d.className = 'cr card'; d.style.padding = '10px';
      d.innerHTML = `<div class="row"><label class="f" style="width:90px"><span>Label</span><input type="text" class="crl" value="${esc(label || String.fromCharCode(65 + n))}"></label><span class="grow"></span><button class="btn sm danger crx">Remove</button></div><label class="f gap"><span>Ad text (<span class="crc">0</span>/160)</span><textarea class="crt" style="font-family:inherit;min-height:64px">${esc(text)}</textarea></label>`;
      crs.appendChild(d);
      const t = $('.crt', d); const c = $('.crc', d); const u = () => { const l = [...t.value].length; c.textContent = l; c.style.color = l > 160 ? 'var(--bad)' : ''; };
      t.oninput = u; u(); $('.crx', d).onclick = () => d.remove();
    };
    addCr('A'); addCr('B'); addCr('C');
    $('#addCr', view).onclick = () => addCr();
    const cnt = () => { const n = $('#chs', view).value.split(/[\s,;]+/).filter(Boolean).length; $('#chCount', view).textContent = `${n} entries`; };
    $('#chs', view).oninput = cnt;

    $('#plan', view).onclick = (e) => busy(e.target, async () => {
      const creatives = $$('.cr', crs).map((d) => ({ label: $('.crl', d).value.trim(), text: $('.crt', d).value.trim() })).filter((c) => c.text);
      if (!creatives.length) return toast('Add at least one creative text');
      const base = { promote_url: $('#b_url', view).value.trim(), cpm: $('#b_cpm', view).value, initial_budget: $('#b_budget', view).value };
      if (Number($('#b_daily', view).value) > 0) base.daily_budget_limit = $('#b_daily', view).value;
      for (const [id, k] of [['b_freq', 'impression_frequency'], ['b_photo', 'photo_id'], ['b_hours', 'schedule_hours']]) { const v = $(`#${id}`, view).value.trim(); if (v) base[k] = v; }
      if (!base.promote_url) return toast('Add the link to promote');
      const r = await api('/api/batch/plan', { method: 'POST', body: { channels: $('#chs', view).value, batchSize: Number($('#bsize', view).value) || 80, namePrefix: $('#pfx', view).value || 'test', creatives, base, avoidUsed: $('#avoid', view).checked, statuses: $$('.ust:checked', view).map((x) => x.value), shuffle: $('#shuf', view).checked } });
      const totalBudget = r.rows.reduce((a, x) => a + (Number(x.initial_budget) || 0), 0);
      $('#planBox', view).innerHTML = `<div class="card"><h2>Plan: ${r.rows.length} ads = ${r.batches} batches × ${creatives.length} creatives</h2>
        <div class="muted">${r.totalChannels} channels used, ${r.removedAlreadyUsed} skipped because they were already used${r.usedChannelsInAccount ? ` (your account uses ${r.usedChannelsInAccount} channels)` : ''}${r.invalid.length ? `, ${r.invalid.length} invalid names ignored` : ''}. Total starting budget: <b>${money(totalBudget)} ${esc(cur())}</b>.</div>
        <div id="plTbl" class="gap"></div>
        <div class="row gap"><button class="btn primary" id="toBulk">Send to Bulk create →</button><button class="btn" id="plCsv">Download as CSV</button></div></div>`;
      dataTable($('#plTbl', view), { cols: [
        { k: 'title', t: 'Ad title' }, { k: 'n', t: 'Channels', num: true, html: (x) => nf(x.channels.split('\n').length), val: (x) => x.channels.split('\n').length },
        { k: 'text', t: 'Text', cls: 'wrap' }, { k: 'initial_budget', t: 'Budget', num: true, html: (x) => money(x.initial_budget) },
      ], rowKey: 'title', sortKey: 'title', sortDir: 'asc', onRow: (x) => modal({ title: x.title, body: `<pre>${esc(x.channels)}</pre>` }) }).set(r.rows);
      $('#toBulk', view).onclick = () => { handoff.set('bulkRows', r.rows); go('bulk'); };
      $('#plCsv', view).onclick = () => download('batch-plan.csv', toCSV(r.rows, [...new Set(r.rows.flatMap((x) => Object.keys(x)))]));
    });
  },
});

// ======================================================= Overlap checker
pageRegister('overlap', {
  title: 'Overlap checker', icon: '◍',
  async render(view) {
    view.innerHTML = `
      <div class="note info">Two ads aimed at the same channel bid against each other and push your CPM up. Use this page to see which channels are already in use, and to clean a new list before you build ads.</div>
      <div class="grid g2 gap">
        <div class="card"><h2>A · Check a new channel list</h2>
          <textarea id="ovList" placeholder="@channel1&#10;@channel2" style="min-height:160px"></textarea>
          <div class="row gap"><label class="chk"><input type="checkbox" id="ovStopped"> also count stopped / declined ads</label><span class="grow"></span><button class="btn primary" id="ovCheck">Check list</button></div>
          <div id="ovRes" class="gap"></div></div>
        <div class="card"><h2>B · Overlap inside my account</h2>
          <p class="muted">Finds channels that are targeted by 2 or more live ads.</p>
          <button class="btn primary" id="ovInt">Analyse my ads</button><div id="ovIntRes" class="gap"></div></div>
      </div>`;
    $('#ovCheck', view).onclick = (e) => busy(e.target, async () => {
      const statuses = $('#ovStopped', view).checked ? undefined : ['active', 'in_review', 'on_hold', 'ready_for_review'];
      const r = await api('/api/overlap', { method: 'POST', body: { mode: 'check', list: $('#ovList', view).value, statuses, refresh: true } });
      $('#ovRes', view).innerHTML = `<div><b>${r.total}</b> channels: <b class="ok">${r.freeCount} free</b>, <b class="${r.usedCount ? 'bad' : ''}">${r.usedCount} already used</b>${r.invalid.length ? `, ${r.invalid.length} invalid` : ''}</div>
        <div class="row gap"><button class="btn sm" id="cpFree">Copy free channels</button><button class="btn sm" id="useFree">Use free list in Batch builder</button></div>
        ${r.used.length ? `<div class="tablewrap gap"><table><thead><tr><th>Channel</th><th>Used by</th></tr></thead><tbody>${r.used.map((u) => `<tr><td>${esc(u.channel)}</td><td class="wrap">${u.ads.map((a) => `${esc(a.title)} <span class="muted small">(${esc(a.status)})</span>`).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
      $('#cpFree', view).onclick = () => copyText(r.free.join('\n'));
      $('#useFree', view).onclick = () => { handoff.set('batchChannels', r.free.join('\n')); go('batch'); };
    });
    $('#ovInt', view).onclick = (e) => busy(e.target, async () => {
      const r = await api('/api/overlap', { method: 'POST', body: { mode: 'internal', refresh: true } });
      $('#ovIntRes', view).innerHTML = `<div><b>${r.channelsInUse}</b> channels in use by live ads · <b class="${r.sharedChannels ? 'warn' : 'ok'}">${r.sharedChannels} shared by 2+ ads</b></div>
        ${r.pairs.length ? `<h3 class="gap">Ad pairs sharing channels</h3><div class="tablewrap"><table><thead><tr><th>Ad A</th><th>Ad B</th><th class="num">Shared</th><th class="num">% of smaller</th></tr></thead><tbody>${r.pairs.map((p) => `<tr><td>${esc(p.titleA)}</td><td>${esc(p.titleB)}</td><td class="num">${p.shared}</td><td class="num">${p.pctOfSmaller}%</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${r.shared.length ? `<h3 class="gap">Most shared channels</h3><div class="tablewrap"><table><thead><tr><th>Channel</th><th>Ads</th></tr></thead><tbody>${r.shared.slice(0, 100).map((s) => `<tr><td>${esc(s.key)}</td><td class="wrap">${s.ads.map((a) => esc(a.title)).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    });
    const pre = handoff.take('overlapList'); if (pre) $('#ovList', view).value = pre;
  },
});

// ======================================================= Stats
pageRegister('stats', {
  title: 'Stats & reports', icon: '◔',
  async render(view) {
    const now = new Date();
    view.innerHTML = `
      <div class="card"><h2>Ad performance over time</h2>
        <div class="row"><input type="text" id="sq" placeholder="Filter ads…" style="max-width:220px"><button class="btn sm" id="top5">Pick top 5 by spend</button><button class="btn sm" id="pickAll">Select all shown</button><button class="btn sm" id="pickNone">Clear</button></div>
        <div id="adPick" class="tablewrap gap" style="max-height:200px;padding:8px"></div>
        <div class="row gap">
          <label class="f"><span>Range</span><select id="rng"><option value="7">Last 7 days (daily)</option><option value="14" selected>Last 14 days (daily)</option><option value="30">Last 30 days (daily)</option><option value="90">Last 90 days (daily)</option><option value="h24">Last 24 hours (5 min)</option><option value="h48">Last 48 hours (5 min)</option></select></label>
          <label class="f"><span>Metric</span><select id="met"><option value="views">Views</option><option value="clicks">Clicks</option><option value="actions" selected>Actions</option><option value="spent_budget">Spent</option></select></label>
          <span class="grow"></span><button class="btn primary" id="loadSt" style="align-self:flex-end">Load stats</button></div>
        <canvas class="chart gap" id="ch"></canvas><div id="lg"></div><div id="stTbl" class="gap"></div></div>
      <div class="card"><h2>Monthly account report</h2>
        <div class="row"><label class="f"><span>Year</span><input type="number" id="ry" value="${now.getUTCFullYear()}" style="width:100px"></label><label class="f"><span>Month</span><input type="number" id="rm" min="1" max="12" value="${now.getUTCMonth() + 1}" style="width:90px"></label><button class="btn primary" id="loadRep" style="align-self:flex-end">Load report</button><button class="btn" id="repCsv" style="align-self:flex-end">Export CSV</button></div>
        <div id="repTbl" class="gap"></div></div>`;
    const ads = (await getAds({})).ads;
    const sel = new Set();
    const drawPick = () => {
      const f = $('#sq', view).value.toLowerCase();
      const list = ads.filter((a) => !f || a.title.toLowerCase().includes(f));
      $('#adPick', view).innerHTML = list.map((a) => `<label class="chk" style="padding:2px 0"><input type="checkbox" data-id="${a.ad_id}" ${sel.has(a.ad_id) ? 'checked' : ''}> ${esc(a.title)} <span class="muted small">#${a.ad_id} · ${esc(a.status)} · spent ${money(a.spent_budget)}</span></label>`).join('') || '<span class="muted">No ads</span>';
      $$('[data-id]', view).forEach((c) => { c.onchange = () => { const id = Number(c.dataset.id); if (c.checked) sel.add(id); else sel.delete(id); }; });
    };
    $('#sq', view).oninput = drawPick; drawPick();
    $('#top5', view).onclick = () => { sel.clear(); ads.slice().sort((a, b) => b.spent_budget - a.spent_budget).slice(0, 5).forEach((a) => sel.add(a.ad_id)); drawPick(); };
    $('#pickAll', view).onclick = () => { const f = $('#sq', view).value.toLowerCase(); ads.filter((a) => !f || a.title.toLowerCase().includes(f)).slice(0, 50).forEach((a) => sel.add(a.ad_id)); drawPick(); };
    $('#pickNone', view).onclick = () => { sel.clear(); drawPick(); };

    $('#loadSt', view).onclick = (e) => busy(e.target, async () => {
      if (!sel.size) return toast('Select at least one ad');
      const rng = $('#rng', view).value; const hourly = rng.startsWith('h');
      const interval = hourly ? 300 : 86400;
      const to = Math.floor(Date.now() / 1000); const from = hourly ? to - Number(rng.slice(1)) * 3600 : to - Number(rng) * 86400;
      const r = await api('/api/stats/multi', { method: 'POST', body: { ids: [...sel], from, to, interval } });
      const metric = $('#met', view).value;
      const ids = [...sel].filter((id) => Array.isArray(r.stats[id]));
      const first = r.stats[ids[0]] || [];
      const labels = first.map((x) => { const d = new Date(x.from_time * 1000); return hourly ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); });
      const title = (id) => (ads.find((a) => a.ad_id === id) || {}).title || `#${id}`;
      const series = ids.slice(0, 8).map((id, i) => ({ name: title(id), color: PALETTE[i % PALETTE.length], data: r.stats[id].map((x) => x[metric] || 0) }));
      drawChart($('#ch', view), labels, series); $('#lg', view).innerHTML = legend(series);
      const rows = [...sel].map((id) => {
        const st = r.stats[id];
        if (!Array.isArray(st)) return { ad_id: id, title: title(id), error: (st && st.error) || 'no data' };
        const t = st.reduce((a, x) => ({ views: a.views + (x.views || 0), clicks: a.clicks + (x.clicks || 0), actions: a.actions + (x.actions || 0), spent_budget: a.spent_budget + (x.spent_budget || 0) }), { views: 0, clicks: 0, actions: 0, spent_budget: 0 });
        return { ad_id: id, title: title(id), ...t, ctr: t.views ? t.clicks / t.views * 100 : null, cvr: t.clicks ? t.actions / t.clicks * 100 : null, cpa: t.actions ? t.spent_budget / t.actions : null };
      });
      dataTable($('#stTbl', view), { cols: [
        { k: 'title', t: 'Ad', html: (x) => esc(x.title) + (x.error ? ` <span class="bad small">${esc(x.error)}</span>` : '') }, { k: 'views', t: 'Views', num: true }, { k: 'clicks', t: 'Clicks', num: true }, { k: 'actions', t: 'Actions', num: true },
        { k: 'ctr', t: 'CTR', num: true, html: (x) => pct(x.ctr) }, { k: 'cvr', t: 'CVR', num: true, html: (x) => pct(x.cvr) }, { k: 'cpa', t: 'CPA', num: true, html: (x) => money(x.cpa, 3) }, { k: 'spent_budget', t: 'Spent', num: true, html: (x) => money(x.spent_budget) },
      ], rowKey: 'ad_id', sortKey: 'spent_budget' }).set(rows);
    });

    let repRows = [];
    $('#loadRep', view).onclick = (e) => busy(e.target, async () => {
      const r = await api(`/api/report?year=${$('#ry', view).value}&month=${$('#rm', view).value}`);
      repRows = r.map((x) => ({ ...x, ctr: x.views ? x.clicks / x.views * 100 : null, cvr: x.clicks ? x.actions / x.clicks * 100 : null, cpa: x.actions ? x.spent_budget / x.actions : null, ad_title: x.ad_title }));
      dataTable($('#repTbl', view), { cols: [
        { k: 'ad_title', t: 'Ad' }, { k: 'views', t: 'Views', num: true }, { k: 'clicks', t: 'Clicks', num: true }, { k: 'actions', t: 'Actions', num: true },
        { k: 'ctr', t: 'CTR', num: true, html: (x) => pct(x.ctr) }, { k: 'cvr', t: 'CVR', num: true, html: (x) => pct(x.cvr) }, { k: 'cpa', t: 'CPA', num: true, html: (x) => money(x.cpa, 3) }, { k: 'spent_budget', t: 'Spent', num: true, html: (x) => money(x.spent_budget) },
      ], rowKey: 'ad_id', sortKey: 'spent_budget' }).set(repRows);
    });
    $('#repCsv', view).onclick = () => download('monthly-report.csv', toCSV(repRows, ['ad_id', 'ad_title', 'views', 'opens', 'clicks', 'actions', 'ctr', 'cvr', 'cpa', 'spent_budget', 'currency']));
  },
});
