'use strict';
const { tg, TgError } = require('./tgads');
const { eff } = require('./cfg');
const T = require('./targets');
const { normHeader } = require('./csv');
const { parseList, parseBool, parseNum, parseUnix, isBlank, sleep, errMessage, traceCpm } = require('./util');
const { log } = require('./store');
const mediaCheck = require('./media');

/** Column aliases accepted in CSV / Sheets / forms. */
const ALIASES = {
  name: 'title', ad_name: 'title', ad_title: 'title',
  ad_text: 'text', message: 'text', copy: 'text',
  url: 'promote_url', link: 'promote_url', promote_link: 'promote_url', destination: 'promote_url',
  type: 'target_type', targeting: 'target_type',
  channel: 'channels', channel_list: 'channels', channel_ids: 'channels', target_channels: 'channels',
  exclude_channel: 'exclude_channels', exclude_channel_ids: 'exclude_channels', excluded_channels: 'exclude_channels',
  topic: 'topics', topic_ids: 'topics', interests: 'topics',
  exclude_topic: 'exclude_topics', exclude_topic_ids: 'exclude_topics', exclude_interests: 'exclude_topics',
  language: 'languages', language_codes: 'languages', langs: 'languages',
  country: 'countries', country_codes: 'countries',
  location: 'locations', location_ids: 'locations', cities: 'locations',
  bot: 'bots', bot_ids: 'bots',
  queries: 'search_queries', keywords: 'search_queries', search: 'search_queries',
  audience: 'audiences', audience_ids: 'audiences',
  exclude_audience: 'exclude_audiences', exclude_audience_ids: 'exclude_audiences',
  frequency: 'impression_frequency',
  budget: 'initial_budget', start_budget: 'initial_budget',
  daily_budget: 'daily_budget_limit', daily_limit: 'daily_budget_limit',
  paused: 'is_paused', start: 'activate_date', start_date: 'activate_date', end: 'deactivate_date', end_date: 'deactivate_date',
  userpic: 'show_userpic', event: 'conversion_event_id', pixel_event: 'conversion_event_id',
  account: 'account_id',
};

function canonicalRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const nk = normHeader(k);
    out[ALIASES[nk] || nk] = v;
  }
  return out;
}

const VALID_TIMEZONES = [-43200, -39600, -36000, -34200, -32400, -28800, -25200, -21600, -18000, -14400, -12600, -10800, -9000,
  -7200, -3600, 0, 3600, 7200, 10800, 12600, 14400, 16200, 18000, 19800, 20700, 21600, 23400, 25200, 28800, 31500, 32400,
  34200, 36000, 37800, 39600, 43200, 45900, 46800, 49500, 50400];

/** "9-23" or "9-12,18-23" -> bit mask for hours (hour h set when h in [start,end)). */
function hoursToMask(spec) {
  let mask = 0;
  for (const part of String(spec).split(/[,;]/)) {
    const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) { if (part.trim() === '') continue; throw new Error(`bad hours "${part}" (use e.g. 9-23)`); }
    let a = Number(m[1]); let b = Number(m[2]);
    if (a > 24 || b > 24) throw new Error('hours must be 0-24');
    if (b <= a) b += 24; // overnight window, wraps within same day mask
    for (let h = a; h < b; h++) mask |= 1 << (h % 24);
  }
  return mask;
}

function parseSchedule(r) {
  if (!isBlank(r.schedule)) {
    if (typeof r.schedule === 'object') return r.schedule;
    const s = String(r.schedule).trim();
    if (s.toLowerCase() === 'false' || s === '0') return false;
    try { return JSON.parse(s); } catch (_) { throw new Error('schedule must be JSON like {"week_hours_mask":[...7 numbers],"timezone":19800}'); }
  }
  if (isBlank(r.schedule_hours)) return undefined;
  const mask = hoursToMask(r.schedule_hours);
  const days = new Set();
  const dspec = isBlank(r.schedule_days) ? '1-7' : String(r.schedule_days);
  for (const part of dspec.split(/[,;]/)) {
    const m = part.trim().match(/^(\d)(?:\s*-\s*(\d))?$/);
    if (!m) throw new Error('schedule_days like 1-5 (1=Monday ... 7=Sunday)');
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let d = a; d <= b; d++) days.add(d);
  }
  const mask7 = [1, 2, 3, 4, 5, 6, 7].map((d) => (days.has(d) ? mask : 0));
  const sched = { week_hours_mask: mask7 };
  const tzRaw = isBlank(r.schedule_tz) ? 'viewer' : String(r.schedule_tz).trim().toLowerCase();
  if (tzRaw === 'viewer') sched.use_viewer_timezone = true;
  else {
    const hours = Number(tzRaw.replace('utc', '').replace('+', ''));
    const secs = Math.round(hours * 3600);
    if (!VALID_TIMEZONES.includes(secs)) throw new Error(`schedule_tz ${tzRaw} is not a supported offset`);
    sched.timezone = secs;
  }
  return sched;
}

function isTelegramLink(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return h === 't.me' || h.endsWith('.t.me') || h === 'telegram.me'; } catch (_) { return false; }
}

function inferTargetType(r) {
  const t = String(r.target_type || '').trim().toLowerCase();
  if (['channels', 'users', 'bots', 'search'].includes(t)) return t;
  if (t) return t; // let validation flag it
  if (!isBlank(r.search_queries)) return 'search';
  if (!isBlank(r.bots)) return 'bots';
  if (!isBlank(r.countries) || !isBlank(r.locations) || !isBlank(r.audiences) || !isBlank(r.device)) return 'users';
  return 'channels';
}

const DEFAULT_PLACEMENT = { channels: 'channel_post', users: 'channel_post', bots: 'bot_banner', search: 'search_result' };

/**
 * Turn one flat row into a createAd payload. Never throws; returns {payload, errors, warnings, media}.
 * `ctx.resolve` (default true) resolves topic / language / country names through the API.
 */
async function rowToPayload(rawRow, ctx = {}) {
  const r = canonicalRow(rawRow);
  const errors = []; const warnings = [];
  const resolve = ctx.resolve !== false;
  const p = {};

  // ---- basics ----
  if (isBlank(r.title)) errors.push('title is required');
  else {
    p.title = String(r.title).trim();
    if (Buffer.byteLength(p.title) > 128) errors.push('title is longer than 128 bytes');
  }
  const ttype = inferTargetType(r);
  if (!['channels', 'users', 'bots', 'search'].includes(ttype)) errors.push(`target_type "${ttype}" must be channels, users, bots or search`);

  if (isBlank(r.text)) { if (ttype !== 'search') errors.push('text is required (1-160 characters)'); }
  else {
    p.text = String(r.text).replace(/\r\n/g, '\n').trim();
    const len = [...p.text].length;
    if (len > 160) errors.push(`text has ${len} characters (max 160)`);
  }

  if (isBlank(r.promote_url)) errors.push('promote_url is required (t.me link or website)');
  else {
    p.promote_url = String(r.promote_url).trim();
    if (p.promote_url.length > 256) errors.push('promote_url is longer than 256 characters');
    if (!/^https?:\/\//i.test(p.promote_url)) {
      if (/^(t\.me|telegram\.me)\//i.test(p.promote_url)) p.promote_url = `https://${p.promote_url}`;
      else if (/^@\w+$/.test(p.promote_url)) p.promote_url = `https://t.me/${p.promote_url.slice(1)}`;
      else errors.push('promote_url must start with http(s):// or t.me/');
    }
    if (!isTelegramLink(p.promote_url)) {
      if (isBlank(r.website_name)) errors.push('website_name is required for external websites (1-40 characters)');
    }
  }

  // CPM goes through exactly one step: text -> number. Nothing else may touch it
  // (photo / video / userpic only add warnings, they never rewrite the value).
  traceCpm('2 server received (Check/Create)', rawRow && (rawRow.cpm !== undefined ? rawRow.cpm : r.cpm));
  const cpm = parseNum(r.cpm);
  if (cpm === undefined || cpm <= 0) errors.push('cpm must be a number above 0');
  else p.cpm = cpm;
  traceCpm('3 payload built', p.cpm);

  p.placement = isBlank(r.placement) ? DEFAULT_PLACEMENT[ttype] : String(r.placement).trim();
  if (p.placement && !['channel_post', 'bot_banner', 'search_result', 'video_banner'].includes(p.placement)) {
    errors.push('placement must be channel_post, bot_banner, search_result or video_banner');
  }

  // ---- target ----
  const target = { type: ttype };
  const unknown = [];
  const resolveKind = async (kind, value) => {
    if (!resolve) return parseList(value, /[\n,;|]+/);
    const res = await T.resolveNames(kind, value);
    unknown.push(...res.unknown.map((u) => `${kind.slice(0, -1)} "${u}"`));
    return res.values;
  };
  const chans = (value, label) => {
    const { list, invalid } = T.normalizeList(value);
    if (invalid.length) errors.push(`${label}: invalid entr${invalid.length > 1 ? 'ies' : 'y'} ${invalid.slice(0, 5).map((x) => `"${x}"`).join(', ')}${invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ''}. Use @username or t.me/username, separated by commas, spaces or new lines`);
    return list;
  };

  try {
    if (ttype === 'channels') {
      const ch = chans(r.channels, 'channels');
      const exch = chans(r.exclude_channels, 'exclude_channels');
      const topicIds = await resolveKind('topics', r.topics);
      const exTopics = await resolveKind('topics', r.exclude_topics);
      const langs = await resolveKind('languages', r.languages);
      if (ch.length) {
        target.channel_ids = ch;
        if (topicIds.length || langs.length) warnings.push('topics/languages are ignored because specific channels are given');
      } else {
        if (topicIds.length) { target.topic_ids = topicIds; if (langs.length !== 1) errors.push('topics need exactly one language'); }
        if (langs.length) target.language_codes = langs;
        if (!topicIds.length && !langs.length) warnings.push('no channels, topics or languages: the ad would target all channels');
        if (langs.length > 8) errors.push('max 8 languages');
      }
      if (exTopics.length) target.exclude_topic_ids = exTopics;
      if (exch.length) target.exclude_channel_ids = exch;
      if (topicIds.length + exTopics.length > 20) errors.push('max 20 topics (included + excluded)');
      if (ch.length + exch.length > 100) errors.push(`max 100 channels per ad (included + excluded); you gave ${ch.length + exch.length}`);
    } else if (ttype === 'users') {
      const cc = await resolveKind('countries', r.countries);
      const loc = parseList(r.locations).map(Number).filter(Number.isFinite);
      const langs = await resolveKind('languages', r.languages);
      const topicIds = await resolveKind('topics', r.topics);
      const exTopics = await resolveKind('topics', r.exclude_topics);
      const ch = chans(r.channels, 'channels');
      const exch = chans(r.exclude_channels, 'exclude_channels');
      const aud = parseList(r.audiences).map(Number).filter(Number.isFinite);
      const exAud = parseList(r.exclude_audiences).map(Number).filter(Number.isFinite);
      target.country_codes = cc;
      if (!cc.length) warnings.push('no country selected');
      if (cc.length > 8) errors.push('max 8 countries');
      if (loc.length) { target.location_ids = loc; if (cc.length !== 1) errors.push('locations need exactly one country'); if (loc.length > 20) errors.push('max 20 locations'); }
      if (langs.length) target.language_codes = langs;
      if (topicIds.length) target.topic_ids = topicIds;
      const inter = parseBool(r.intersect_topics); if (inter !== undefined) target.intersect_topics = inter;
      if (exTopics.length) target.exclude_topic_ids = exTopics;
      if (topicIds.length + exTopics.length > 20) errors.push('max 20 topics (included + excluded)');
      if (ch.length) target.channel_ids = ch;
      if (exch.length) target.exclude_channel_ids = exch;
      if (ch.length + exch.length > 100) errors.push('max 100 channels (included + excluded)');
      if (aud.length) target.audience_ids = aud;
      if (exAud.length) target.exclude_audience_ids = exAud;
      if (aud.length > 4 || exAud.length > 4 || aud.length + exAud.length > 10) errors.push('audiences: max 4 included, 4 excluded, 10 total');
      if (!isBlank(r.device)) {
        const d = String(r.device).trim().toLowerCase();
        if (!['ios', 'android', 'mobile', 'desktop'].includes(d)) errors.push('device must be ios, android, mobile or desktop'); else target.device = d;
      }
      const ep = parseBool(r.exclude_political_channels); if (ep !== undefined) target.exclude_political_channels = ep;
      const po = parseBool(r.political_channels_only); if (po !== undefined) target.political_channels_only = po;
    } else if (ttype === 'bots') {
      const bots = T.normalizeList(r.bots, { bot: true });
      if (bots.invalid.length) errors.push(`bots: invalid ${bots.invalid.slice(0, 5).join(', ')}`);
      if (!bots.list.length) errors.push('bots: add at least one bot username');
      if (bots.list.length > 100) errors.push('max 100 bots per ad');
      target.bot_ids = bots.list;
    } else if (ttype === 'search') {
      const q = parseList(r.search_queries, /[\n|;]+/);
      if (!q.length) errors.push('search_queries: add at least one keyword');
      if (q.length > 10) errors.push('max 10 search queries');
      target.search_queries = q;
    }
  } catch (e) {
    errors.push(`could not resolve targeting: ${errMessage(e)}`);
  }
  if (unknown.length) errors.push(`unknown values: ${unknown.slice(0, 6).join(', ')}`);
  p.target = target;

  // ---- optional fields ----
  const freq = parseNum(r.impression_frequency);
  if (freq !== undefined) { if (freq < 1 || freq > 4) errors.push('impression_frequency must be 1-4'); else p.impression_frequency = Math.round(freq); }
  if (!isBlank(r.website_name)) { p.website_name = String(r.website_name).trim(); if ([...p.website_name].length > 40) errors.push('website_name max 40 characters'); }
  if (!isBlank(r.button)) {
    const b = String(r.button).trim().toLowerCase();
    if (!['subscribe', 'view', 'read', 'learn_more', 'download', 'open', 'sign_up', 'buy', 'order', 'play', 'try', 'leave_request'].includes(b)) errors.push(`button "${b}" is not valid`);
    else p.button = b;
  }
  if (!isBlank(r.additional_info)) { p.additional_info = String(r.additional_info); if ([...p.additional_info].length > 64) errors.push('additional_info max 64 characters'); }
  const sup = parseBool(r.show_userpic); if (sup !== undefined) p.show_userpic = sup;
  if (!isBlank(r.conversion_event_id)) p.conversion_event_id = String(r.conversion_event_id).trim();
  if (!isBlank(r.website_photo_id)) p.website_photo_id = String(r.website_photo_id).trim();
  const ib = parseNum(r.initial_budget); if (ib !== undefined) { if (ib < 0) errors.push('initial_budget cannot be negative'); else p.initial_budget = ib; }
  const dbl = parseNum(r.daily_budget_limit); if (dbl !== undefined) p.daily_budget_limit = dbl;
  const paused = parseBool(r.is_paused);
  if (paused !== undefined) p.is_paused = paused; else if (ctx.pauseAfterCreate) p.is_paused = true;
  const act = parseUnix(r.activate_date); if (act !== undefined) p.activate_date = act; else if (!isBlank(r.activate_date)) errors.push('activate_date is not a valid date');
  const deact = parseUnix(r.deactivate_date); if (deact !== undefined) p.deactivate_date = deact; else if (!isBlank(r.deactivate_date)) errors.push('deactivate_date is not a valid date');
  try { const s = parseSchedule(r); if (s !== undefined) p.schedule = s; } catch (e) { errors.push(errMessage(e)); }

  // media: ids go straight in, urls are uploaded at run time
  const media = {};
  if (!isBlank(r.photo_id)) p.photo_id = String(r.photo_id).trim();
  if (!isBlank(r.video_id)) p.video_id = String(r.video_id).trim();
  if (!isBlank(r.photo_url) && !p.photo_id) media.photo_url = String(r.photo_url).trim();
  if (!isBlank(r.video_url) && !p.video_id) media.video_url = String(r.video_url).trim();
  if ((p.photo_id || media.photo_url) && (p.video_id || media.video_url)) errors.push('use either a photo or a video, not both');
  if ((p.photo_id || p.video_id || media.photo_url || media.video_url) && !['channels', 'users'].includes(ttype)) {
    warnings.push('photos/videos only work with channels or users targeting');
  }
  // Warnings only, shown when a photo / video is really set. The CPM value is never changed here.
  if (p.photo_id || media.photo_url) warnings.push(`photo ads need about 50-80% higher CPM (your CPM stays ${p.cpm})`);
  if (p.video_id || media.video_url) warnings.push(`video ads need about 70-100% higher CPM (your CPM stays ${p.cpm})`);

  const accountId = isBlank(r.account_id) ? undefined : String(r.account_id).trim();
  return { payload: p, errors, warnings, media, accountId };
}

// ---------- media download / upload ----------
async function fetchMedia(url, maxBytes, kind = 'photo') {
  if (!/^https?:\/\//i.test(url)) throw new Error('media url must start with http(s)://');
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`file is too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file is too large (${buf.length} bytes)`);
  let name = 'file';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file'); } catch (_) { /* keep default */ }
  if (kind === 'photo') {
    // look at the real bytes: the content-type of image hosts is often wrong, and share pages are HTML
    const { info, notes } = mediaCheck.checkPhoto(buf, `the link ${url}`);
    name = `${name.replace(/\.[A-Za-z0-9]+$/, '') || 'photo'}.${info.ext}`;
    console.log(`[media] downloaded ${url} -> ${info.type} ${info.width || '?'}x${info.height || '?'} ${buf.length} bytes`);
    return { buffer: buf, filename: name, mime: info.mime, notes };
  }
  const vi = mediaCheck.sniff(buf);
  if (vi.type !== 'mp4') throw new Error(`the link ${url} is not an MP4 video`);
  return { buffer: buf, filename: name.endsWith('.mp4') ? name : `${name}.mp4`, mime: 'video/mp4', notes: [] };
}

async function ensureMedia(media, payload, accountId, cache, notes = []) {
  if (media.photo_url) {
    const key = `p|${accountId || ''}|${media.photo_url}`;
    if (!cache.has(key)) {
      const f = await fetchMedia(media.photo_url, 5 * 1024 * 1024, 'photo');
      const r = await tg.upload('uploadAdPhoto', { ...f, accountId });
      if (!r || !r.photo_id) throw new Error('Telegram accepted the upload but returned no photo_id');
      console.log(`[media] uploaded photo -> photo_id ${r.photo_id} (account ${accountId === false ? 'main' : accountId || 'default'})`);
      cache.set(key, { id: r.photo_id, notes: f.notes });
    }
    notes.push(...cache.get(key).notes);
    payload.photo_id = cache.get(key).id;
  }
  if (media.video_url) {
    const key = `v|${accountId || ''}|${media.video_url}`;
    if (!cache.has(key)) {
      const f = await fetchMedia(media.video_url, 20 * 1024 * 1024, 'video');
      const r = await tg.upload('uploadAdVideo', { ...f, accountId });
      if (!r || !r.video_id) throw new Error('Telegram accepted the upload but returned no video_id');
      cache.set(key, { id: r.video_id, notes: [] });
    }
    payload.video_id = cache.get(key).id;
  }
}

/** Validate all rows without touching the API (except lookups of names). */
async function previewRows(rows, ctx = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = await rowToPayload(rows[i], ctx);
    out.push({ index: i, title: r.payload.title || '', valid: r.errors.length === 0, errors: r.errors, warnings: r.warnings, payload: r.payload, media: r.media, accountId: r.accountId });
  }
  return out;
}

const FATAL = /NO_ADS_TOKEN|UNAUTHORIZED|ACCESS_TOKEN|AUTH|NOT_ENOUGH_BUDGET|ACCOUNT.*(BLOCK|SUSPEND|BANNED)/i;

/**
 * Create all valid rows one by one. `onProgress(result)` is called after each row.
 */
async function runBulk(rows, ctx = {}, onProgress) {
  const delay = ctx.delayMs !== undefined ? ctx.delayMs : eff().requestDelayMs;
  const mediaCache = new Map();
  const results = [];
  let aborted = null;
  const runId = Date.now().toString(36);
  for (let i = 0; i < rows.length; i++) {
    let res;
    if (aborted) {
      res = { index: i, title: String(rows[i].title || rows[i].name || ''), ok: false, skipped: true, error: `skipped: ${aborted}` };
    } else {
      const built = await rowToPayload(rows[i], ctx);
      res = { index: i, title: built.payload.title || '', warnings: built.warnings };
      if (built.errors.length) { res.ok = false; res.error = built.errors.join('; '); }
      else {
        try {
          const accountId = built.accountId !== undefined ? built.accountId : ctx.accountId;
          const mediaNotes = [];
          await ensureMedia(built.media, built.payload, accountId, mediaCache, mediaNotes);
          if (mediaNotes.length) res.warnings = [...(res.warnings || []), ...new Set(mediaNotes)];
          const payload = { ...built.payload, return_target: false };
          traceCpm('4 about to call createAd', payload.cpm);
          const ad = await tg.call('createAd', payload, { accountId: accountId === undefined ? undefined : accountId, idempotencyKey: `${runId}-${i}-${Buffer.from(payload.title).toString('hex').slice(0, 24)}` });
          res.ok = true; res.ad_id = ad.ad_id; res.status = ad.status;
          if (payload.photo_id || payload.video_id) {
            const kept = !!(ad.photo || ad.video);
            console.log(`[media] ad #${ad.ad_id}: sent ${payload.photo_id ? 'photo_id ' + payload.photo_id : 'video_id ' + payload.video_id}, Telegram returned ${kept ? 'a photo/video' : 'NO photo/video'}`);
            if (!kept && ad.title !== undefined) res.warnings = [...(res.warnings || []), 'Telegram created the ad but did NOT attach the picture. Photo ids belong to one account: upload and create in the same account (check the account selector at the top)'];
          }
          if (ad.status === 'ready_for_review' && ctx.submitForReview !== false) {
            try { const s = await tg.call('submitAdForReview', { ad_id: ad.ad_id }, { accountId }); res.status = s.status; } catch (e) { res.warnings = [...(res.warnings || []), `created but not submitted: ${errMessage(e)}`]; }
          }
          log('create', `Created ad "${payload.title}" (#${ad.ad_id})`, { ad_id: ad.ad_id });
        } catch (e) {
          res.ok = false; res.error = e instanceof TgError ? e.code : errMessage(e);
          log('error', `Create failed for "${res.title}": ${res.error}`);
          if (FATAL.test(res.error)) aborted = res.error;
        }
        if (delay && i < rows.length - 1) await sleep(delay);
      }
    }
    results.push(res);
    if (onProgress) onProgress(res, i, rows.length);
  }
  return results;
}

module.exports = { canonicalRow, rowToPayload, previewRows, runBulk, hoursToMask, parseSchedule, ALIASES, DEFAULT_PLACEMENT };
