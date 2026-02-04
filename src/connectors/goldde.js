'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body: data });
        return reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Minimal health check: ping a lightweight endpoint on gold.de
async function healthCheck() {
  try {
    const url = 'https://www.gold.de/';
    await httpGet(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Placeholder ingestion: for dev, parse a local CSV mapping if provided.
// Real implementation would fetch daily PDF (Preisliste) and parse. Here we accept a dev CSV at data/goldde_prices.sample.csv
function loadLocalSample(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, 'utf-8').trim();
  const [head, ...lines] = text.split(/\r?\n/);
  const headers = head.split(',').map(h=>h.trim());
  return lines.filter(Boolean).map(line => {
    const cols = line.split(',');
    const obj = {}; headers.forEach((h,i)=> obj[h]= (cols[i]||'').trim());
    return {
      ts_utc: obj.ts_utc,
      coin_id: obj.coin_id,
      vendor: 'GOLD.DE',
      price: Number(obj.price),
      currency: obj.currency || 'EUR',
      src_url: obj.src_url || null,
      condition: obj.condition || null,
    };
  });
}

async function fetchLatestListings(opts = {}) {
  const source = process.env.GOLDDE_SOURCE || 'remote';
  if (source === 'file') {
    const p = process.env.GOLDDE_FILE_PATH || path.join(process.cwd(), 'data', 'goldde_prices.sample.csv');
    return loadLocalSample(p);
  }
  // Remote mode not implemented due to environment restrictions (no external deps)
  throw new Error('GOLDDE remote fetch not implemented in this environment');
}

module.exports = { healthCheck, fetchLatestListings };

