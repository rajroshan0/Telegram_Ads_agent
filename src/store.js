'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

/** Tiny JSON file store with atomic writes. */
class JsonStore {
  constructor(name, defaults) {
    this.file = path.join(DATA_DIR, name);
    this.defaults = defaults;
    this.data = null;
    this._load();
  }
  _load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.data = JSON.parse(JSON.stringify(this.defaults));
    }
  }
  get() { return this.data; }
  set(next) { this.data = next; this._save(); return this.data; }
  update(fn) { const r = fn(this.data); this._save(); return r; }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

const DEFAULT_SETTINGS = {
  adsToken: '',
  accountId: '',
  paramEncoding: 'json',
  botToken: '',
  botChatId: '',
  googleServiceAccountJson: '',
  monitorEnabled: false,
  monitorIntervalMinutes: 15,
  requestDelayMs: 400,
  alerts: { statusChange: true, declined: true, ruleActions: true, lowAdBudget: 1, lowAccountBudget: 10, errors: true },
};

const settings = new JsonStore('settings.json', DEFAULT_SETTINGS);
const rules = new JsonStore('rules.json', { rules: [] });
const state = new JsonStore('state.json', { adStatus: {}, cooldowns: {}, lastRun: null });

// Append-only activity log kept in memory + file (capped).
const LOG_FILE = path.join(DATA_DIR, 'activity.log');
const logBuffer = [];
try {
  const old = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-500);
  for (const l of old) { try { logBuffer.push(JSON.parse(l)); } catch (_) { /* ignore */ } }
} catch (_) { /* no log yet */ }

function log(type, message, extra) {
  const entry = { t: new Date().toISOString(), type, message, ...(extra ? { extra } : {}) };
  logBuffer.push(entry);
  if (logBuffer.length > 1000) logBuffer.splice(0, logBuffer.length - 1000);
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (_) { /* ignore */ }
  return entry;
}
function getLog(limit = 200, type) {
  const rows = type ? logBuffer.filter((l) => l.type === type) : logBuffer;
  return rows.slice(-limit).reverse();
}

module.exports = { JsonStore, settings, rules, state, log, getLog, DEFAULT_SETTINGS };
