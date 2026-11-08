'use strict';

/** Detect the delimiter from the first line (comma, tab or semicolon). */
function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** RFC 4180 style parser. Returns array of arrays. */
function parseRows(text, delimiter) {
  text = String(text || '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Header row -> array of objects. Header names are normalised to snake_case lower-case. */
function parseObjects(text, delimiter) {
  const rows = parseRows(text, delimiter);
  if (!rows.length) return [];
  const header = rows[0].map(normHeader);
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function esc(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { parseRows, parseObjects, toCSV, normHeader };
