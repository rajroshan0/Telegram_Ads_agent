'use strict';
const { ENV } = require('./config');
const { settings } = require('./store');

/** Effective configuration: environment variables win over values saved from the UI. */
function eff() {
  const s = settings.get();
  return {
    adsToken: ENV.TG_ADS_TOKEN || s.adsToken || '',
    accountId: ENV.TG_ADS_ACCOUNT_ID || s.accountId || '',
    base: (ENV.TG_ADS_BASE || 'https://promoteapi.telegram.org').replace(/\/+$/, ''),
    paramEncoding: (ENV.TG_PARAM_ENCODING || s.paramEncoding || 'json').toLowerCase(),
    botToken: ENV.TG_BOT_TOKEN || s.botToken || '',
    botChatId: ENV.TG_BOT_CHAT_ID || s.botChatId || '',
    googleJson: ENV.GOOGLE_SERVICE_ACCOUNT_JSON || s.googleServiceAccountJson || '',
    googleFile: ENV.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    monitorEnabled: !!s.monitorEnabled,
    monitorIntervalMinutes: Math.max(1, Number(s.monitorIntervalMinutes) || 15),
    requestDelayMs: Math.max(0, Number(s.requestDelayMs) || 0),
    alerts: { ...(s.alerts || {}) },
  };
}

function mask(v) {
  if (!v) return '';
  const str = String(v);
  if (str.length <= 8) return '••••';
  return str.slice(0, 4) + '••••••' + str.slice(-4);
}

module.exports = { eff, mask };
