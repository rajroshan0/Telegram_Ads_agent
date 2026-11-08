'use strict';
const { eff } = require('./cfg');
const { log } = require('./store');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Send a message through the user's Telegram bot. Returns {ok, error?}. */
async function notify(text, { html = false } = {}) {
  const c = eff();
  if (!c.botToken || !c.botChatId) return { ok: false, error: 'bot token or chat id not set' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c.botChatId, text: String(text).slice(0, 4000), ...(html ? { parse_mode: 'HTML' } : {}), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) { log('error', `Bot message failed: ${j.description || res.status}`); return { ok: false, error: j.description || `HTTP ${res.status}` }; }
    return { ok: true };
  } catch (e) {
    log('error', `Bot message failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function botInfo(token) {
  const t = token || eff().botToken;
  if (!t) return { ok: false, error: 'no bot token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/getMe`, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    return j.ok ? { ok: true, bot: j.result } : { ok: false, error: j.description };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { notify, botInfo, esc };
