'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile();

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  ROOT,
  DATA_DIR,
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '127.0.0.1',
  APP_PASSWORD: process.env.APP_PASSWORD || '',
  COOKIE_SECURE: String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true',
  ENV: {
    TG_ADS_TOKEN: process.env.TG_ADS_TOKEN || '',
    TG_ADS_ACCOUNT_ID: process.env.TG_ADS_ACCOUNT_ID || '',
    TG_ADS_BASE: process.env.TG_ADS_BASE || '',
    TG_PARAM_ENCODING: process.env.TG_PARAM_ENCODING || '',
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
    TG_BOT_CHAT_ID: process.env.TG_BOT_CHAT_ID || '',
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    GOOGLE_SERVICE_ACCOUNT_FILE: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
  },
};
