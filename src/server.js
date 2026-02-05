const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { parseCSV } = require('./lib/csv');
const { computePremium } = require('./lib/premium');
const { loadEnvOnce } = require('./lib/env');
const { goldapiLatest, metalsLatest } = require('./lib/spot_providers');
const { loadCsvRows } = require('./lib/spot_csv');
let searchCoinListings = null;
try { if (process.env.EBAY_ENABLED === 'true') { ({ searchCoinListings } = require('./connectors/ebay_browse')); } } catch {}
const goldde = require('./connectors/goldde');
const aoea = require('./connectors/achat_or_et_argent');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WEB_DIR = path.join(__dirname, '..', 'web', 'public');
const AOEA_PRICES_FILE = path.join(DATA_DIR, 'aoea-prices-latest.json');
loadEnvOnce();

// Cache AOEA (prix pièces + cours) rempli au démarrage, toujours en EUR
let AOEA_CACHE = null;
function getAoeaCache() { return AOEA_CACHE; }
function setAoeaCache(data) { AOEA_CACHE = data; }
function parseAoeaPriceStr(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.replace(/\s/g, '').replace(',', '.').match(/^([\d.]+)/);
  return m ? parseFloat(m[1], 10) : null;
}
async function refreshAoeaCache() {
  try {
    const [coursRes, vitrineRes] = await Promise.all([aoea.fetchCours(), aoea.fetchProductsVitrine()]);
    const fetchedAt = new Date().toISOString();
    const date = fetchedAt.slice(0, 10);
    const cours = (coursRes.values || []).map((c) => ({ ...c, valueg_num: parseAoeaPriceStr(c.valueg) }));
    const vitrine = vitrineRes.vitrine || [];
    const payload = { fetched_at: fetchedAt, date, cours, vitrine };
    setAoeaCache(payload);
    const outPath = path.join(DATA_DIR, `aoea-prices-${date}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ ...payload, vitrine: { description: 'Prix des pièces - Nos meilleures ventes', count: vitrine.length, items: vitrine }, cours: { description: 'Cours des métaux', values: coursRes.values } }, null, 2), 'utf-8');
    fs.writeFileSync(AOEA_PRICES_FILE, JSON.stringify(payload), 'utf-8');
    console.log('AOEA: prix pièces et cours chargés (' + vitrine.length + ' pièces, ' + cours.length + ' métaux), sauvegardé ' + outPath);
  } catch (e) {
    console.warn('AOEA: échec au chargement', e.message);
    if (fs.existsSync(AOEA_PRICES_FILE)) {
      try { setAoeaCache(JSON.parse(fs.readFileSync(AOEA_PRICES_FILE, 'utf-8'))); } catch {} 
    }
  }
}
function getMeltFromAoeaCours(coin, metal = 'or') {
  const cache = getAoeaCache();
  if (!cache || !cache.cours || !cache.cours.length) return null;
  const idMetal = metal === 'argent' ? '2' : '1';
  const c = cache.cours.find((x) => String(x.id_metal) === idMetal);
  const valueg = c && (c.valueg_num != null ? c.valueg_num : parseAoeaPriceStr(c.valueg));
  if (valueg == null) return null;
  return valueg * (coin.fine_weight_g || 0);
}
function getAoeaCoinPricesRows() {
  const cache = getAoeaCache();
  if (!cache || !cache.vitrine || !cache.vitrine.length) return [];
  const coins = loadCoins();
  const byAoeaId = new Map(coins.filter((c) => c.aoea_id_item != null).map((c) => [c.aoea_id_item, c]));
  const rows = [];
  for (const p of cache.vitrine) {
    const coin = byAoeaId.get(p.id_item);
    if (!coin) continue;
    const price = p.prixV_num != null ? p.prixV_num : parseAoeaPriceStr(p.prixV);
    if (price == null) continue;
    rows.push({
      ts_utc: cache.fetched_at,
      coin_id: coin.id,
      vendor: 'Achat Or et Argent',
      price,
      currency: 'EUR',
      src_url: p.urlItem || null,
      condition: null,
    });
  }
  return rows;
}
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase();
// Provider selection is hard-coded/auto-detected (not via .env):
// - If xauusd_d.csv exists at repo root → 'csv'
// - Else if API keys present → 'api'
// - Else → 'file' (bundled sample)
const CSV_DEFAULT_PATH = path.join(__dirname, '..', 'xauusd_d.csv');
const CSV_DEFAULT_CURRENCY = 'USD';
function detectSpotMode() {
  if (fs.existsSync(CSV_DEFAULT_PATH)) return 'csv';
  if (process.env.GOLDAPI_KEY || process.env.METALS_API_KEY) return 'api';
  return 'file';
}
const SPOT_MODE = detectSpotMode();

// Basic monthly API quota tracking (persisted in data/spot.api.quota.json)
const SPOT_QUOTA_FILE = path.join(DATA_DIR, 'spot.api.quota.json');
const SPOT_MONTHLY_LIMIT = 200; // hard-coded monthly calls cap
function readQuota() {
  try { return JSON.parse(fs.readFileSync(SPOT_QUOTA_FILE, 'utf-8')); } catch { return { month: null, calls: 0 }; }
}
function writeQuota(q) { try { fs.writeFileSync(SPOT_QUOTA_FILE, JSON.stringify(q)); } catch {} }
function mayCallApi() {
  const now = new Date();
  const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`;
  const q = readQuota();
  if (q.month !== curMonth) { q.month = curMonth; q.calls = 0; }
  const ok = q.calls < SPOT_MONTHLY_LIMIT;
  if (ok) { q.calls += 1; writeQuota(q); }
  return ok;
}
const SPOT_CACHE_FILE = path.join(DATA_DIR, 'spot.timeseries.json');
const SPOT_AUGMENT_FILE = path.join(DATA_DIR, 'spot.csv.augmented.json');
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

function loadSpotFromCsv() {
  return loadCsvRows(CSV_DEFAULT_PATH, CSV_DEFAULT_CURRENCY);
}

function readCache() {
  if (!fs.existsSync(SPOT_CACHE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SPOT_CACHE_FILE, 'utf-8')); } catch { return [] }
}

function writeCache(rows) {
  try { fs.writeFileSync(SPOT_CACHE_FILE, JSON.stringify(rows, null, 2)); } catch {}
}

function readAugment() {
  if (!fs.existsSync(SPOT_AUGMENT_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SPOT_AUGMENT_FILE, 'utf-8')); } catch { return [] }
}
function writeAugment(rows) {
  try { fs.writeFileSync(SPOT_AUGMENT_FILE, JSON.stringify(rows, null, 2)); } catch {}
}

async function fetchSpotLatest(currency = 'USD') {
  // Choose the first available API provider based on keys (no .env switch)
  if (process.env.GOLDAPI_KEY) {
    const key = process.env.GOLDAPI_KEY;
    if (!key) throw new Error('Missing GOLDAPI_KEY');
    return await goldapiLatest(key, currency);
  }
  if (process.env.METALS_API_KEY) {
    const key = process.env.METALS_API_KEY;
    if (!key) throw new Error('Missing METALS_API_KEY');
    return await metalsLatest(key, currency);
  }
  throw new Error('No API provider configured');
}

function loadCoinPrices() {
  const aoeaRows = getAoeaCoinPricesRows();
  if (aoeaRows.length) return aoeaRows;
  return [];
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

function yyyymmddFromIso(tsIso) {
  const day = toUtcDay(tsIso);
  return day.replace(/-/g, '');
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
  if (SPOT_MODE === 'file') {
    return loadSpotFromFile();
  }
  if (SPOT_MODE === 'csv') {
    const base = loadSpotFromCsv();
    const extra = readAugment();
    const byKey = new Map();
    for (const r of base.concat(extra)) {
      byKey.set(`${r.currency}|${r.ts_utc}`, r);
    }
    return Array.from(byKey.values()).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
  }
  const cache = readCache();
  if (cache && cache.length) return cache;
  // fallback to sample if cache empty
  return loadSpotFromFile();
}

async function getSpotNow(currency) {
  if (SPOT_MODE === 'file') {
    const rows = loadSpotFromFile().filter(s => s.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
    return rows[rows.length - 1] || null;
  }
  if (SPOT_MODE === 'csv') {
    const rows = loadSpotFromCsv().filter(s => s.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
    return rows[rows.length - 1] || null;
  }
  try {
    // En mode API, respecter la limite mensuelle
    let latest = null;
    if (mayCallApi()) {
      latest = await fetchSpotLatest(currency);
    } else {
      throw new Error('monthly API quota exhausted');
    }
    return { ...latest, price_per_g: latest.price_per_oz / 31.1034768 };
  } catch (e) {
    const cache = readCache().filter(s => s.currency === currency).sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
    return cache[cache.length - 1] || null;
  }
}

async function ensureSpotForDay(tsIso, currency) {
  const day = toUtcDay(tsIso);
  const wantTs = day + 'T00:00:00.000Z';
  const all = getAllSpotRows().filter(r => r.currency === currency);
  const exact = all.find(r => r.ts_utc === wantTs);
  if (exact) return exact;
  // Try GoldAPI historical for missing day, within quota
  if (process.env.GOLDAPI_KEY && mayCallApi()) {
    try {
      const row = await require('./lib/spot_providers').goldapiHistorical(process.env.GOLDAPI_KEY, currency, yyyymmddFromIso(tsIso));
      const norm = { ts_utc: wantTs, currency, price_per_oz: row.price_per_oz, price_per_g: row.price_per_oz / 31.1034768, source: 'goldapi' };
      const extra = readAugment();
      if (!extra.find(r => r.ts_utc === norm.ts_utc && r.currency === norm.currency)) {
        extra.push(norm);
        extra.sort((a,b)=>a.ts_utc.localeCompare(b.ts_utc));
        writeAugment(extra);
      }
      return norm;
    } catch (e) {
      console.warn('GoldAPI historical fallback failed:', e.message);
    }
  }
  // Fallback to nearest past value from CSV
  return nearestSpot(all, tsIso, currency);
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
      const from = query.from ? query.from.toString() : null;
      const to = query.to ? query.to.toString() : null;
      let all = [];
      if (SPOT_MODE === 'file') {
        all = loadSpotFromFile();
      } else if (SPOT_MODE === 'csv') {
        all = loadSpotFromCsv();
      } else {
        // Lire le fichier rempli par scripts/fetch-spot-history.js ; optionnellement mettre à jour le dernier jour
        all = readCache();
        if (refresh || all.length === 0) {
          try {
            let latest = null;
            if (mayCallApi()) {
              latest = await fetchSpotLatest(currency);
            } else {
              throw new Error('monthly API quota exhausted');
            }
            const norm = { ...latest, price_per_g: latest.price_per_oz / 31.1034768 };
            if (!all.find(r => r.ts_utc === norm.ts_utc && r.currency === norm.currency)) {
              all.push(norm);
              all = all.sort((a,b) => a.ts_utc.localeCompare(b.ts_utc)).slice(-SPOT_CACHE_MAX_POINTS);
              writeCache(all);
            }
          } catch (e) {
            console.warn('Spot refresh failed:', e.message);
          }
        }
        if (all.length === 0) all = loadSpotFromFile();
      }
      let rows = filterByTime(all.filter(s => s.currency === currency), from, to, 'ts_utc');
      let effectiveCurrency = currency;
      if (rows.length === 0 && all.length > 0) {
        effectiveCurrency = all[0].currency;
        rows = filterByTime(all.filter(s => s.currency === effectiveCurrency), from, to, 'ts_utc');
        res.setHeader('X-Spot-Effective-Currency', effectiveCurrency);
      }
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
      if (provider === 'aoea' || provider === 'achat-or-et-argent') {
        const { vitrine } = await aoea.fetchProductsVitrine();
        sendJSON(res, 200, { vendor: 'Achat Or et Argent', vitrine });
        return;
      }
      sendJSON(res, 400, { error: 'unknown provider (use provider=goldde|ebay|aoea)' });
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

      let priceNow = null;
      let melt = null;
      let spotTs = null;
      let tsPrice = null;
      let vendorLabel = null;

      if (currency === 'EUR') {
        const aoeaRows = loadCoinPrices().filter(r => r.coin_id === coinId && r.currency === 'EUR');
        if (aoeaRows.length) {
          priceNow = aoeaRows[0].price;
          tsPrice = aoeaRows[0].ts_utc;
          vendorLabel = aoeaRows[0].vendor;
          melt = getMeltFromAoeaCours(coin);
          if (melt != null) spotTs = getAoeaCache()?.fetched_at || tsPrice;
        }
      }

      if (priceNow == null || melt == null) {
        const spotNow = await getSpotNow(currency);
        if (!spotNow) return sendJSON(res, 503, { error: 'spot unavailable' });
        const perG = spotNow.price_per_oz / 31.1034768;
        melt = perG * coin.fine_weight_g;
        spotTs = spotNow.ts_utc;
        let prices = [];
        if (currency === 'EUR') prices = loadCoinPrices().filter(r => r.coin_id === coinId && r.currency === 'EUR');
        if (prices.length === 0 && (process.env.GOLDDE_ENABLED || 'true') === 'true') {
          try { prices = (await goldde.fetchLatestListings()).filter(p => p.coin_id === coinId && p.currency === currency); } catch (e) {}
        }
        if (prices.length === 0 && process.env.EBAY_ENABLED === 'true' && searchCoinListings) {
          try { prices = await searchCoinListings(coinId, { market, limit: 24, currency }); } catch (e) {}
        }
        if (prices.length === 0) return sendJSON(res, 404, { error: 'no prices available' });
        priceNow = median(prices.map(p => p.price)) || prices[0].price;
        tsPrice = prices.length === 1 ? prices[0].ts_utc : new Date().toISOString();
        vendorLabel = prices.length === 1 ? (prices[0].vendor || 'unknown') : `${market} median of ${prices.length}`;
      }

      const premiumPct = melt ? (priceNow / melt - 1) : null;
      sendJSON(res, 200, {
        coin_id: coinId,
        currency: currency === 'EUR' && vendorLabel === 'Achat Or et Argent' ? 'EUR' : currency,
        price_now: Number(Number(priceNow).toFixed(2)),
        melt_now: Number(melt.toFixed(2)),
        premium_now_pct: premiumPct !== null ? Number(premiumPct.toFixed(4)) : null,
        spot_ts_utc: spotTs,
        price_ts_utc: tsPrice,
        vendor: vendorLabel,
        spot_source: vendorLabel === 'Achat Or et Argent' ? 'aoea' : SPOT_MODE,
      });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/health/providers' && req.method === 'GET') {
    try {
      const statuses = [];
      // Spot provider
      const spotStatus = { key: 'spot', name: `Spot (${SPOT_MODE})`, enabled: SPOT_MODE !== 'file', configured: SPOT_MODE !== 'file' };
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

      // Achat Or et Argent (AOEA)
      const aoeaStatus = { key: 'aoea', name: 'Achat Or et Argent', enabled: true, configured: true };
      try { const h = await aoea.healthCheck(); aoeaStatus.ok = !!h.ok; aoeaStatus.last_error = h.ok ? null : h.error; }
      catch (e) { aoeaStatus.ok = false; aoeaStatus.last_error = e.message; }
      statuses.push(aoeaStatus);

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
        if (cur === 'EUR' && r.vendor === 'Achat Or et Argent') {
          const meltVal = getMeltFromAoeaCours(coin);
          if (meltVal != null) {
            out.push({
              ts_utc: r.ts_utc,
              coin_id: r.coin_id,
              vendor: r.vendor,
              currency: 'EUR',
              price: r.price,
              melt_value: Number(meltVal.toFixed(2)),
              premium_pct: Number((r.price / meltVal - 1).toFixed(4)),
              src_url: r.src_url,
              condition: r.condition,
            });
            continue;
          }
        }
        let spotRow = nearestSpot(spotRows, r.ts_utc, cur);
        if (SPOT_MODE === 'csv') {
          try { spotRow = await ensureSpotForDay(r.ts_utc, cur) || spotRow; } catch {}
        }
        if (!spotRow) {
          try { const s = await getSpotNow(cur); if (s) spotRow = s; } catch {}
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
  if (fs.existsSync(AOEA_PRICES_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(AOEA_PRICES_FILE, 'utf-8'));
      if (loaded.vitrine && loaded.cours) {
        const cours = (loaded.cours || []).map((c) => ({ ...c, valueg_num: c.valueg_num != null ? c.valueg_num : parseAoeaPriceStr(c.valueg) }));
        setAoeaCache({ ...loaded, cours });
        console.log('AOEA: cache chargé depuis fichier (' + (loaded.vitrine?.length || 0) + ' pièces)');
      }
    } catch (e) {}
  }
  refreshAoeaCache();
});
