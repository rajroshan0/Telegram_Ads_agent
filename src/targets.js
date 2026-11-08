'use strict';
const { tg } = require('./tgads');
const { parseList, isBlank } = require('./util');

/** "t.me/foo", "https://t.me/foo/12", "@Foo", "foo" -> "@foo". Numeric ids stay numbers. */
function normalizeChannel(raw, { bot = false } = {}) {
  if (typeof raw === 'number') return raw;
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '').replace(/^s\//, '');
  s = s.split(/[/?#]/)[0].replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(s)) return null;
  if (bot && !/bot$/i.test(s)) return `@${s}`; // still accept; Telegram will validate
  return `@${s}`;
}

function normalizeList(list, opts) {
  const out = [];
  const bad = [];
  const seen = new Set();
  for (const raw of parseList(list, /[\s,;|]+/)) {
    const n = normalizeChannel(raw, opts);
    if (n === null) { bad.push(String(raw)); continue; }
    const key = typeof n === 'string' ? n.toLowerCase() : n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return { list: out, invalid: bad };
}

// -------- cached lookups (languages, topics, countries) --------
const cache = new Map();
async function cached(key, fn, ttlMs = 6 * 3600 * 1000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const languages = () => cached('languages', () => tg.call('getTargetLanguagesList', {}));
const topics = () => cached('topics', () => tg.call('getTargetTopicsList', {}));
const countries = () => cached('countries', () => tg.call('getTargetCountriesList', {}));

const norm = (s) => String(s).trim().toLowerCase();

/** Convert a mixed list of ids / names into ids (topics) or codes (languages / countries). */
async function resolveNames(kind, values) {
  const items = parseList(values, /[\n,;|]+/);
  if (!items.length) return { values: [], unknown: [] };
  let table; let idKey; let nameKey;
  if (kind === 'topics') { table = await topics(); idKey = 'topic_id'; nameKey = 'name'; }
  else if (kind === 'languages') { table = await languages(); idKey = 'language_code'; nameKey = 'name'; }
  else if (kind === 'countries') { table = await countries(); idKey = 'country_code'; nameKey = 'name'; }
  else throw new Error('bad kind');
  const out = [];
  const unknown = [];
  for (const it of items) {
    const s = norm(it);
    const hit = table.find((r) => norm(r[idKey]) === s) || table.find((r) => norm(r[nameKey]) === s);
    if (hit) out.push(hit[idKey]);
    else if (kind === 'topics' && /^\d+$/.test(s)) out.push(Number(s));
    else unknown.push(it);
  }
  return { values: [...new Set(out)], unknown };
}

/** Stable identity for a channel from an AdTarget (prefer username, else id). */
function channelKey(c) {
  if (c.username) return `@${String(c.username).replace(/^@/, '').toLowerCase()}`;
  return String(c.channel_id);
}

function adChannels(ad) {
  const t = ad.target;
  if (!t) return [];
  const chans = [...(t.channels || [])];
  return chans.map((c) => ({ key: channelKey(c), channel_id: c.channel_id, username: c.username, title: c.title }));
}
function adExcludedChannels(ad) {
  const t = ad.target;
  if (!t) return [];
  return (t.exclude_channels || []).map((c) => ({ key: channelKey(c), channel_id: c.channel_id, username: c.username, title: c.title }));
}

/** Human readable summary of an AdTarget. */
function describeTarget(t) {
  if (!t) return '';
  const names = (arr, k) => (arr || []).map((x) => x[k] || x.name || x.username || x.channel_id).join(', ');
  if (t.type === 'channels') {
    if (t.channels && t.channels.length) return `${t.channels.length} channels`;
    const parts = [];
    if (t.languages && t.languages.length) parts.push(names(t.languages, 'language_code'));
    if (t.topics && t.topics.length) parts.push(`${t.topics.length} topics`);
    return parts.join(', ') || 'all channels';
  }
  if (t.type === 'users') {
    const p = [];
    if (t.countries) p.push(names(t.countries, 'country_code'));
    if (t.locations && t.locations.length) p.push(`${t.locations.length} locations`);
    if (t.languages && t.languages.length) p.push(names(t.languages, 'language_code'));
    if (t.topics && t.topics.length) p.push(`${t.topics.length} interests`);
    if (t.channels && t.channels.length) p.push(`${t.channels.length} channel audiences`);
    if (t.audiences && t.audiences.length) p.push(`${t.audiences.length} audiences`);
    if (t.device) p.push(t.device);
    return p.join(' · ');
  }
  if (t.type === 'bots') return `${(t.bots || []).length} bots`;
  if (t.type === 'search') return `${(t.search_queries || []).length} queries`;
  return t.type || '';
}

/**
 * Convert an existing Ad (with target) into a flat "row" that the create form / bulk importer understands.
 * Used for Duplicate.
 */
function adToRow(ad) {
  const t = ad.target || {};
  const row = {
    title: ad.title, text: ad.text, promote_url: ad.promote_url, cpm: ad.cpm, placement: ad.placement,
    target_type: t.type, impression_frequency: ad.impression_frequency, website_name: ad.website_name,
    button: ad.button, additional_info: ad.additional_info, show_userpic: ad.show_userpic,
    daily_budget_limit: ad.daily_budget_limit, conversion_event_id: ad.conversion_event_id,
    photo_id: ad.photo && ad.photo.photo_id, video_id: ad.video && ad.video.video_id,
  };
  const ch = (arr) => (arr || []).map((c) => (c.username ? `@${String(c.username).replace(/^@/, '')}` : c.channel_id)).join('\n');
  if (t.type === 'channels') {
    row.channels = ch(t.channels); row.exclude_channels = ch(t.exclude_channels);
    row.topics = (t.topics || []).map((x) => x.topic_id).join(','); row.exclude_topics = (t.exclude_topics || []).map((x) => x.topic_id).join(',');
    row.languages = (t.languages || []).map((x) => x.language_code).join(',');
  } else if (t.type === 'users') {
    row.countries = (t.countries || []).map((x) => x.country_code).join(',');
    row.locations = (t.locations || []).map((x) => x.location_id).join(',');
    row.languages = (t.languages || []).map((x) => x.language_code).join(',');
    row.topics = (t.topics || []).map((x) => x.topic_id).join(','); row.exclude_topics = (t.exclude_topics || []).map((x) => x.topic_id).join(',');
    row.intersect_topics = t.intersect_topics; row.channels = ch(t.channels); row.exclude_channels = ch(t.exclude_channels);
    row.audiences = (t.audiences || []).map((x) => x.audience_id).join(','); row.exclude_audiences = (t.exclude_audiences || []).map((x) => x.audience_id).join(',');
    row.device = t.device; row.exclude_political_channels = t.exclude_political_channels; row.political_channels_only = t.political_channels_only;
  } else if (t.type === 'bots') {
    row.bots = (t.bots || []).map((b) => (b.username ? `@${String(b.username).replace(/^@/, '')}` : b.bot_id)).join('\n');
  } else if (t.type === 'search') {
    row.search_queries = (t.search_queries || []).join('\n');
  }
  if (ad.schedule && ad.schedule.week_hours_mask) row.schedule = JSON.stringify(ad.schedule);
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null || row[k] === '') delete row[k];
  return row;
}

module.exports = {
  normalizeChannel, normalizeList, resolveNames, languages, topics, countries, channelKey, adChannels,
  adExcludedChannels, describeTarget, adToRow, isBlank,
};
