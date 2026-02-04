const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { parseCSV } = require('./lib/csv');
const { computePremium } = require('./lib/premium');
const { loadEnvOnce } = require('./lib/env');
const { goldapiLatest, metalsLatest } = require('./lib/spot_providers');
let searchCoinListings = null;
try { if (process.env.EBAY_ENABLED === 'true') { ({ searchCoinListings } = require('./connectors/ebay_browse')); } } catch {}
const goldde = require('./connectors/goldde');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WEB_DIR = path.join(__dirname, '..', 'web', 'public');
loadEnvOnce();
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase();
const SPOT_PROVIDER = (process.env.SPOT_PROVIDER || 'file').toLowerCase();
const SPOT_CACHE_FILE = path.join(DATA_DIR, 'spot.timeseries.json');
const SPOT_CACHE_MAX_POINTS = Number(process.env.SPOT_CACHE_MAX_POINTS || 200000);

function sendJSON(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) { res.writeHead(404); res.end('Not Found'); }

function loadCoins() {
  const p = path.join(__dirname, '..', 'data', 'coins.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadSpotFromFile() {
  const p = path.join(__dirname, '..', 'data', 'spot.sample.csv');
  const rows = parseCSV(fs.readFileSync(p, 'utf-8'));
  return rows.map(r => ({ ts_utc: r.ts_utc, currency: r.currency, price_per_oz: Number(r.price_per_oz), price_per_g: Number(r.price_per_oz) / 31.1034768 }));
}

function readCache() {
  if (!fs.existsSync(SPOT_CACHE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SPOT_CACHE_FILE, 'utf-8')); } catch { return [] }
}

function writeCache(rows) {
  try { fs.writeFileSync(SPOT_CACHE_FILE, JSON.stringify(rows, null, 2)); } catch {}
}

async function fetchSpotLatest(currency = 'USD') {
  const provider = SPOT_PROVIDER;
  if (provider === 'goldapi') {
    const key = process.env.GOLDAPI_KEY;
    if (!key) throw new Error('Missing GOLDAPI_KEY');
    return await goldapiLatest(key, currency);
  }
  if (provider === 'metals') {
    const key = process.env.METALS_API_KEY;
    if (!key) throw new Error('Missing METALS_API_KEY');
    return await metalsLatest(key, currency);
  }
  throw new Error('Unsupported SPOT_PROVIDER: ' + provider);
}

function loadCoinPrices() {
  const p = path.join(__dirname, '..', 'data', 'coin_prices.sample.csv');
  const rows = parseCSV(fs.readFileSync(p, 'utf-8'));
  return rows.map(r => ({
    ts_utc: r.ts_utc,
    coin_id: r.coin_id,
    vendor: r.vendor,
    price: Number(r.price),
    currency: r.currency,
    src_url: r.src_url,
    condition: r.condition || null,
  }));
}

function filterByTime(rows, fromIso, toIso, key) {
  let out = rows;
  if (fromIso) out = out.filter(r => r[key] >= fromIso);
  if (toIso) out = out.filter(r => r[key] <= toIso);
  return out;
}

function toUtcDay(tsIso) {
  const d = new Date(tsIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`; // YYYY-MM-DD
}

// Reduce arbitrary timestamps to one row per (currency, day): pick last value per day
function aggregateDaily(rows) {
  const byKey = new Map();
  const sorted = rows.slice().sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
  for (const r of sorted) {
    const key = `${r.currency}|${toUtcDay(r.ts_utc)}`;
    byKey.set(key, r); // last wins
  }
  const out = [];
  for (const [key, r] of byKey.entries()) {
    const [currency, day] = key.split('|');
    const ts = day + 'T00:00:00.000Z';
    out.push({ ts_utc: ts, currency, price_per_oz: r.price_per_oz, price_per_g: r.price_per_oz / 31.1034768 });
  }
  return out.sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
}

function nearestSpot(spotRows, ts, currency) {
  const rows = spotRows.filter(s => s.currency === currency).sort((a,b) => a.ts_utc.localeCompare(b.ts_utc));
  let best = null;
  for (const s of rows) {
    if (s.ts_utc <= ts) best = s; else break;
  }
  return best || rows[0] || null;
}

function getAllSpotRows() {
  if (SPOT_PROVIDER === 'file') {
    return loadSpotFromFile();
  }
  const cache = readCache();
  if (cache && cache.length) return cache;
  // fallback to sample if cache empty
  return loadSpotFromFile();
}

async function getSpotNow(currency) {
  if (SPOT_PROVIDER === 'file') {
    const rows = loadSpotFromFile().filter(s => s.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
    return rows[rows.length - 1] || null;
  }
  try {
    const latest = await fetchSpotLatest(currency);
    return { ...latest, price_per_g: latest.price_per_oz / 31.1034768 };
  } catch (e) {
    const cache = readCache().filter(s => s.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
    return cache[cache.length - 1] || null;
  }
}

function median(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  // static files (front demo)
  if (pathname === '/' || pathname.startsWith('/web/')) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace('/web/', '');
    const filePath = path.join(WEB_DIR, rel);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.html' ? 'text/html' : (ext === '.js' ? 'application/javascript' : 'text/plain');
      res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  if (pathname === '/coins' && req.method === 'GET') {
    try {
      const data = loadCoins();
      sendJSON(res, 200, data);
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/spot' && req.method === 'GET') {
    try {
      const currency = (query.currency || DEFAULT_CURRENCY).toString().toUpperCase();
      const refresh = query.refresh === '1' || query.refresh === 'true';
      const group = (query.group || query.granularity || '').toString().toLowerCase();
      let all = [];
      if (SPOT_PROVIDER === 'file') {
        all = loadSpotFromFile();
      } else {
        // read cache, optionally refresh latest
        all = readCache();
        if (refresh || all.length === 0) {
          try {
            const latest = await fetchSpotLatest(currency);
            const norm = { ...latest, price_per_g: latest.price_per_oz / 31.1034768 };
            // append if newer
            if (!all.find(r => r.ts_utc === norm.ts_utc && r.currency === norm.currency)) {
              all.push(norm);
              // keep a generous bound; default 200k
              all = all.sort((a,b) => a.ts_utc.localeCompare(b.ts_utc)).slice(-SPOT_CACHE_MAX_POINTS);
              writeCache(all);
            }
          } catch (e) {
            // keep serving cache
            console.warn('Spot refresh failed:', e.message);
          }
        }
        if (all.length === 0) all = loadSpotFromFile();
      }
      const from = query.from ? query.from.toString() : null;
      const to = query.to ? query.to.toString() : null;
      let rows = filterByTime(all.filter(s => s.currency === currency), from, to, 'ts_utc');
      if (group === 'day' || group === 'daily') {
        rows = aggregateDaily(rows);
      }
      sendJSON(res, 200, rows);
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/prices' && req.method === 'GET') {
    try {
      const all = loadCoinPrices();
      let rows = all;
      if (query.coin_id) rows = rows.filter(r => r.coin_id === query.coin_id);
      if (query.vendor) rows = rows.filter(r => r.vendor === query.vendor);
      const from = query.from ? query.from.toString() : null;
      const to = query.to ? query.to.toString() : null;
      rows = filterByTime(rows, from, to, 'ts_utc');
      sendJSON(res, 200, rows);
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/prices/live' && req.method === 'GET') {
    try {
      const provider = (query.provider || '').toString().toLowerCase();
      if (provider === 'goldde') {
        const rows = await goldde.fetchLatestListings();
        sendJSON(res, 200, rows);
        return;
      }
      if (provider === 'ebay') {
        if (!searchCoinListings) return sendJSON(res, 400, { error: 'eBay connector disabled' });
        const coinId = (query.coin_id || '').toString();
        if (!coinId) return sendJSON(res, 400, { error: 'coin_id required' });
        const market = (query.market || process.env.EBAY_MARKETPLACE || 'EBAY_FR').toString();
        const currency = (query.currency || DEFAULT_CURRENCY).toString().toUpperCase();
        const limit = query.limit ? Number(query.limit) : 20;
        const rows = await searchCoinListings(coinId, { market, limit, currency });
        sendJSON(res, 200, rows.filter(r => r.currency === currency));
        return;
      }
      sendJSON(res, 400, { error: 'unknown provider (use provider=goldde|ebay)' });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/now' && req.method === 'GET') {
    try {
      const coinId = (query.coin_id || '').toString();
      if (!coinId) return sendJSON(res, 400, { error: 'coin_id required' });
      const currency = (query.currency || DEFAULT_CURRENCY).toString().toUpperCase();
      const market = (query.market || process.env.EBAY_MARKETPLACE || 'EBAY_FR').toString();
      const coins = loadCoins();
      const coin = coins.find(c => c.id === coinId);
      if (!coin) return sendJSON(res, 404, { error: 'unknown coin_id' });

      const spotNow = await getSpotNow(currency);
      if (!spotNow) return sendJSON(res, 503, { error: 'spot unavailable' });
      const perG = spotNow.price_per_oz / 31.1034768;
      const melt = perG * coin.fine_weight_g;

      let prices = [];
      // Prefer GOLD.DE if enabled and available
      if ((process.env.GOLDDE_ENABLED || 'true') === 'true') {
        try { prices = await goldde.fetchLatestListings(); } catch (e) { console.warn('gold.de fetch failed:', e.message); }
      }
      // Optional: eBay if explicitly enabled
      if (prices.length === 0 && process.env.EBAY_ENABLED === 'true' && searchCoinListings) {
        try { prices = await searchCoinListings(coinId, { market, limit: 24, currency }); }
        catch (e) { console.warn('eBay listings failed:', e.message); }
      }
      if (prices.length === 0) {
        // fallback to latest from CSV in matching currency
        const rows = loadCoinPrices().filter(r => r.coin_id === coinId && r.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
        const last = rows[rows.length - 1];
        if (last) prices = [last];
      }
      if (prices.length === 0) return sendJSON(res, 404, { error: 'no prices available' });

      const priceValues = prices.map(p => p.price);
      const priceNow = median(priceValues) || priceValues[0];
      const premiumPct = melt ? (priceNow / melt - 1) : null;
      const vendorLabel = prices.length === 1 ? (prices[0].vendor || 'unknown') : `${market} median of ${prices.length}`;
      const tsPrice = prices.length === 1 ? prices[0].ts_utc : new Date().toISOString();

      sendJSON(res, 200, {
        coin_id: coinId,
        currency,
        price_now: Number(priceNow.toFixed(2)),
        melt_now: Number(melt.toFixed(2)),
        premium_now_pct: premiumPct !== null ? Number(premiumPct.toFixed(4)) : null,
        spot_ts_utc: spotNow.ts_utc,
        price_ts_utc: tsPrice,
        vendor: vendorLabel,
        spot_source: SPOT_PROVIDER,
      });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/health/providers' && req.method === 'GET') {
    try {
      const statuses = [];
      // Spot provider
      const spotStatus = { key: 'spot', name: `Spot (${SPOT_PROVIDER})`, enabled: SPOT_PROVIDER !== 'file', configured: SPOT_PROVIDER !== 'file' };
      try { const s = await getSpotNow(DEFAULT_CURRENCY); spotStatus.ok = !!s; spotStatus.last_error = s ? null : 'no data'; }
      catch (e) { spotStatus.ok = false; spotStatus.last_error = e.message; }
      statuses.push(spotStatus);

      // GOLD.DE
      const golddeEnabled = (process.env.GOLDDE_ENABLED || 'true') === 'true';
      const golddeStatus = { key: 'goldde', name: 'Gold.de', enabled: golddeEnabled, configured: golddeEnabled };
      if (golddeEnabled) {
        const h = await goldde.healthCheck();
        golddeStatus.ok = !!h.ok; golddeStatus.last_error = h.ok ? null : h.error;
      } else { golddeStatus.ok = false; golddeStatus.last_error = 'disabled'; }
      statuses.push(golddeStatus);

      // eBay (explicit only)
      const ebayEnabled = process.env.EBAY_ENABLED === 'true';
      statuses.push({ key: 'ebay', name: 'eBay', enabled: ebayEnabled, configured: ebayEnabled && !!process.env.EBAY_OAUTH_TOKEN, ok: false, last_error: ebayEnabled ? 'not checked' : 'disabled' });

      sendJSON(res, 200, statuses);
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/premium' && req.method === 'GET') {
    try {
      const coins = loadCoins();
      const coinMap = new Map(coins.map(c => [c.id, c]));
      const spotRows = getAllSpotRows();
      const prices = loadCoinPrices();
      const currencyParam = (query.currency || DEFAULT_CURRENCY).toString().toUpperCase();
      let rows = prices;
      if (query.coin_id) rows = rows.filter(r => r.coin_id === query.coin_id);
      if (query.vendor) rows = rows.filter(r => r.vendor === query.vendor);
      const from = query.from ? query.from.toString() : null;
      const to = query.to ? query.to.toString() : null;
      rows = filterByTime(rows, from, to, 'ts_utc');

      const out = [];
      for (const r of rows) {
        const coin = coinMap.get(r.coin_id);
        if (!coin) continue;
        const cur = (currencyParam === 'AUTO') ? (r.currency || DEFAULT_CURRENCY) : currencyParam;
        let spotRow = nearestSpot(spotRows, r.ts_utc, cur);
        if (!spotRow) {
          try {
            const s = await getSpotNow(cur);
            if (s) spotRow = s;
          } catch {}
        }
        if (!spotRow) continue;
        const calc = computePremium({ tsUtc: spotRow.ts_utc, currency: cur, pricePerOz: spotRow.price_per_oz }, { id: coin.id, name: coin.name, fine_weight_g: coin.fine_weight_g }, r.price);
        out.push({
          ts_utc: r.ts_utc,
          coin_id: r.coin_id,
          vendor: r.vendor,
          currency: cur,
          price: r.price,
          melt_value: Number(calc.meltValue.toFixed(2)),
          premium_pct: Number((calc.premiumPct).toFixed(4)),
          src_url: r.src_url,
          condition: r.condition,
        });
      }
      sendJSON(res, 200, out);
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/health') { sendJSON(res, 200, { ok: true }); return; }

  notFound(res);
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
server.listen(PORT, () => {
  console.log(`API v0 on http://localhost:${PORT}`);
  console.log('Front demo: http://localhost:' + PORT + '/');
});
