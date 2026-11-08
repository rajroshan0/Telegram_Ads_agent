'use strict';
const crypto = require('crypto');
const { eff } = require('./cfg');
const { sleep } = require('./util');
const { log } = require('./store');

class TgError extends Error {
  constructor(code, { status, method, params, retryAfter } = {}) {
    super(`${method || 'API'}: ${code}`);
    this.name = 'TgError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.retryAfter = retryAfter;
    this.params = params;
  }
}

/** Every method of the Telegram Ads API (from the official docs). */
const METHODS = {
  // account
  createAccount: { write: true }, editAccountInfo: { write: true }, getAccountInfo: {},
  getRelatedAccountsList: {}, increaseAccountBudget: { write: true, money: true },
  decreaseAccountBudget: { write: true, money: true }, getTransactionStatus: {},
  getCurrentAccount: {}, getAccountsById: {}, getAccountTransactionsList: {},
  getAccountStats: {}, getAccountReport: {},
  // media
  uploadAdPhoto: { upload: true }, uploadAdVideo: { upload: true }, uploadWebsitePhoto: { upload: true },
  // ads
  createAd: { write: true, money: true }, editAd: { write: true }, editAdStatus: { write: true },
  increaseAdBudget: { write: true, money: true }, decreaseAdBudget: { write: true, money: true },
  submitAdForReview: { write: true }, deleteAd: { write: true, destructive: true },
  getAdsById: {}, getAdsList: {}, getAdTransactionsList: {}, getAdStats: {},
  // audiences
  createAudience: { write: true }, editAudience: { write: true }, deleteAudience: { write: true, destructive: true },
  getAudiencesById: {}, getAudiencesList: {},
  // pixel
  createPixel: { write: true }, getPixel: {}, createPixelEvent: { write: true }, editPixelEvent: { write: true },
  deletePixelEvent: { write: true, destructive: true }, getPixelEventsById: {}, getPixelEventsList: {},
  // targeting lookups
  getTargetLanguagesList: {}, getTargetTopicsList: {}, getTargetCountriesList: {}, getTargetLocationsById: {},
  getTargetLocationsList: {}, getTargetChannel: {}, getTargetBot: {},
};

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    out[k] = v;
  }
  return out;
}

class TgAds {
  /**
   * @param {string} method API method name
   * @param {object} params parameters (undefined/null are dropped)
   * @param {{accountId?: string|false, idempotencyKey?: string, noAccount?: boolean, retries?: number}} opts
   */
  async call(method, params = {}, opts = {}) {
    const c = eff();
    if (!c.adsToken) throw new TgError('NO_ADS_TOKEN: add your Telegram Ads API token in Settings', { method });
    const meta = METHODS[method];
    if (!meta) throw new TgError('UNKNOWN_METHOD', { method });

    const body = clean(params);
    if ((method === 'createAd' || method === 'editAd') && 'cpm' in body) require('./util').traceCpm(`5 sent to Telegram (${method})`, body.cpm);
    const acct = opts.accountId !== undefined ? opts.accountId : c.accountId;
    if (acct && !opts.noAccount && body.account_id === undefined && method !== 'createAccount') body.account_id = acct;
    if (meta.write && !body.idempotency_key && opts.idempotencyKey !== false) {
      body.idempotency_key = opts.idempotencyKey || crypto.randomUUID();
    }

    const maxRetries = opts.retries !== undefined ? opts.retries : (meta.write ? 2 : 3);
    let attempt = 0;
    for (;;) {
      attempt++;
      let res; let text;
      try {
        res = await this._send(c, method, body);
        text = await res.text();
      } catch (netErr) {
        if (attempt <= maxRetries) { await sleep(500 * attempt); continue; }
        throw new TgError(`NETWORK_ERROR: ${netErr.message}`, { method });
      }
      let json;
      try { json = JSON.parse(text); } catch (_) { json = null; }

      if (res.status === 429 || (json && json.ok === false && /FLOOD|TOO_MANY|RATE/i.test(String(json.error)))) {
        const ra = Number(res.headers.get('retry-after')) || 2 * attempt;
        if (attempt <= maxRetries + 2) { await sleep(Math.min(ra, 30) * 1000); continue; }
        throw new TgError(String((json && json.error) || 'RATE_LIMITED'), { status: res.status, method, retryAfter: ra });
      }
      if (res.status >= 500 && attempt <= maxRetries) { await sleep(700 * attempt); continue; }
      if (!json) throw new TgError(`BAD_RESPONSE_HTTP_${res.status}`, { status: res.status, method });
      if (json.ok !== true) {
        throw new TgError(String(json.error || `HTTP_${res.status}`), { status: res.status, method, params: safeParams(body) });
      }
      return json.result;
    }
  }

  _send(c, method, body) {
    const headers = { Authorization: `Bearer ${c.adsToken}` };
    const idem = body.idempotency_key;
    if (idem) headers['Idempotency-Key'] = idem;
    const url = `${c.base}/${method}`;
    if (c.paramEncoding === 'form') {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return fetch(url, { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(60000) });
    }
    headers['Content-Type'] = 'application/json';
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  }

  /** multipart/form-data upload for photos / videos. */
  async upload(method, { buffer, filename, mime, accountId }) {
    const c = eff();
    if (!c.adsToken) throw new TgError('NO_ADS_TOKEN: add your Telegram Ads API token in Settings', { method });
    if (!['uploadAdPhoto', 'uploadAdVideo', 'uploadWebsitePhoto'].includes(method)) throw new TgError('UNKNOWN_METHOD', { method });
    const form = new FormData();
    const acct = accountId !== undefined ? accountId : c.accountId;
    if (acct) form.append('account_id', String(acct));
    form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'file');
    let res;
    try {
      res = await fetch(`${c.base}/${method}`, {
        method: 'POST', headers: { Authorization: `Bearer ${c.adsToken}` }, body: form, signal: AbortSignal.timeout(180000),
      });
    } catch (e) { throw new TgError(`NETWORK_ERROR: ${e.message}`, { method }); }
    const json = await res.json().catch(() => null);
    if (!json || json.ok !== true) throw new TgError(String((json && json.error) || `HTTP_${res.status}`), { status: res.status, method });
    return json.result;
  }

  // ---------- helpers built on the raw methods ----------

  /** Fetch every ad of the account (handles pagination). */
  async listAllAds({ returnTarget = false, accountId } = {}) {
    const all = [];
    let offset;
    for (let i = 0; i < 200; i++) {
      const r = await this.call('getAdsList', { limit: 100, offset, return_target: returnTarget || undefined }, { accountId });
      all.push(...(r.ads || []));
      if (!r.next_offset) break;
      offset = r.next_offset;
    }
    return all;
  }

  async listAll(method, key, params = {}, pageSize = 100) {
    const all = [];
    let offset = 0;
    for (let i = 0; i < 500; i++) {
      const r = await this.call(method, { ...params, limit: pageSize, offset });
      const items = r[key] || [];
      all.push(...items);
      if (r.next_offset !== undefined && r.next_offset !== null && r.next_offset !== '') { offset = r.next_offset; continue; }
      if (items.length < pageSize || all.length >= (r.total_count ?? Infinity)) break;
      offset += pageSize;
    }
    return all;
  }
}

function safeParams(body) {
  const copy = { ...body };
  delete copy.idempotency_key;
  return copy;
}

module.exports = { TgAds, TgError, METHODS, tg: new TgAds() };
