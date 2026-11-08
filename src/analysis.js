'use strict';
const T = require('./targets');
const { chunk, parseList } = require('./util');

const LIVE = new Set(['active', 'in_review', 'on_hold', 'ready_for_review']);

/**
 * Map every channel -> ads that target it, from ads fetched with return_target.
 * @param {object[]} ads
 * @param {{statuses?: string[]}} opts statuses to include (default: all non-deleted)
 */
function channelUsage(ads, { statuses } = {}) {
  const map = new Map();
  for (const ad of ads) {
    if (statuses && statuses.length && !statuses.includes(ad.status)) continue;
    for (const c of T.adChannels(ad)) {
      if (!map.has(c.key)) map.set(c.key, { key: c.key, title: c.title, ads: [] });
      map.get(c.key).ads.push({ ad_id: ad.ad_id, title: ad.title, status: ad.status });
    }
  }
  return map;
}

/** Channels used by 2+ ads (self-competition) among live ads, plus a pair table. */
function internalOverlap(ads, statuses = ['active', 'in_review', 'on_hold', 'ready_for_review']) {
  const usage = channelUsage(ads, { statuses });
  const shared = [...usage.values()].filter((u) => u.ads.length > 1);
  const pairs = new Map();
  for (const u of shared) {
    const ids = u.ads.map((a) => a.ad_id).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}|${ids[j]}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const byId = new Map(ads.map((a) => [a.ad_id, a]));
  const pairRows = [...pairs.entries()].map(([k, n]) => {
    const [a, b] = k.split('|').map(Number);
    const sizeA = T.adChannels(byId.get(a)).length; const sizeB = T.adChannels(byId.get(b)).length;
    return { a, b, titleA: byId.get(a).title, titleB: byId.get(b).title, shared: n, pctOfSmaller: Math.round((n / Math.max(1, Math.min(sizeA, sizeB))) * 100) };
  }).sort((x, y) => y.shared - x.shared);
  return {
    channelsInUse: usage.size,
    sharedChannels: shared.length,
    shared: shared.sort((x, y) => y.ads.length - x.ads.length).slice(0, 500),
    pairs: pairRows.slice(0, 200),
  };
}

/** Compare a proposed channel list with what existing ads already use. */
function checkList(ads, rawList, statuses) {
  const { list, invalid } = T.normalizeList(rawList);
  const usage = channelUsage(ads, { statuses });
  const used = []; const free = [];
  for (const c of list) {
    const key = typeof c === 'number' ? String(c) : c.toLowerCase();
    if (usage.has(key)) used.push({ channel: c, ads: usage.get(key).ads });
    else free.push(c);
  }
  return { total: list.length, invalid, used, free, usedCount: used.length, freeCount: free.length };
}

/**
 * Build the test matrix: creatives x channel batches.
 * Returns flat rows ready for bulk preview / create.
 */
function planBatches({ channels, batchSize = 80, creatives = [], base = {}, namePrefix = 'test', exclude = [], shuffle = false, maxBatches = 200 }) {
  const { list, invalid } = T.normalizeList(channels);
  const ex = new Set(T.normalizeList(exclude).list.map((c) => (typeof c === 'number' ? String(c) : c.toLowerCase())));
  let pool = list.filter((c) => !ex.has(typeof c === 'number' ? String(c) : c.toLowerCase()));
  const removed = list.length - pool.length;
  if (shuffle) pool = pool.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const size = Math.max(1, Math.min(100, Number(batchSize) || 80));
  const groups = chunk(pool, size).slice(0, maxBatches);
  const cr = creatives.length ? creatives : [{ label: 'A', text: base.text || '' }];
  const rows = [];
  groups.forEach((g, bi) => {
    cr.forEach((c, ci) => {
      const label = (c.label || String.fromCharCode(65 + ci)).toString().replace(/\s+/g, '');
      rows.push({
        ...base,
        ...(c.photo_id ? { photo_id: c.photo_id } : {}),
        ...(c.photo_url ? { photo_url: c.photo_url } : {}),
        ...(c.promote_url ? { promote_url: c.promote_url } : {}),
        ...(c.cpm ? { cpm: c.cpm } : {}),
        title: `${namePrefix}_${label}_b${bi + 1}`,
        text: c.text || base.text,
        target_type: 'channels',
        channels: g.join('\n'),
      });
    });
  });
  return { rows, batches: groups.length, perBatch: size, totalChannels: pool.length, removedAlreadyUsed: removed, invalid };
}

/** Decide winners / losers per ad with the thresholds the user cares about. */
function leaderboard(ads, { minClicks = 100, minSpent = 0 } = {}) {
  const { metrics } = require('./util');
  const rows = ads.map((a) => ({ ...a, ...metrics(a) }));
  const ready = rows.filter((r) => (r.clicks || 0) >= minClicks && (r.spent_budget || 0) >= minSpent);
  const withCpa = ready.filter((r) => r.cpa !== null).sort((a, b) => a.cpa - b.cpa);
  const noActions = ready.filter((r) => (r.actions || 0) === 0).sort((a, b) => b.spent_budget - a.spent_budget);
  return { best: withCpa.slice(0, 10), worst: [...noActions, ...withCpa.slice().reverse()].slice(0, 10), evaluated: ready.length, tooEarly: rows.length - ready.length };
}

module.exports = { channelUsage, internalOverlap, checkList, planBatches, leaderboard, LIVE, parseList };
