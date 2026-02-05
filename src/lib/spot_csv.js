'use strict';
const fs = require('fs');
const path = require('path');
const { parseCSV } = require('./csv');

const OZT_IN_G = 31.1034768;

function loadCsvRows(csvPath, currency = 'USD') {
  const p = path.resolve(csvPath);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf-8');
  // Expected headers: Date,Open,High,Low,Close
  const rows = parseCSV(text);
  const out = [];
  for (const r of rows) {
    const d = (r.Date || r.date || '').trim();
    const closeStr = (r.Close || r.close || '').trim();
    if (!d || !closeStr) continue;
    const price = Number(closeStr.replace(/\s/g, ''));
    if (!isFinite(price)) continue;
    const ts = d + 'T00:00:00.000Z';
    out.push({ ts_utc: ts, currency, price_per_oz: price, price_per_g: price / OZT_IN_G, source: 'csv' });
  }
  return out.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

module.exports = { loadCsvRows };

