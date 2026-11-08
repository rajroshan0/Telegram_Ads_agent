'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { eff } = require('./cfg');
const { parseRows, normHeader } = require('./csv');

function parseSheetUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('This does not look like a Google Sheets link (https://docs.google.com/spreadsheets/d/...)');
  const g = String(url).match(/[#&?]gid=(\d+)/);
  return { id: m[1], gid: g ? g[1] : '0' };
}

function serviceAccount() {
  const c = eff();
  let raw = c.googleJson;
  if (!raw && c.googleFile) { try { raw = fs.readFileSync(c.googleFile, 'utf8'); } catch (_) { /* ignore */ } }
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j.client_email && j.private_key ? j : null; } catch (_) { return null; }
}

let tokenCache = { token: '', exp: 0 };
async function accessToken() {
  const sa = serviceAccount();
  if (!sa) throw new Error('Add a Google service-account JSON in Settings (and share the sheet with its email) to use private sheets or write back.');
  if (tokenCache.token && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const uri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: uri, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch(uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }), signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Google auth failed: ${j.error_description || j.error || res.status}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gfetch(url, opts = {}) {
  const token = await accessToken();
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets: ${(j.error && j.error.message) || res.status}`);
  return j;
}

async function tabTitleByGid(id, gid) {
  const meta = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
  const s = (meta.sheets || []).find((x) => String(x.properties.sheetId) === String(gid)) || meta.sheets[0];
  return s.properties.title;
}

/** Read a sheet into array of objects (header row -> keys). Tries the public CSV export first. */
async function readSheet(url) {
  const { id, gid } = parseSheetUrl(url);
  let rows;
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, { redirect: 'follow', signal: AbortSignal.timeout(45000) });
    const type = res.headers.get('content-type') || '';
    if (res.ok && !type.includes('text/html')) rows = parseRows(await res.text(), ',');
  } catch (_) { /* fall through to API */ }
  if (!rows) {
    const title = await tabTitleByGid(id, gid);
    const j = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${title}'`)}?majorDimension=ROWS`);
    rows = (j.values || []).map((r) => r.map((c) => String(c)));
  }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map(normHeader);
  const objs = rows.slice(1).map((r) => { const o = {}; header.forEach((h, i) => { if (h) o[h] = r[i] === undefined ? '' : r[i]; }); return o; })
    .filter((o) => Object.values(o).some((v) => String(v).trim() !== ''));
  return { header, rows: objs };
}

/** Write a 2-D array to a tab (creates it if needed). mode: "replace" | "append". */
async function writeSheet(url, tab, values, mode = 'replace') {
  const { id } = parseSheetUrl(url);
  const meta = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
  const exists = (meta.sheets || []).some((s) => s.properties.title === tab);
  if (!exists) {
    await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
  }
  const range = encodeURIComponent(`'${tab}'`);
  const body = JSON.stringify({ majorDimension: 'ROWS', values: values.map((r) => r.map((c) => (c === null || c === undefined ? '' : c))) });
  if (mode === 'append') {
    return gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', body });
  }
  await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:clear`, { method: 'POST', body: '{}' });
  return gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueInputOption=USER_ENTERED`, { method: 'PUT', body });
}

function saEmail() { const s = serviceAccount(); return s ? s.client_email : null; }

module.exports = { readSheet, writeSheet, parseSheetUrl, saEmail };
