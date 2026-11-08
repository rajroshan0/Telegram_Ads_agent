'use strict';
const crypto = require('crypto');
const { tg, TgError } = require('./tgads');
const { rules: rulesStore, state, settings, log } = require('./store');
const { eff } = require('./cfg');
const { metrics, errMessage, round, sleep } = require('./util');
const { notify } = require('./notify');

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '=': (a, b) => a === b, '!=': (a, b) => a !== b,
};
const METRICS = ['views', 'clicks', 'actions', 'spent', 'remaining', 'ctr', 'cvr', 'cpm', 'cpc', 'cpa', 'age_hours', 'daily_spent'];
const ACTIONS = ['pause', 'resume', 'notify', 'add_budget', 'set_daily_limit', 'increase_cpm_pct', 'decrease_cpm_pct', 'set_cpm'];

/** Value of one metric for one ad. null = cannot be evaluated (condition is false). */
function metricValue(ad, name) {
  const m = metrics(ad);
  switch (name) {
    case 'views': return ad.views || 0;
    case 'clicks': return ad.clicks || 0;
    case 'actions': return ad.actions || 0;
    case 'spent': return ad.spent_budget || 0;
    case 'remaining': return ad.remaining_budget || 0;
    case 'daily_spent': return ad.daily_spent_budget || 0;
    case 'ctr': return m.ctr;
    case 'cvr': return m.cvr;
    case 'cpm': return m.cpm;
    case 'cpc': return m.cpc;
    // Spent money but no action yet: the CPA is "infinite", so "cpa > X" rules can pause money-burning ads.
    case 'cpa': return m.cpa !== null ? m.cpa : ((ad.spent_budget || 0) > 0 ? Infinity : null);
    case 'age_hours': return ad.created_date ? (Date.now() / 1000 - ad.created_date) / 3600 : null;
    default: return null;
  }
}

function inScope(rule, ad) {
  const s = rule.scope || {};
  const statuses = s.statuses && s.statuses.length ? s.statuses : ['active'];
  if (!statuses.includes(ad.status)) return false;
  if (s.titleContains && !String(ad.title).toLowerCase().includes(String(s.titleContains).toLowerCase())) return false;
  if (s.titleRegex) { try { if (!new RegExp(s.titleRegex, 'i').test(ad.title)) return false; } catch (_) { return false; } }
  if (s.adIds && s.adIds.length && !s.adIds.map(Number).includes(ad.ad_id)) return false;
  return true;
}

function evaluate(rule, ad) {
  const conds = rule.conditions || [];
  if (!conds.length) return { match: false, reasons: [] };
  const reasons = [];
  for (const c of conds) {
    const v = metricValue(ad, c.metric);
    const op = OPS[c.op];
    if (!op || v === null || v === undefined) return { match: false, reasons: [] };
    if (!op(v, Number(c.value))) return { match: false, reasons: [] };
    reasons.push(`${c.metric} ${c.op} ${c.value} (is ${v === Infinity ? '∞' : round(v, 3)})`);
  }
  return { match: true, reasons };
}

async function applyAction(rule, ad, dryRun) {
  const a = rule.action || {};
  const label = `${rule.name}: "${ad.title}" #${ad.ad_id}`;
  if (a.type === 'notify') return { done: 'notify only' };
  if (dryRun) return { done: `[dry run] would ${a.type}${a.amount !== undefined ? ' ' + a.amount : ''}` };
  switch (a.type) {
    case 'pause': await tg.call('editAd', { ad_id: ad.ad_id, is_paused: true }); return { done: 'paused' };
    case 'resume': await tg.call('editAd', { ad_id: ad.ad_id, is_paused: false }); return { done: 'resumed' };
    case 'add_budget': await tg.call('increaseAdBudget', { ad_id: ad.ad_id, amount: Number(a.amount) }); return { done: `added ${a.amount} budget` };
    case 'set_daily_limit': await tg.call('editAd', { ad_id: ad.ad_id, daily_budget_limit: Number(a.amount) }); return { done: `daily limit = ${a.amount}` };
    case 'set_cpm': await tg.call('editAd', { ad_id: ad.ad_id, cpm: Number(a.amount) }); return { done: `cpm = ${a.amount}` };
    case 'increase_cpm_pct': { const n = round(ad.cpm * (1 + Number(a.amount) / 100), 2); await tg.call('editAd', { ad_id: ad.ad_id, cpm: n }); return { done: `cpm ${ad.cpm} -> ${n}` }; }
    case 'decrease_cpm_pct': { const n = round(ad.cpm * (1 - Number(a.amount) / 100), 2); await tg.call('editAd', { ad_id: ad.ad_id, cpm: n }); return { done: `cpm ${ad.cpm} -> ${n}` }; }
    default: throw new Error(`unknown action ${a.type} for ${label}`);
  }
}

/**
 * Run all enabled rules (or one) against ads.
 * @param {{ads?: object[], ruleId?: string, forceDryRun?: boolean}} opts
 */
async function runRules({ ads, ruleId, forceDryRun = false } = {}) {
  const list = (rulesStore.get().rules || []).filter((r) => (ruleId ? r.id === ruleId : r.enabled));
  if (!list.length) return { evaluated: 0, hits: [] };
  const allAds = ads || await tg.listAllAds();
  const hits = [];
  const st = state.get();
  const now = Date.now();
  for (const rule of list) {
    const cooldownMs = (Number(rule.cooldownMinutes) || 0) * 60000;
    for (const ad of allAds) {
      if (!inScope(rule, ad)) continue;
      const ev = evaluate(rule, ad);
      if (!ev.match) continue;
      const ck = `${rule.id}:${ad.ad_id}`;
      if (!forceDryRun && cooldownMs && st.cooldowns[ck] && now - st.cooldowns[ck] < cooldownMs) continue;
      if (rule.once && st.cooldowns[ck] && !forceDryRun) continue;
      const dry = forceDryRun || rule.dryRun !== false;
      const hit = { rule: rule.name, ruleId: rule.id, ad_id: ad.ad_id, title: ad.title, reasons: ev.reasons, action: rule.action && rule.action.type, dryRun: dry };
      try {
        const r = await applyAction(rule, ad, dry);
        hit.result = r.done; hit.ok = true;
        if (!dry && rule.action.type !== 'notify') { state.update((s) => { s.cooldowns[ck] = now; }); }
        if (rule.action.type === 'notify' && !forceDryRun) state.update((s) => { s.cooldowns[ck] = now; });
        log('rule', `${rule.name} → ${hit.result} · "${ad.title}" #${ad.ad_id} · ${ev.reasons.join(', ')}`, { dry });
        const alerts = eff().alerts;
        if (!forceDryRun && alerts.ruleActions !== false && (!dry || rule.action.type === 'notify')) {
          await notify(`⚙️ Rule "${rule.name}"\n${ad.title} (#${ad.ad_id})\n→ ${hit.result}\n${ev.reasons.join('\n')}`);
        }
      } catch (e) {
        hit.ok = false; hit.error = e instanceof TgError ? e.code : errMessage(e);
        log('error', `Rule "${rule.name}" failed on #${ad.ad_id}: ${hit.error}`);
      }
      hits.push(hit);
      await sleep(150);
    }
  }
  state.update((s) => { s.lastRun = new Date().toISOString(); });
  return { evaluated: allAds.length, hits };
}

// ---------- CRUD ----------
function sanitizeRule(input) {
  const r = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || 'Untitled rule').slice(0, 80),
    enabled: input.enabled !== false,
    dryRun: input.dryRun !== false, // safe by default
    cooldownMinutes: Math.max(0, Number(input.cooldownMinutes) || 0),
    once: !!input.once,
    scope: {
      statuses: Array.isArray(input.scope && input.scope.statuses) && input.scope.statuses.length ? input.scope.statuses : ['active'],
      titleContains: (input.scope && input.scope.titleContains) || '',
      titleRegex: (input.scope && input.scope.titleRegex) || '',
      adIds: ((input.scope && input.scope.adIds) || []).map(Number).filter(Number.isFinite),
    },
    conditions: (input.conditions || []).filter((c) => METRICS.includes(c.metric) && OPS[c.op] && c.value !== '' && c.value !== undefined && Number.isFinite(Number(c.value)))
      .map((c) => ({ metric: c.metric, op: c.op, value: Number(c.value) })),
    action: { type: ACTIONS.includes(input.action && input.action.type) ? input.action.type : 'notify', amount: input.action && input.action.amount !== undefined && input.action.amount !== '' ? Number(input.action.amount) : undefined },
  };
  return r;
}
function listRules() { return rulesStore.get().rules; }
function saveRule(input) {
  const r = sanitizeRule(input);
  if (!r.conditions.length) throw new Error('add at least one condition');
  if (['add_budget', 'set_daily_limit', 'increase_cpm_pct', 'decrease_cpm_pct', 'set_cpm'].includes(r.action.type) && !(r.action.amount > 0)) throw new Error('this action needs an amount above 0');
  rulesStore.update((d) => {
    const i = d.rules.findIndex((x) => x.id === r.id);
    if (i >= 0) d.rules[i] = r; else d.rules.push(r);
  });
  return r;
}
function deleteRule(id) { rulesStore.update((d) => { d.rules = d.rules.filter((r) => r.id !== id); }); }

/** Starter rules matching the test plan (all dry-run + disabled by default). */
function presets() {
  return [
    { name: 'Kill: spent ≥ 5 and CPA above 1 (or no actions)', conditions: [{ metric: 'spent', op: '>=', value: 5 }, { metric: 'clicks', op: '>=', value: 100 }, { metric: 'cpa', op: '>', value: 1 }], action: { type: 'pause' }, enabled: false, dryRun: true },
    { name: 'Warn: junk clicks (CVR < 2% after 200 clicks)', conditions: [{ metric: 'clicks', op: '>=', value: 200 }, { metric: 'cvr', op: '<', value: 2 }], action: { type: 'notify' }, enabled: false, dryRun: true, cooldownMinutes: 720 },
    { name: 'Scale: CPA < 0.1 after 100 actions → +5 budget', conditions: [{ metric: 'actions', op: '>=', value: 100 }, { metric: 'cpa', op: '<', value: 0.1 }, { metric: 'remaining', op: '<', value: 3 }], action: { type: 'add_budget', amount: 5 }, enabled: false, dryRun: true, cooldownMinutes: 360 },
  ];
}

// ---------- monitor loop (status changes, low budget, rules) ----------
let timer = null; let running = false;
async function tick({ manual = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const c = eff();
    if (!c.adsToken) return { skipped: true, reason: 'no token' };
    const ads = await tg.listAllAds();
    const alerts = c.alerts;
    const st = state.get();
    const prev = st.adStatus || {};
    const next = {};
    const msgs = [];
    for (const ad of ads) {
      next[ad.ad_id] = ad.status;
      const was = prev[ad.ad_id];
      if (was && was !== ad.status) {
        if (ad.status === 'declined' && alerts.declined !== false) {
          const reason = ad.decline_reason ? ad.decline_reason.text : 'no reason given';
          msgs.push(`🚫 Declined: ${ad.title} (#${ad.ad_id})\nReason: ${reason}`);
        } else if (alerts.statusChange !== false) {
          msgs.push(`ℹ️ ${ad.title} (#${ad.ad_id}): ${was} → ${ad.status}`);
        }
      }
      const low = Number(alerts.lowAdBudget);
      if (low > 0 && ad.status === 'active' && ad.remaining_budget < low && !(st.cooldowns[`low:${ad.ad_id}`] > Date.now() - 6 * 3600 * 1000)) {
        msgs.push(`⚠️ Low budget: ${ad.title} (#${ad.ad_id}) has ${ad.remaining_budget} ${ad.currency || ''} left`);
        state.update((s) => { s.cooldowns[`low:${ad.ad_id}`] = Date.now(); });
      }
    }
    state.update((s) => { s.adStatus = next; });
    try {
      const acct = await tg.call('getCurrentAccount', {});
      const lowA = Number(alerts.lowAccountBudget);
      if (lowA > 0 && acct.remaining_budget < lowA && !(st.cooldowns['low:account'] > Date.now() - 6 * 3600 * 1000)) {
        msgs.push(`⚠️ Account balance is low: ${acct.remaining_budget} ${acct.currency || ''}`);
        state.update((s) => { s.cooldowns['low:account'] = Date.now(); });
      }
    } catch (_) { /* optional */ }
    for (const m of msgs) { log('alert', m.replace(/\n/g, ' · ')); await notify(m); }
    const r = await runRules({ ads });
    return { ads: ads.length, alerts: msgs.length, rules: r };
  } catch (e) {
    log('error', `Monitor error: ${errMessage(e)}`);
    if (eff().alerts.errors !== false && !manual) await notify(`❌ Monitor error: ${errMessage(e)}`);
    return { error: errMessage(e) };
  } finally { running = false; }
}

function startMonitor() {
  stopMonitor();
  const c = eff();
  if (!c.monitorEnabled) return false;
  timer = setInterval(() => { tick().catch(() => {}); }, c.monitorIntervalMinutes * 60000);
  log('system', `Monitor started (every ${c.monitorIntervalMinutes} min)`);
  return true;
}
function stopMonitor() { if (timer) { clearInterval(timer); timer = null; } }
function monitorStatus() { return { running: !!timer, lastRun: state.get().lastRun, intervalMinutes: eff().monitorIntervalMinutes }; }

module.exports = { runRules, listRules, saveRule, deleteRule, presets, tick, startMonitor, stopMonitor, monitorStatus, METRICS, ACTIONS, OPS: Object.keys(OPS), evaluate, metricValue };
