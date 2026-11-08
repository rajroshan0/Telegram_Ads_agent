'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./src/config');
const { eff, mask } = require('./src/cfg');
const { settings, log, getLog, DEFAULT_SETTINGS } = require('./src/store');
const { tg, TgError, METHODS } = require('./src/tgads');
const T = require('./src/targets');
const bulk = require('./src/bulk');
const analysis = require('./src/analysis');
const rulesEngine = require('./src/rules');
const sheets = require('./src/sheets');
const { notify, botInfo } = require('./src/notify');
const { toCSV } = require('./src/csv');
const U = require('./src/util');

const app = express();
app.disable('x-powered-by');

// ---------- safety: never expose an unprotected server ----------
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.HOST);
if (!loopback && !config.APP_PASSWORD) {
  console.error('\n✖ HOST is not 127.0.0.1 but APP_PASSWORD is empty.\n  This app can spend ad money, so it must be protected. Set APP_PASSWORD in .env and start again.\n');
  process.exit(1);
}
const AUTH_ON = !!config.APP_PASSWORD;
const SECRET = crypto.createHash('sha256').update(`tgads-agent:${config.APP_PASSWORD}`).digest();
const COOKIE = 'tga_session';

function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeSession() { const exp = String(Date.now() + 7 * 24 * 3600 * 1000); return `${exp}.${sign(exp)}`; }
function validSession(tok) {
  if (!tok) return false;
  const [exp, sig] = String(tok).split('.');
  if (!exp || !sig || !U.safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

app.use(express.json({ limit: '60mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

const attempts = new Map();
app.post('/api/login', (req, res) => {
  if (!AUTH_ON) return res.json({ ok: true, auth: false });
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, reset: Date.now() + 10 * 60000 };
  if (Date.now() > a.reset) { a.n = 0; a.reset = Date.now() + 10 * 60000; }
  if (a.n >= 8) return res.status(429).json({ error: 'Too many attempts. Wait 10 minutes.' });
  if (!U.safeEqual(String((req.body && req.body.password) || ''), config.APP_PASSWORD)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  res.cookie(COOKIE, makeSession(), { httpOnly: true, sameSite: 'strict', secure: config.COOKIE_SECURE, maxAge: 7 * 24 * 3600 * 1000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => res.json({ auth: AUTH_ON, loggedIn: !AUTH_ON || validSession(cookies(req)[COOKIE]) }));

app.use('/api', (req, res, next) => {
  if (!AUTH_ON || validSession(cookies(req)[COOKIE])) return next();
  return res.status(401).json({ error: 'Not logged in', login: true });
});

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    const isTg = e instanceof TgError;
    const status = isTg ? (e.status && e.status >= 400 && e.status < 600 ? e.status : 400) : 500;
    if (isTg) console.error(`[tg-error] ${req.method} ${req.originalUrl} -> ${e.method || 'API'}: ${e.code}${e.status ? ` (HTTP ${e.status})` : ''}${e.params ? ` params=${JSON.stringify(e.params).slice(0, 300)}` : ''}`);
    else console.error(e);
    res.status(status === 401 ? 400 : status).json({ error: isTg ? e.code : U.errMessage(e), tg: isTg, method: isTg ? e.method : undefined, status: isTg ? e.status : undefined });
  });
};

// account id for this request (header "X-Account-Id"; "main" = ignore the default sub-account)
const acct = (req) => {
  const h = req.get('x-account-id');
  if (!h) return undefined;
  return h === 'main' ? false : h;
};
const A = (req) => ({ accountId: acct(req) });

// ---------- settings ----------
function publicSettings() {
  const c = eff(); const s = settings.get();
  const envLocked = (v) => !!v;
  return {
    adsToken: mask(c.adsToken), adsTokenSet: !!c.adsToken, adsTokenFromEnv: envLocked(config.ENV.TG_ADS_TOKEN),
    accountId: c.accountId, paramEncoding: c.paramEncoding,
    botToken: mask(c.botToken), botTokenSet: !!c.botToken, botTokenFromEnv: envLocked(config.ENV.TG_BOT_TOKEN),
    botChatId: c.botChatId,
    googleSet: !!(c.googleJson || c.googleFile), googleEmail: sheets.saEmail(),
    monitorEnabled: !!s.monitorEnabled, monitorIntervalMinutes: s.monitorIntervalMinutes, requestDelayMs: s.requestDelayMs,
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(s.alerts || {}) },
    monitor: rulesEngine.monitorStatus(),
  };
}
app.get('/api/settings', wrap(async (req, res) => res.json(publicSettings())));
app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  settings.update((s) => {
    for (const k of ['adsToken', 'botToken', 'googleServiceAccountJson']) if (typeof b[k] === 'string' && b[k].trim()) s[k] = b[k].trim();
    for (const k of ['accountId', 'botChatId']) if (typeof b[k] === 'string') s[k] = b[k].trim();
    if (['json', 'form'].includes(b.paramEncoding)) s.paramEncoding = b.paramEncoding;
    if (b.monitorIntervalMinutes !== undefined) s.monitorIntervalMinutes = Math.max(1, Number(b.monitorIntervalMinutes) || 15);
    if (b.requestDelayMs !== undefined) s.requestDelayMs = Math.max(0, Number(b.requestDelayMs) || 0);
    if (typeof b.monitorEnabled === 'boolean') s.monitorEnabled = b.monitorEnabled;
    if (b.alerts && typeof b.alerts === 'object') s.alerts = { ...DEFAULT_SETTINGS.alerts, ...(s.alerts || {}), ...b.alerts };
    for (const k of b.clear || []) if (['adsToken', 'botToken', 'googleServiceAccountJson'].includes(k)) s[k] = '';
  });
  if (settings.get().monitorEnabled) rulesEngine.startMonitor(); else rulesEngine.stopMonitor();
  adCache.clear();
  res.json(publicSettings());
}));
app.post('/api/settings/test', wrap(async (req, res) => {
  const what = (req.body && req.body.what) || 'ads';
  if (what === 'ads') { const a = await tg.call('getCurrentAccount', {}, A(req)); return res.json({ ok: true, account: a }); }
  if (what === 'bot') { const b = await botInfo(); return res.json(b); }
  if (what === 'notify') { return res.json(await notify('✅ Telegram Ads Agent: test message')); }
  if (what === 'sheets') { return res.json({ ok: !!sheets.saEmail(), email: sheets.saEmail() }); }
  res.status(400).json({ error: 'unknown test' });
}));

// ---------- raw API passthrough (API explorer + everything the UI does not wrap) ----------
app.get('/api/methods', (req, res) => res.json(Object.entries(METHODS).map(([name, m]) => ({ name, ...m }))));
app.post('/api/tg/:method', wrap(async (req, res) => {
  const m = req.params.method;
  if (!METHODS[m]) return res.status(400).json({ error: 'UNKNOWN_METHOD' });
  if (METHODS[m].upload) return res.status(400).json({ error: 'Use /api/upload for files' });
  const result = await tg.call(m, req.body || {}, A(req));
  if (/^(createAd|editAd|increaseAdBudget|decreaseAdBudget|deleteAd|submitAdForReview|editAdStatus)$/.test(m)) adCache.clear();
  log('api', `${m} ${JSON.stringify(req.body || {}).slice(0, 200)}`);
  res.json({ result });
}));

// ---------- account ----------
app.get('/api/account', wrap(async (req, res) => res.json(await tg.call('getCurrentAccount', {}, A(req)))));
app.get('/api/related-accounts', wrap(async (req, res) => {
  try { res.json(await tg.call('getRelatedAccountsList', {}, A(req))); } catch (e) {
    // A sub-account / agency token cannot list related accounts. That is normal, not an error.
    if (e instanceof TgError && e.code === 'MAIN_ACCOUNT_REQUIRED') return res.json({ accounts: [], note: 'This token belongs to a sub-account, so the account list is not available.' });
    throw e;
  }
}));
app.get('/api/report', wrap(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getUTCFullYear();
  const month = Number(req.query.month) || now.getUTCMonth() + 1;
  res.json(await tg.call('getAccountReport', { year, month }, A(req)));
}));
app.get('/api/transactions', wrap(async (req, res) => {
  const adId = req.query.ad_id ? Number(req.query.ad_id) : undefined;
  const p = { offset: Number(req.query.offset) || 0, limit: Number(req.query.limit) || 100 };
  res.json(adId ? await tg.call('getAdTransactionsList', { ...p, ad_id: adId }, A(req)) : await tg.call('getAccountTransactionsList', p, A(req)));
}));

// ---------- ads ----------
const adCache = new Map();
async function loadAds(req, { target = false, refresh = false } = {}) {
  const a = acct(req);
  const key = `${a === undefined ? 'd' : a}|${target ? 1 : 0}`;
  const hit = adCache.get(key);
  if (!refresh && hit && Date.now() - hit.t < (target ? 60000 : 15000)) return hit;
  const ads = await tg.listAllAds({ returnTarget: target, accountId: a });
  const rows = ads.map((ad) => ({ ...ad, ...U.metrics(ad), target_summary: ad.target ? T.describeTarget(ad.target) : undefined }));
  const v = { t: Date.now(), ads: rows };
  adCache.set(key, v);
  return v;
}

app.get('/api/ads', wrap(async (req, res) => {
  const v = await loadAds(req, { target: req.query.target === '1', refresh: req.query.refresh === '1' });
  res.json({ ads: v.ads, fetchedAt: new Date(v.t).toISOString() });
}));
app.get('/api/ads/:id', wrap(async (req, res) => {
  const r = await tg.call('getAdsById', { ad_ids: [Number(req.params.id)], return_target: true }, A(req));
  if (!r.length) return res.status(404).json({ error: 'AD_NOT_FOUND' });
  res.json({ ...r[0], ...U.metrics(r[0]) });
}));
app.get('/api/ads/:id/row', wrap(async (req, res) => {
  const r = await tg.call('getAdsById', { ad_ids: [Number(req.params.id)], return_target: true }, A(req));
  if (!r.length) return res.status(404).json({ error: 'AD_NOT_FOUND' });
  const row = T.adToRow(r[0]);
  row.title = `${r[0].title} copy`;
  res.json({ row });
}));
app.get('/api/ads/:id/stats', wrap(async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const interval = Number(req.query.interval) === 300 ? 300 : 86400;
  const to = Number(req.query.to) || now;
  const from = Number(req.query.from) || to - (interval === 300 ? 2 * 86400 : 30 * 86400);
  res.json(await tg.call('getAdStats', { ad_id: Number(req.params.id), from_time: from, to_time: to, interval }, A(req)));
}));
app.post('/api/stats/multi', wrap(async (req, res) => {
  const { ids = [], from, to, interval = 86400 } = req.body || {};
  const now = Math.floor(Date.now() / 1000);
  const iv = Number(interval) === 300 ? 300 : 86400;
  const t = Number(to) || now; const f = Number(from) || t - (iv === 300 ? 2 * 86400 : 30 * 86400);
  const out = {};
  for (const id of ids.slice(0, 50)) {
    try { out[id] = await tg.call('getAdStats', { ad_id: Number(id), from_time: f, to_time: t, interval: iv }, A(req)); } catch (e) { out[id] = { error: e.code || U.errMessage(e) }; }
    await U.sleep(120);
  }
  res.json({ from: f, to: t, interval: iv, stats: out });
}));
app.get('/api/account-stats', wrap(async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const interval = Number(req.query.interval) === 300 ? 300 : 86400;
  const to = Number(req.query.to) || now;
  const from = Number(req.query.from) || to - 30 * 86400;
  res.json(await tg.call('getAccountStats', { from_time: from, to_time: to, interval }, A(req)));
}));
app.get('/api/leaderboard', wrap(async (req, res) => {
  const v = await loadAds(req, { refresh: req.query.refresh === '1' });
  res.json(analysis.leaderboard(v.ads, { minClicks: Number(req.query.minClicks) || 100, minSpent: Number(req.query.minSpent) || 0 }));
}));

/** Bulk actions on selected ads. */
app.post('/api/ads/action', wrap(async (req, res) => {
  const { ids = [], action, amount, cpm, daily_budget_limit, impression_frequency, fields } = req.body || {};
  if (!ids.length) return res.status(400).json({ error: 'no ads selected' });
  const delay = eff().requestDelayMs;
  const results = [];
  for (const raw of ids) {
    const ad_id = Number(raw);
    try {
      let out;
      switch (action) {
        case 'pause': out = await tg.call('editAd', { ad_id, is_paused: true }, A(req)); break;
        case 'resume': out = await tg.call('editAd', { ad_id, is_paused: false }, A(req)); break;
        case 'submit': out = await tg.call('submitAdForReview', { ad_id }, A(req)); break;
        case 'delete': out = await tg.call('deleteAd', { ad_id }, A(req)); break;
        case 'add_budget': out = await tg.call('increaseAdBudget', { ad_id, amount: Number(amount) }, A(req)); break;
        case 'remove_budget': out = await tg.call('decreaseAdBudget', { ad_id, amount: Number(amount) }, A(req)); break;
        case 'set_cpm': out = await tg.call('editAd', { ad_id, cpm: Number(cpm) }, A(req)); break;
        case 'set_daily_limit': out = await tg.call('editAd', { ad_id, daily_budget_limit: Number(daily_budget_limit) }, A(req)); break;
        case 'set_frequency': out = await tg.call('editAd', { ad_id, impression_frequency: Number(impression_frequency) }, A(req)); break;
        case 'edit': out = await tg.call('editAd', { ad_id, ...(fields || {}) }, A(req)); break;
        default: return res.status(400).json({ error: `unknown action ${action}` });
      }
      results.push({ ad_id, ok: true, status: out && out.status });
      log('ad-action', `${action} #${ad_id}${amount ? ' ' + amount : ''}`);
    } catch (e) {
      results.push({ ad_id, ok: false, error: e.code || U.errMessage(e) });
      log('error', `${action} #${ad_id} failed: ${e.code || U.errMessage(e)}`);
    }
    if (delay) await U.sleep(delay);
  }
  adCache.clear();
  res.json({ results });
}));

// ---------- bulk create (jobs) ----------
const jobs = new Map();
function newJob(total) {
  const id = crypto.randomUUID();
  const job = { id, status: 'running', total, done: 0, results: [], startedAt: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 2 * 3600 * 1000) jobs.delete(k);
  return job;
}
const bulkCtx = (req) => {
  const o = (req.body && req.body.options) || {};
  return { accountId: acct(req), pauseAfterCreate: !!o.pauseAfterCreate, submitForReview: o.submitForReview !== false, resolve: o.resolve !== false, delayMs: o.delayMs };
};
app.post('/api/csv/parse', wrap(async (req, res) => {
  const rows = require('./src/csv').parseObjects(String((req.body && req.body.csv) || ''));
  res.json({ rows, count: rows.length });
}));
app.post('/api/bulk/preview', wrap(async (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!rows.length) return res.status(400).json({ error: 'no rows' });
  if (rows.length > 1000) return res.status(400).json({ error: 'max 1000 rows per run' });
  const out = await bulk.previewRows(rows, bulkCtx(req));
  res.json({ rows: out, valid: out.filter((r) => r.valid).length, invalid: out.filter((r) => !r.valid).length });
}));
app.post('/api/bulk/run', wrap(async (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!rows.length) return res.status(400).json({ error: 'no rows' });
  if (rows.length > 1000) return res.status(400).json({ error: 'max 1000 rows per run' });
  const job = newJob(rows.length);
  const ctx = bulkCtx(req);
  bulk.runBulk(rows, ctx, (r) => { job.done++; job.results.push(r); })
    .then(() => { job.status = 'done'; job.finishedAt = Date.now(); adCache.clear(); })
    .catch((e) => { job.status = 'failed'; job.error = U.errMessage(e); job.finishedAt = Date.now(); });
  res.json({ jobId: job.id });
}));
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});
app.get('/api/bulk/template', (req, res) => {
  const cols = ['title', 'text', 'promote_url', 'cpm', 'target_type', 'placement', 'channels', 'exclude_channels', 'topics', 'exclude_topics', 'languages', 'countries', 'locations', 'device', 'audiences', 'exclude_audiences', 'bots', 'search_queries', 'impression_frequency', 'initial_budget', 'daily_budget_limit', 'is_paused', 'activate_date', 'deactivate_date', 'schedule_hours', 'schedule_days', 'schedule_tz', 'button', 'website_name', 'additional_info', 'show_userpic', 'photo_url', 'photo_id', 'video_url', 'video_id', 'conversion_event_id', 'account_id'];
  const ex = [
    { title: 'bazi_A_b1', text: 'Free cricket tips every match. Tap to join', promote_url: 'https://t.me/yourchannel', cpm: 1, target_type: 'channels', channels: '@channel1\n@channel2\n@channel3', initial_budget: 3, daily_budget_limit: 3 },
    { title: 'bot_hi', text: 'Start the bot for today\'s offer', promote_url: 'https://t.me/yourbot', cpm: 2, target_type: 'channels', languages: 'hi', topics: 'Sports', initial_budget: 3 },
    { title: 'users_india', text: 'Join now', promote_url: 'https://t.me/yourchannel', cpm: 2, target_type: 'users', countries: 'IN', device: 'android', initial_budget: 3, schedule_hours: '10-23', schedule_tz: '5.5' },
  ];
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="telegram-ads-template.csv"').send(toCSV(ex, cols));
});

// ---------- uploads ----------
app.post('/api/upload', wrap(async (req, res) => {
  const { kind, filename, mime, dataBase64 } = req.body || {};
  const method = { photo: 'uploadAdPhoto', video: 'uploadAdVideo', website: 'uploadWebsitePhoto' }[kind];
  if (!method || !dataBase64) return res.status(400).json({ error: 'kind and dataBase64 are required' });
  const buffer = Buffer.from(String(dataBase64).replace(/^data:[^,]+,/, ''), 'base64');
  const limit = { photo: 5, video: 20, website: 1 }[kind] * 1024 * 1024;
  if (buffer.length > limit) return res.status(400).json({ error: `file too large (max ${limit / 1048576} MB)` });
  let up = { filename, mime }; const notes = [];
  if (kind === 'photo' || kind === 'website') {
    try {
      const chk = require('./src/media').checkPhoto(buffer, 'this file');
      up = { filename: `${String(filename || 'photo').replace(/\.[A-Za-z0-9]+$/, '')}.${chk.info.ext}`, mime: chk.info.mime }; notes.push(...chk.notes);
    } catch (e) { return res.status(400).json({ error: U.errMessage(e) }); }
  }
  const r = await tg.upload(method, { buffer, ...up, accountId: acct(req) });
  console.log(`[media] uploaded ${kind} "${filename}" -> ${r.photo_id || r.video_id || JSON.stringify(r)} (account ${acct(req) === false ? 'main' : acct(req) || 'default'})`);
  res.json({ ...r, notes });
}));

// ---------- targeting lookups ----------
app.get('/api/targets/languages', wrap(async (req, res) => res.json(await T.languages())));
app.get('/api/targets/topics', wrap(async (req, res) => res.json(await T.topics())));
app.get('/api/targets/countries', wrap(async (req, res) => res.json(await T.countries())));
app.get('/api/targets/locations', wrap(async (req, res) => {
  const { country, q, offset } = req.query;
  if (!country || !q) return res.status(400).json({ error: 'country (2-letter) and q are required' });
  res.json(await tg.call('getTargetLocationsList', { country_code: String(country).toUpperCase(), query: q, offset, limit: 50 }, A(req)));
}));
app.get('/api/targets/channel', wrap(async (req, res) => {
  const n = T.normalizeChannel(req.query.name);
  if (n === null) return res.status(400).json({ error: 'invalid channel' });
  res.json(await tg.call('getTargetChannel', { channel_id: n }, A(req)));
}));
app.get('/api/targets/bot', wrap(async (req, res) => {
  const n = T.normalizeChannel(req.query.name, { bot: true });
  if (n === null) return res.status(400).json({ error: 'invalid bot' });
  res.json(await tg.call('getTargetBot', { bot_id: n }, A(req)));
}));
app.post('/api/channels/resolve', wrap(async (req, res) => {
  const { list, kind = 'channel' } = req.body || {};
  const { list: items, invalid } = T.normalizeList(list, { bot: kind === 'bot' });
  const found = []; const missing = [];
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const my = idx++;
      const it = items[my];
      try {
        const r = await tg.call(kind === 'bot' ? 'getTargetBot' : 'getTargetChannel', kind === 'bot' ? { bot_id: it } : { channel_id: it }, A(req));
        found.push(r);
      } catch (e) { missing.push({ value: it, error: e.code || U.errMessage(e) }); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  res.json({ found, missing, invalid, total: items.length });
}));

// ---------- analysis ----------
app.post('/api/overlap', wrap(async (req, res) => {
  const { mode = 'internal', list, statuses } = req.body || {};
  const v = await loadAds(req, { target: true, refresh: !!(req.body && req.body.refresh) });
  if (mode === 'check') return res.json(analysis.checkList(v.ads, list, statuses));
  res.json(analysis.internalOverlap(v.ads, statuses && statuses.length ? statuses : undefined));
}));
app.post('/api/batch/plan', wrap(async (req, res) => {
  const b = req.body || {};
  let exclude = T.normalizeList(b.exclude).list;
  let usedCount = 0;
  if (b.avoidUsed) {
    const v = await loadAds(req, { target: true });
    const usage = analysis.channelUsage(v.ads, { statuses: b.statuses && b.statuses.length ? b.statuses : undefined });
    const keys = [...usage.keys()];
    usedCount = keys.length;
    exclude = exclude.concat(keys.map((k) => (/^\d+$/.test(k) ? Number(k) : k)));
  }
  const plan = analysis.planBatches({ channels: b.channels, batchSize: b.batchSize, creatives: b.creatives || [], base: b.base || {}, namePrefix: b.namePrefix || 'test', exclude, shuffle: !!b.shuffle });
  res.json({ ...plan, usedChannelsInAccount: usedCount });
}));

// ---------- audiences ----------
function cleanPhones(text, hash) {
  const out = []; const seen = new Set();
  // one number per line (or separated by , or ;) so numbers written with spaces like "+91 98765 43210" stay whole
  for (const raw of String(text || '').split(/[\r\n,;]+/)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    const v = hash ? U.sha256(digits) : (raw.trim().startsWith('+') ? `+${digits}` : digits);
    if (seen.has(v)) continue;
    seen.add(v); out.push(v);
  }
  return out;
}
app.post('/api/audiences/upload', wrap(async (req, res) => {
  const { audience_id, title, phones, hash = false, mode = 'add' } = req.body || {};
  const list = cleanPhones(phones, !!hash);
  if (!list.length && mode !== 'reset') return res.status(400).json({ error: 'no valid phone numbers found' });
  const parts = U.chunk(list, 10000);
  let aud;
  if (!audience_id) {
    if (!title) return res.status(400).json({ error: 'title is required for a new audience' });
    aud = await tg.call('createAudience', { title, add_phones: parts[0] || [] }, A(req));
    for (const p of parts.slice(1)) aud = await tg.call('editAudience', { audience_id: aud.audience_id, add_phones: p }, A(req));
  } else if (mode === 'remove') {
    for (const p of parts) aud = await tg.call('editAudience', { audience_id: Number(audience_id), remove_phones: p }, A(req));
  } else if (mode === 'reset') {
    aud = await tg.call('editAudience', { audience_id: Number(audience_id), reset_phones: true, ...(parts[0] ? { add_phones: parts[0] } : {}) }, A(req));
    for (const p of parts.slice(1)) aud = await tg.call('editAudience', { audience_id: Number(audience_id), add_phones: p }, A(req));
  } else {
    for (const p of parts) aud = await tg.call('editAudience', { audience_id: Number(audience_id), add_phones: p }, A(req));
  }
  res.json({ audience: aud, sent: list.length, hashed: !!hash });
}));

// ---------- rules + monitor ----------
app.get('/api/rules', (req, res) => res.json({ rules: rulesEngine.listRules(), presets: rulesEngine.presets(), metrics: rulesEngine.METRICS, actions: rulesEngine.ACTIONS, ops: rulesEngine.OPS, monitor: rulesEngine.monitorStatus() }));
app.post('/api/rules', wrap(async (req, res) => res.json(rulesEngine.saveRule(req.body || {}))));
app.delete('/api/rules/:id', wrap(async (req, res) => { rulesEngine.deleteRule(req.params.id); res.json({ ok: true }); }));
app.post('/api/rules/run', wrap(async (req, res) => {
  const { ruleId, dry = true } = req.body || {};
  const r = await rulesEngine.runRules({ ruleId, forceDryRun: dry !== false });
  if (dry === false) adCache.clear();
  res.json(r);
}));
app.post('/api/monitor/tick', wrap(async (req, res) => res.json(await rulesEngine.tick({ manual: true }))));

// ---------- sheets ----------
app.post('/api/sheets/read', wrap(async (req, res) => {
  const r = await sheets.readSheet(req.body && req.body.url);
  res.json({ ...r, count: r.rows.length });
}));
app.post('/api/sheets/write', wrap(async (req, res) => {
  const { url, tab = 'Results', values, mode = 'replace' } = req.body || {};
  if (!Array.isArray(values) || !values.length) return res.status(400).json({ error: 'no values' });
  await sheets.writeSheet(url, tab, values, mode);
  res.json({ ok: true, rows: values.length });
}));
app.post('/api/sheets/export-ads', wrap(async (req, res) => {
  const { url, tab = 'Telegram Ads', mode = 'replace' } = req.body || {};
  const v = await loadAds(req, { refresh: true });
  const cols = ['ad_id', 'title', 'status', 'placement', 'views', 'clicks', 'actions', 'ctr', 'cvr', 'cpm', 'cpc', 'cpa', 'spent_budget', 'remaining_budget', 'daily_budget_limit', 'currency', 'created_date', 'promote_url'];
  const values = [cols.concat(['exported_at']), ...v.ads.map((a) => cols.map((c) => (c === 'created_date' && a[c] ? new Date(a[c] * 1000).toISOString() : a[c])).concat([new Date().toISOString()]))];
  await sheets.writeSheet(url, tab, values, mode);
  res.json({ ok: true, rows: v.ads.length });
}));

// ---------- logs / notify ----------
app.get('/api/logs', (req, res) => res.json({ logs: getLog(Number(req.query.limit) || 200, req.query.type || undefined) }));
app.post('/api/notify', wrap(async (req, res) => res.json(await notify(String((req.body && req.body.text) || 'test')))));

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`\n  Telegram Ads Agent running at http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
  console.log(`  Login protection: ${AUTH_ON ? 'ON' : 'off (local only)'}`);
  console.log(`  Ads token: ${eff().adsToken ? 'found' : 'missing - add it in Settings or .env'}\n`);
  if (eff().monitorEnabled) rulesEngine.startMonitor();
});
process.on('SIGINT', () => { rulesEngine.stopMonitor(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { rulesEngine.stopMonitor(); server.close(() => process.exit(0)); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); log('error', `unhandledRejection: ${U.errMessage(e)}`); });

module.exports = { app, server };
