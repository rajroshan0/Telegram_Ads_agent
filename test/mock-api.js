'use strict';
/**
 * A tiny in-memory imitation of the Telegram Ads API, used only by the tests.
 * Start with: node test/mock-api.js  (then set TG_ADS_BASE=http://localhost:4010 and TG_ADS_TOKEN=TESTTOKEN)
 */
const http = require('http');

function createMock() {
  const state = {
    account: { account_id: '1', title: 'Mock', currency: 'TON', spent_budget: 50, remaining_budget: 500, ads_budget: 100 },
    ads: [], nextId: 1, audiences: [], nextAud: 1, idem: new Map(), calls: [],
  };
  const topics = [{ topic_id: 1, name: 'Sports' }, { topic_id: 2, name: 'Betting' }, { topic_id: 3, name: 'News' }];
  const languages = [{ language_code: 'en', name: 'English' }, { language_code: 'hi', name: 'Hindi' }];
  const countries = [{ country_code: 'IN', name: 'India' }, { country_code: 'NP', name: 'Nepal' }];
  const known = new Set(['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'indiacricket', 'tipsbot']);

  const chanObj = (c) => { const u = String(c).replace(/^@/, ''); return { channel_id: 1000 + [...u].reduce((a, ch) => a + ch.charCodeAt(0), 0), title: u.toUpperCase(), username: u }; };

  function toAdTarget(t = {}) {
    const o = { type: t.type };
    if (t.type === 'channels') {
      if (t.channel_ids) o.channels = t.channel_ids.map(chanObj);
      if (t.exclude_channel_ids) o.exclude_channels = t.exclude_channel_ids.map(chanObj);
      if (t.topic_ids) o.topics = t.topic_ids.map((id) => topics.find((x) => x.topic_id === id));
      if (t.language_codes) o.languages = t.language_codes.map((c) => languages.find((x) => x.language_code === c));
    } else if (t.type === 'users') {
      o.countries = (t.country_codes || []).map((c) => countries.find((x) => x.country_code === c));
      if (t.device) o.device = t.device;
    } else if (t.type === 'bots') o.bots = (t.bot_ids || []).map((b) => ({ bot_id: 5, username: String(b).replace(/^@/, '') }));
    else if (t.type === 'search') o.search_queries = t.search_queries;
    return o;
  }

  const handlers = {
    getCurrentAccount: () => state.account,
    getRelatedAccountsList: () => ({ total_count: 0, accounts: [] }),
    getTargetTopicsList: () => topics,
    getTargetLanguagesList: () => languages,
    getTargetCountriesList: () => countries,
    getTargetChannel: (p) => { const u = String(p.channel_id).replace(/^@/, ''); if (!known.has(u.toLowerCase()) && !/^\d+$/.test(u)) throw new Error('CHANNEL_NOT_FOUND'); return chanObj(u); },
    getTargetBot: (p) => { const u = String(p.bot_id).replace(/^@/, ''); if (!known.has(u.toLowerCase())) throw new Error('BOT_NOT_FOUND'); return { bot_id: 5, title: u, username: u }; },
    getAccountReport: () => [{ ad_id: 1, ad_title: 'x', views: 100, clicks: 5, actions: 2, currency: 'TON', spent_budget: 1.5 }],
    getAccountStats: (p) => [{ from_time: p.from_time, to_time: p.to_time, views: 10, opens: 0, clicks: 1, actions: 1, currency: 'TON', spent_budget: 0.1 }],
    getAdsList: (p) => {
      const off = Number(p.offset) || 0; const lim = Math.min(100, p.limit || 100);
      const slice = state.ads.slice(off, off + lim).map((a) => { const c = { ...a }; if (!p.return_target) delete c.target; return c; });
      const next = off + lim < state.ads.length ? String(off + lim) : undefined;
      return { total_count: state.ads.length, ads: slice, ...(next ? { next_offset: next } : {}) };
    },
    getAdsById: (p) => state.ads.filter((a) => p.ad_ids.includes(a.ad_id)).map((a) => { const c = { ...a }; if (!p.return_target) delete c.target; return c; }),
    createAd: (p) => {
      if (!p.title) throw new Error('AD_TITLE_REQUIRED');
      if (!p.promote_url) throw new Error('AD_PROMOTE_URL_REQUIRED');
      if (p.title.includes('FAIL')) throw new Error('AD_TEXT_INVALID');
      if (p.initial_budget > state.account.remaining_budget) throw new Error('NOT_ENOUGH_BUDGET');
      const ad = {
        ad_id: state.nextId++, title: p.title, currency: 'TON', text: p.text, promote_url: p.promote_url, cpm: p.cpm, placement: p.placement,
        target: toAdTarget(p.target), spent_budget: 0, remaining_budget: p.initial_budget || 0, views: 0, clicks: 0, actions: 0,
        daily_budget_limit: p.daily_budget_limit, created_date: Math.floor(Date.now() / 1000), status: (p.initial_budget || 0) > 0 ? 'in_review' : 'ready_for_review',
        is_paused: !!p.is_paused, ...(p.photo_id ? { photo: { photo_id: p.photo_id, photo_url: 'x' } } : {}),
      };
      state.ads.push(ad);
      return ad;
    },
    editAd: (p) => {
      const ad = state.ads.find((a) => a.ad_id === p.ad_id); if (!ad) throw new Error('AD_NOT_FOUND');
      for (const k of ['title', 'text', 'cpm', 'daily_budget_limit', 'promote_url', 'impression_frequency']) if (p[k] !== undefined) ad[k] = p[k];
      if (p.is_paused !== undefined) { ad.is_paused = p.is_paused; ad.status = p.is_paused ? 'on_hold' : 'active'; }
      return ad;
    },
    submitAdForReview: (p) => { const ad = state.ads.find((a) => a.ad_id === p.ad_id); if (!ad) throw new Error('AD_NOT_FOUND'); ad.status = 'in_review'; return ad; },
    increaseAdBudget: (p) => { const ad = state.ads.find((a) => a.ad_id === p.ad_id); if (!ad) throw new Error('AD_NOT_FOUND'); ad.remaining_budget += p.amount; return ad; },
    decreaseAdBudget: (p) => { const ad = state.ads.find((a) => a.ad_id === p.ad_id); if (!ad) throw new Error('AD_NOT_FOUND'); ad.remaining_budget -= p.amount; return ad; },
    deleteAd: (p) => { const i = state.ads.findIndex((a) => a.ad_id === p.ad_id); if (i < 0) throw new Error('AD_NOT_FOUND'); state.ads.splice(i, 1); return true; },
    getAdStats: (p) => [{ from_time: p.from_time, to_time: p.from_time + p.interval, views: 100, opens: 0, clicks: 10, actions: 4, currency: 'TON', spent_budget: 0.5 }],
    getAudiencesList: () => ({ total_count: state.audiences.length, audiences: state.audiences }),
    createAudience: (p) => { const a = { audience_id: state.nextAud++, title: p.title, size: (p.add_phones || []).length, ads_count: 0, created_date: 1, updated_date: 1 }; state.audiences.push(a); return a; },
    editAudience: (p) => { const a = state.audiences.find((x) => x.audience_id === p.audience_id); if (!a) throw new Error('AUDIENCE_NOT_FOUND'); a.size += (p.add_phones || []).length - (p.remove_phones || []).length; if (p.reset_phones) a.size = (p.add_phones || []).length; return a; },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = req.url.replace(/^\//, '').split('?')[0];
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer TESTTOKEN') return send(401, { ok: false, error: 'UNAUTHORIZED' });
      const raw = Buffer.concat(chunks).toString('utf8');
      let params = {};
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) { try { params = JSON.parse(raw || '{}'); } catch (_) { return send(400, { ok: false, error: 'BAD_JSON' }); } }
      else if (ct.includes('urlencoded')) { for (const [k, v] of new URLSearchParams(raw)) { try { params[k] = JSON.parse(v); } catch (_) { params[k] = v; } } }
      state.calls.push({ method, params });
      if (method.startsWith('upload')) return send(200, { ok: true, result: method === 'uploadAdVideo' ? { video_id: 'vid1', video_url: 'x' } : { photo_id: 'ph1', photo_url: 'x' } });
      const idem = params.idempotency_key;
      if (idem && state.idem.has(`${method}|${idem}`)) return send(200, state.idem.get(`${method}|${idem}`), { 'Idempotent-Replayed': 'true' });
      const h = handlers[method];
      if (!h) return send(404, { ok: false, error: 'METHOD_NOT_FOUND' });
      try {
        const out = { ok: true, result: h(params) };
        if (idem) state.idem.set(`${method}|${idem}`, out);
        return send(200, out);
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    });
  });
  return { server, state };
}

if (require.main === module) {
  const { server } = createMock();
  server.listen(4010, () => console.log('mock Telegram Ads API on http://localhost:4010 (token TESTTOKEN)'));
}
module.exports = { createMock };
