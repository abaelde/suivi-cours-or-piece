'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

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

function loadQueries() {
  const p = path.join(__dirname, '..', '..', 'data', 'coin_queries.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function buildSearchUrl(query, limit = 10, filterCurrency) {
  const base = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  base.searchParams.set('q', query);
  base.searchParams.set('limit', String(limit));
  if (filterCurrency) base.searchParams.set('filter', `priceCurrency:${filterCurrency}`);
  return base.toString();
}

async function searchCoinListings(coinId, { market = 'EBAY_FR', limit = 10, currency } = {}) {
  const token = process.env.EBAY_OAUTH_TOKEN;
  if (!token) throw new Error('Missing EBAY_OAUTH_TOKEN');
  const queries = loadQueries();
  const perMarket = queries[coinId] || {};
  const variants = perMarket[market] || [];
  if (variants.length === 0) throw new Error(`No queries for coinId=${coinId} market=${market}`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': market
  };

  const seen = new Set();
  const out = [];
  for (const q of variants) {
    const url = buildSearchUrl(q, limit, currency);
    try {
      const json = await getJSON(url, headers);
      const items = json.itemSummaries || [];
      for (const it of items) {
        const id = it.itemId || it.legacyItemId || it.title;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const price = it.price?.value ? Number(it.price.value) : null;
        const curr = it.price?.currency;
        const seller = it.seller?.username || 'eBay';
        if (!price || !curr) continue;
        out.push({
          ts_utc: new Date().toISOString(),
          coin_id: coinId,
          vendor: `eBay:${seller}`,
          price,
          currency: curr,
          src_url: it.itemWebUrl || it.itemAffiliateWebUrl || null,
          condition: it.condition || null,
          title: it.title || null
        });
      }
    } catch (e) {
      // Keep going with other queries
      console.warn('eBay query failed for', q, e.message);
    }
  }
  // Sort by ts then price
  out.sort((a, b) => a.price - b.price);
  return out;
}

module.exports = { searchCoinListings };
