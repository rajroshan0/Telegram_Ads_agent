'use strict';
/* End-to-end tests against the mock API. Run: npm test */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-api');

(async () => {
  const mock = createMock();
  await new Promise((r) => mock.server.listen(0, r));
  const mockPort = mock.server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgads-test-'));

  process.env.DATA_DIR = tmp;
  process.env.TG_ADS_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.TG_ADS_TOKEN = 'TESTTOKEN';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.APP_PASSWORD = '';

  const { tg } = require('../src/tgads');
  const bulk = require('../src/bulk');
  const analysis = require('../src/analysis');
  const rules = require('../src/rules');
  const csv = require('../src/csv');
  const T = require('../src/targets');

  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
  };

  console.log('Telegram Ads Agent tests');

  await t('API client: account call and API errors surface as TgError', async () => {
    const a = await tg.call('getCurrentAccount', {});
    assert.strictEqual(a.currency, 'TON');
    await assert.rejects(() => tg.call('editAd', { ad_id: 424242, is_paused: true }), (e) => e.name === 'TgError' && e.code === 'AD_NOT_FOUND');
    await assert.rejects(() => tg.call('notAMethod', {}), (e) => e.code === 'UNKNOWN_METHOD');
  });

  await t('channel normalisation', () => {
    assert.strictEqual(T.normalizeChannel('https://t.me/Foo_Bar/12'), '@Foo_Bar');
    assert.strictEqual(T.normalizeChannel('@abc'), '@abc');
    assert.strictEqual(T.normalizeChannel('12345'), 12345);
    assert.strictEqual(T.normalizeChannel('a b'), null);
    const r = T.normalizeList('@a1b, @A1B\nt.me/zzz1 ###');
    assert.deepStrictEqual(r.list, ['@a1b', '@zzz1']);
    assert.strictEqual(r.invalid.length, 1);
  });

  await t('csv parsing handles quotes, newlines and aliases', () => {
    const rows = csv.parseObjects('Title,Text,Channels\n"a, b","line1\nline2","@c1\n@c2"\n');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].title, 'a, b');
    assert.strictEqual(rows[0].text, 'line1\nline2');
    assert.strictEqual(bulk.canonicalRow({ 'Ad Name': 'x', URL: 'y', Interests: 'Sports' }).promote_url, 'y');
  });

  await t('schedule: hours mask and timezone', () => {
    assert.strictEqual(bulk.hoursToMask('0-2'), 3);
    const s = bulk.parseSchedule({ schedule_hours: '9-12', schedule_days: '1-5', schedule_tz: '5.5' });
    assert.strictEqual(s.week_hours_mask.length, 7);
    assert.strictEqual(s.week_hours_mask[0], 7 << 9);
    assert.strictEqual(s.week_hours_mask[6], 0);
    assert.strictEqual(s.timezone, 19800);
    assert.throws(() => bulk.parseSchedule({ schedule_hours: '9-12', schedule_tz: '5.1' }));
  });

  await t('rowToPayload: valid channel ad, name resolution', async () => {
    const r = await bulk.rowToPayload({ title: 'T1', text: 'hello', url: 't.me/mychan', cpm: '1.5', topics: 'Sports', languages: 'Hindi', initial_budget: '3' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.payload.target.type, 'channels');
    assert.deepStrictEqual(r.payload.target.topic_ids, [1]);
    assert.deepStrictEqual(r.payload.target.language_codes, ['hi']);
    assert.strictEqual(r.payload.placement, 'channel_post');
    assert.strictEqual(r.payload.promote_url, 'https://t.me/mychan');
  });

  await t('rowToPayload: validation errors', async () => {
    const r = await bulk.rowToPayload({ title: '', text: 'x'.repeat(161), url: 'https://example.com', cpm: '0', topics: 'Nonsense' });
    const joined = r.errors.join(' | ');
    assert.ok(/title is required/.test(joined));
    assert.ok(/161 characters/.test(joined));
    assert.ok(/website_name/.test(joined));
    assert.ok(/cpm/.test(joined));
    assert.ok(/unknown values/.test(joined));
    const big = await bulk.rowToPayload({ title: 'a', text: 'b', url: 't.me/x', cpm: 1, channels: Array.from({ length: 101 }, (_, i) => `@chan${i}x`).join(' ') });
    assert.ok(big.errors.some((e) => /max 100/.test(e)));
  });

  await t('rowToPayload: users / bots / search targeting', async () => {
    const u = await bulk.rowToPayload({ title: 'u', text: 'x', url: 't.me/x', cpm: 1, countries: 'India', device: 'ANDROID' });
    assert.deepStrictEqual(u.errors, []);
    assert.deepStrictEqual(u.payload.target.country_codes, ['IN']);
    assert.strictEqual(u.payload.target.device, 'android');
    const b = await bulk.rowToPayload({ title: 'b', text: 'x', url: 't.me/x', cpm: 1, bots: '@tipsbot' });
    assert.strictEqual(b.payload.placement, 'bot_banner');
    const s = await bulk.rowToPayload({ title: 's', url: 't.me/x', cpm: 1, search_queries: 'ipl tips|cricket' });
    assert.deepStrictEqual(s.payload.target.search_queries, ['ipl tips', 'cricket']);
    assert.strictEqual(s.payload.placement, 'search_result');
  });

  await t('bulk run: creates, reports failures, auto-submits', async () => {
    const rows = [
      { title: 'ok1', text: 'a', url: 't.me/c', cpm: 1, channels: '@channel1 @channel2', initial_budget: 2 },
      { title: 'ok2', text: 'b', url: 't.me/c', cpm: 1, channels: '@channel3 @channel4', initial_budget: 0 },
      { title: 'FAIL me', text: 'b', url: 't.me/c', cpm: 1, channels: '@channel5' },
      { title: '', text: 'b', url: 't.me/c', cpm: 1 },
    ];
    const progress = [];
    const res = await bulk.runBulk(rows, { delayMs: 0 }, (r) => progress.push(r));
    assert.strictEqual(progress.length, 4);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[1].status, 'in_review'); // ready_for_review -> submitted
    assert.strictEqual(res[2].ok, false);
    assert.match(res[2].error, /AD_TEXT_INVALID/);
    assert.strictEqual(res[3].ok, false);
    assert.strictEqual(mock.state.ads.length, 2);
  });

  await t('bulk run: pauseAfterCreate sets is_paused', async () => {
    const res = await bulk.runBulk([{ title: 'paused1', text: 'a', url: 't.me/c', cpm: 1, channels: '@channel6', initial_budget: 1 }], { delayMs: 0, pauseAfterCreate: true });
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(mock.state.ads.find((a) => a.title === 'paused1').is_paused, true);
  });

  await t('bulk run: fatal error aborts the rest', async () => {
    const rows = [
      { title: 'big', text: 'a', url: 't.me/c', cpm: 1, channels: '@channel1', initial_budget: 99999 },
      { title: 'after', text: 'a', url: 't.me/c', cpm: 1, channels: '@channel1', initial_budget: 1 },
    ];
    const res = await bulk.runBulk(rows, { delayMs: 0 });
    assert.strictEqual(res[0].ok, false);
    assert.strictEqual(res[1].skipped, true);
  });

  await t('idempotency: the same key replays instead of duplicating', async () => {
    const before = mock.state.ads.length;
    const p = { title: 'idem', text: 'a', promote_url: 'https://t.me/c', cpm: 1, placement: 'channel_post', target: { type: 'channels', channel_ids: ['@channel1'] }, initial_budget: 1 };
    const a = await tg.call('createAd', p, { idempotencyKey: 'k-1' });
    const b = await tg.call('createAd', p, { idempotencyKey: 'k-1' });
    assert.strictEqual(a.ad_id, b.ad_id);
    assert.strictEqual(mock.state.ads.length, before + 1);
  });

  await t('listAllAds paginates', async () => {
    for (let i = 0; i < 130; i++) mock.state.ads.push({ ad_id: 1000 + i, title: `bulk${i}`, status: 'stopped', views: 0, clicks: 0, actions: 0, spent_budget: 0, remaining_budget: 0, cpm: 1 });
    const all = await tg.listAllAds();
    assert.strictEqual(all.length, mock.state.ads.length);
    mock.state.ads = mock.state.ads.filter((a) => a.ad_id < 1000);
  });

  await t('overlap: internal + check + batch planning avoiding used channels', async () => {
    const ads = await tg.listAllAds({ returnTarget: true });
    const internal = analysis.internalOverlap(ads, ['active', 'in_review', 'on_hold', 'ready_for_review']);
    assert.ok(internal.sharedChannels >= 1, 'channel1 is used by several ads');
    const chk = analysis.checkList(ads, '@channel1 @brandnew1');
    assert.strictEqual(chk.usedCount, 1);
    assert.strictEqual(chk.freeCount, 1);
    const plan = analysis.planBatches({
      channels: Array.from({ length: 10 }, (_, i) => `@fresh${i}ch`).join(' '), batchSize: 4,
      creatives: [{ label: 'A', text: 'one' }, { label: 'B', text: 'two' }], base: { promote_url: 't.me/c', cpm: 1 }, namePrefix: 'bz', exclude: ['@fresh0ch'],
    });
    assert.strictEqual(plan.batches, 3); // 9 channels -> 4+4+1
    assert.strictEqual(plan.rows.length, 6);
    assert.strictEqual(plan.removedAlreadyUsed, 1);
    assert.strictEqual(plan.rows[0].title, 'bz_A_b1');
    assert.strictEqual(plan.rows[1].text, 'two');
  });

  await t('rules: evaluate conditions incl. infinite CPA, dry run does not change anything', async () => {
    const ad = { ad_id: 7, title: 'burner', status: 'active', views: 1000, clicks: 150, actions: 0, spent_budget: 6, remaining_budget: 1, cpm: 1, created_date: Math.floor(Date.now() / 1000) - 7200 };
    const rule = { conditions: [{ metric: 'spent', op: '>=', value: 5 }, { metric: 'clicks', op: '>=', value: 100 }, { metric: 'cpa', op: '>', value: 1 }] };
    assert.strictEqual(rules.evaluate(rule, ad).match, true);
    assert.strictEqual(rules.evaluate(rule, { ...ad, actions: 500 }).match, false);
    assert.strictEqual(rules.evaluate(rule, { ...ad, spent_budget: 0 }).match, false);
    const saved = rules.saveRule({ name: 'Kill burners', conditions: rule.conditions, action: { type: 'pause' }, enabled: true, dryRun: true, scope: { statuses: ['active'] } });
    mock.state.ads.push({ ...ad, ad_id: 777 });
    const dry = await rules.runRules({ ruleId: saved.id, forceDryRun: true });
    assert.strictEqual(dry.hits.length, 1);
    assert.strictEqual(mock.state.ads.find((a) => a.ad_id === 777).status, 'active');
    assert.throws(() => rules.saveRule({ name: 'x', conditions: [] }), /condition/);
    rules.saveRule({ ...saved, dryRun: false });
    const live = await rules.runRules({ ruleId: saved.id });
    assert.strictEqual(live.hits[0].ok, true);
    assert.strictEqual(mock.state.ads.find((a) => a.ad_id === 777).is_paused, true);
    const again = await rules.runRules({ ruleId: saved.id });
    assert.strictEqual(again.hits.length, 0, 'paused ad is no longer active, rule must not hit twice');
  });

  // ---- HTTP smoke test of the real server ----
  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (p, opts) => { const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...opts }); return { status: r.status, body: await r.json().catch(() => null), r }; };

  await t('cpm: payload cpm equals what was typed; photo only warns; channel list separators', async () => {
    const base = { title: 'Knockout_test_A_b1', target_type: 'channels', placement: 'channel_post', text: 'x', promote_url: 'https://t.me/c', impression_frequency: '3', initial_budget: '3' };
    const chans = Array.from({ length: 18 }, (_, i) => `@chan${i + 1}`).join('\n');
    for (const typed of ['1', '2', 1, '1.5', '0,5']) {
      const r = await bulk.rowToPayload({ ...base, cpm: typed, channels: chans }, { resolve: false });
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.payload.cpm, Number(String(typed).replace(',', '.')));
      assert.strictEqual(r.payload.target.channel_ids.length, 18);
      assert.ok(!r.warnings.some((w) => /photo/.test(w)), 'no photo warning without a photo');
    }
    const ph = await bulk.rowToPayload({ ...base, cpm: '1', channels: '@a1b, @c2d', photo_url: 'https://x/y.jpg' }, { resolve: false });
    assert.strictEqual(ph.payload.cpm, 1); assert.deepStrictEqual(ph.errors, []);
    assert.ok(ph.warnings.some((w) => /photo/.test(w)));
    const up = await bulk.rowToPayload({ ...base, cpm: '1', channels: '@a1b', show_userpic: 'true' }, { resolve: false });
    assert.strictEqual(up.payload.cpm, 1);
    const mixed = T.normalizeList('@fantasylosscover, @MATH_BODMAS\nt.me/third_one;fourth_x');
    assert.deepStrictEqual(mixed.list, ['@fantasylosscover', '@MATH_BODMAS', '@third_one', '@fourth_x']);
    const bad = await bulk.rowToPayload({ ...base, cpm: '1', channels: '@good_one, @a, bad!name' }, { resolve: false });
    assert.ok(bad.errors.some((e) => /"@a"/.test(e) && /"bad!name"/.test(e)), bad.errors.join('|'));
  });

  await t('media: photo_url is checked, uploaded and attached; bad links give clear errors', async () => {
    const http = require('http');
    const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    const srv = http.createServer((q, r) => {
      if (q.url === '/wide') { r.setHeader('content-type', 'application/octet-stream'); return r.end(png(1280, 720)); }
      if (q.url === '/square') { r.setHeader('content-type', 'image/png'); return r.end(png(800, 800)); }
      if (q.url === '/tiny') { r.setHeader('content-type', 'image/png'); return r.end(png(500, 281)); }
      r.setHeader('content-type', 'text/html'); r.end('<!DOCTYPE html><html><head></head><body>share page</body></html>');
    });
    await new Promise((ok) => srv.listen(0, ok));
    const u = (p2) => `http://127.0.0.1:${srv.address().port}${p2}`;
    const row = (p2) => ({ title: `media_${p2.slice(1)}`, text: 'x', url: 't.me/c', cpm: 1, channels: '@channel1', initial_budget: 1, photo_url: u(p2) });
    const out = await bulk.runBulk([row('/wide'), row('/square'), row('/tiny'), row('/page')], { delayMs: 0 });
    assert.strictEqual(out[0].ok, true); assert.ok(!(out[0].warnings || []).some((w) => /16:9/.test(w)));
    assert.ok(mock.state.ads.find((a) => a.title === 'media_wide').photo, 'ad has its photo');
    assert.strictEqual(out[1].ok, false); assert.ok(/800x800.*16:9/.test(out[1].error), out[1].error);
    assert.strictEqual(out[2].ok, false); assert.ok(/500px wide/.test(out[2].error), out[2].error);
    assert.strictEqual(out[3].ok, false); assert.ok(/web page, not an image/.test(out[3].error), out[3].error);
    srv.close();
  });

  await t('server: health, settings hide tokens, account', async () => {
    assert.strictEqual((await j('/api/health')).body.ok, true);
    const s = (await j('/api/settings')).body;
    assert.ok(s.adsTokenSet);
    assert.ok(!JSON.stringify(s).includes('TESTTOKEN'));
    assert.strictEqual((await j('/api/account')).body.currency, 'TON');
  });

  await t('server: ads list with metrics, preview + run job', async () => {
    const ads = (await j('/api/ads?refresh=1')).body.ads;
    assert.ok(ads.length > 0);
    const pv = (await j('/api/bulk/preview', { method: 'POST', body: JSON.stringify({ rows: [{ title: 'srv1', text: 'x', url: 't.me/c', cpm: 1, channels: '@channel1' }, { title: 'bad' }] }) })).body;
    assert.strictEqual(pv.valid, 1); assert.strictEqual(pv.invalid, 1);
    const { jobId } = (await j('/api/bulk/run', { method: 'POST', body: JSON.stringify({ rows: [{ title: 'srv1', text: 'x', url: 't.me/c', cpm: 1, channels: '@channel1', initial_budget: 1 }], options: { delayMs: 0 } }) })).body;
    let job;
    for (let i = 0; i < 50; i++) { job = (await j(`/api/jobs/${jobId}`)).body; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(job.results[0].ok, true);
  });

  await t('server: ad actions, duplicate row, passthrough, unknown method blocked', async () => {
    const ad = mock.state.ads.find((a) => a.title === 'srv1');
    const act = (await j('/api/ads/action', { method: 'POST', body: JSON.stringify({ ids: [ad.ad_id], action: 'add_budget', amount: 2 }) })).body;
    assert.strictEqual(act.results[0].ok, true);
    assert.strictEqual(mock.state.ads.find((a) => a.ad_id === ad.ad_id).remaining_budget, 3);
    const row = (await j(`/api/ads/${ad.ad_id}/row`)).body.row;
    assert.strictEqual(row.channels, '@channel1');
    assert.strictEqual(row.title, 'srv1 copy');
    assert.strictEqual((await j('/api/tg/getCurrentAccount', { method: 'POST', body: '{}' })).body.result.currency, 'TON');
    assert.strictEqual((await j('/api/tg/hackTheWorld', { method: 'POST', body: '{}' })).status, 400);
  });

  await t('server: overlap, batch plan, audiences upload, targeting lookups', async () => {
    const ov = (await j('/api/overlap', { method: 'POST', body: JSON.stringify({ mode: 'check', list: '@channel1 @neverused1' }) })).body;
    assert.strictEqual(ov.freeCount, 1);
    const plan = (await j('/api/batch/plan', { method: 'POST', body: JSON.stringify({ channels: '@channel1 @newone1 @newone2', batchSize: 2, avoidUsed: true, creatives: [{ label: 'A', text: 'hi' }], base: { promote_url: 't.me/c', cpm: 1 } }) })).body;
    assert.strictEqual(plan.removedAlreadyUsed, 1);
    assert.strictEqual(plan.rows.length, 1);
    const au = (await j('/api/audiences/upload', { method: 'POST', body: JSON.stringify({ title: 'my list', phones: '+91 98765 43210\n9876543211, bad', hash: true }) })).body;
    assert.strictEqual(au.sent, 2);
    assert.strictEqual(au.audience.size, 2);
    const topics = (await j('/api/targets/topics')).body;
    assert.strictEqual(topics.length, 3);
    const rs = (await j('/api/channels/resolve', { method: 'POST', body: JSON.stringify({ list: '@channel1 @doesnotexist1' }) })).body;
    assert.strictEqual(rs.found.length, 1); assert.strictEqual(rs.missing.length, 1);
  });

  await t('server: template CSV downloads and parses back', async () => {
    const r = await fetch(`${base}/api/bulk/template`);
    const text = await r.text();
    const rows = csv.parseObjects(text);
    assert.ok(rows.length >= 3);
    assert.ok(rows[0].channels.includes('@channel1'));
  });

  console.log(`\n${pass} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
  server.close(); mock.server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
