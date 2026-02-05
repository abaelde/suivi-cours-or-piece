'use strict';
const https = require('https');

function getJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// GoldAPI: https://www.goldapi.io — real-time et historique (date YYYYMMDD depuis 1968 en USD)
async function goldapiLatest(key, currency = 'USD') {
  const url = `https://www.goldapi.io/api/XAU/${encodeURIComponent(currency)}`;
  const json = await getJSON(url, { 'x-access-token': key, 'Accept': 'application/json' });
  if (!json || typeof json.price !== 'number') throw new Error('GoldAPI malformed response');
  return {
    ts_utc: new Date((json.timestamp || json.updated_at || Date.now()/1000)*1000).toISOString(),
    currency,
    price_per_oz: json.price,
    source: 'goldapi',
  };
}

/** Prix historique pour une date donnée. dateStr = YYYYMMDD (ex: 20240204). */
async function goldapiHistorical(key, currency, dateStr) {
  const url = `https://www.goldapi.io/api/XAU/${encodeURIComponent(currency)}/${dateStr}`;
  const json = await getJSON(url, { 'x-access-token': key, 'Accept': 'application/json' });
  if (!json || typeof json.price !== 'number') throw new Error('GoldAPI malformed response');
  const ts = json.timestamp ? new Date(json.timestamp * 1000) : new Date(Date.UTC(parseInt(dateStr.slice(0, 4), 10), parseInt(dateStr.slice(4, 6), 10) - 1, parseInt(dateStr.slice(6, 8), 10)));
  return {
    ts_utc: ts.toISOString().slice(0, 10) + 'T00:00:00.000Z',
    currency,
    price_per_oz: json.price,
    source: 'goldapi',
  };
}

// Metals-API: https://metals-api.com/documentation
async function metalsLatest(key, currency = 'USD') {
  // Use base=XAU to get USD/EUR per ounce of gold, then pick currency
  const url = `https://metals-api.com/api/latest?access_key=${encodeURIComponent(key)}&base=XAU&symbols=USD,EUR`;
  const json = await getJSON(url, { 'Accept': 'application/json' });
  if (!json || !json.rates || !json.rates.USD) throw new Error('Metals-API malformed response');
  return {
    ts_utc: new Date((json.timestamp || Date.now()/1000)*1000).toISOString(),
    currency,
    price_per_oz: json.rates[currency],
    source: 'metals',
  };
}

module.exports = { goldapiLatest, goldapiHistorical, metalsLatest };
