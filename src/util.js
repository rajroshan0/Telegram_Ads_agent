'use strict';
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isBlank(v) { return v === undefined || v === null || (typeof v === 'string' && v.trim() === ''); }

/** Split "a, b\nc;d" style lists. */
function parseList(v, sep = /[\s,;]+/) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => !isBlank(x));
  if (isBlank(v)) return [];
  return String(v).split(sep).map((x) => x.trim()).filter(Boolean);
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (isBlank(v)) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
}

function parseNum(v) {
  if (isBlank(v)) return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/,/g, '.').replace(/[^\d.\-eE]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Accepts unix seconds, unix ms, or any Date.parse-able string. Returns unix seconds. */
function parseUnix(v) {
  if (isBlank(v)) return undefined;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function round(n, d = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Metrics shown in the Telegram Ads dashboard, computed from raw counters. */
function metrics(ad) {
  const views = ad.views || 0;
  const clicks = ad.clicks || 0;
  const actions = ad.actions || 0;
  const spent = ad.spent_budget || 0;
  return {
    ctr: views > 0 ? round((clicks / views) * 100, 2) : null,
    cvr: clicks > 0 ? round((actions / clicks) * 100, 2) : null,
    cpm: views > 0 ? round((spent / views) * 1000, 3) : null,
    cpc: clicks > 0 ? round(spent / clicks, 4) : null,
    cpa: actions > 0 ? round(spent / actions, 4) : null,
  };
}

function errMessage(e) {
  return e && e.message ? e.message : String(e);
}

/** CPM trace: prints the cpm value (and its type) at each step. Turn off with DEBUG_CPM=0. */
const cpmTrace = [];
function traceCpm(step, value) {
  const line = `${step}: ${JSON.stringify(value)} (${value === undefined ? 'undefined' : typeof value})`;
  cpmTrace.push(line); if (cpmTrace.length > 200) cpmTrace.shift();
  if (process.env.DEBUG_CPM !== '0') console.log(`[cpm] ${line}`);
}

module.exports = {
  traceCpm, cpmTrace,
  sleep, chunk, isBlank, parseList, parseBool, parseNum, parseUnix, sha256, safeEqual, round, metrics, errMessage,
};
