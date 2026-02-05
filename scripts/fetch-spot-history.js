#!/usr/bin/env node
'use strict';
/**
 * Récupère l'historique des prix spot or (GoldAPI) une fois pour toutes
 * et l'enregistre dans data/spot.timeseries.json.
 *
 * Usage (depuis la racine du projet) :
 *   node scripts/fetch-spot-history.js
 *   node scripts/fetch-spot-history.js --from 2020-01-01
 *   node scripts/fetch-spot-history.js --from 2022-06-01 --currency EUR
 *
 * Nécessite GOLDAPI_KEY dans .env. GoldAPI limite à 5 req/s, d'où le délai entre chaque jour.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SPOT_FILE = path.join(DATA_DIR, 'spot.timeseries.json');
const DELAY_MS = Number(process.env.SPOT_HISTORY_DELAY_MS || 250);

// Charger .env
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

const { goldapiHistorical } = require(path.join(ROOT, 'src', 'lib', 'spot_providers'));

function parseArgs() {
  const args = process.argv.slice(2);
  let from = null;
  let currency = (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      from = args[++i];
    } else if (args[i] === '--currency' && args[i + 1]) {
      currency = args[++i].toUpperCase();
    }
  }
  if (!from) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    from = d.toISOString().slice(0, 10);
  }
  return { from, currency };
}

function listDays(fromStr, toStr) {
  const out = [];
  const from = new Date(fromStr + 'T00:00:00.000Z');
  const to = new Date(toStr + 'T00:00:00.000Z');
  const cur = new Date(from);
  while (cur <= to) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}${m}${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function readExisting() {
  if (!fs.existsSync(SPOT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SPOT_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function toNorm(row) {
  return {
    ts_utc: row.ts_utc,
    currency: row.currency,
    price_per_oz: row.price_per_oz,
    price_per_g: row.price_per_oz / 31.1034768,
  };
}

async function main() {
  const key = process.env.GOLDAPI_KEY;
  if (!key) {
    console.error('GOLDAPI_KEY manquant dans .env');
    process.exit(1);
  }

  const { from, currency } = parseArgs();
  const toStr = new Date().toISOString().slice(0, 10);
  const days = listDays(from, toStr);
  console.log(`Récupération de ${days.length} jours (${from} → ${toStr}) en ${currency}…`);

  const existing = readExisting();
  const haveSet = new Set(
    existing.filter(r => r.currency === currency).map(r => r.ts_utc.slice(0, 10).replace(/-/g, ''))
  );
  const toFetch = days.filter(d => !haveSet.has(d));
  if (toFetch.length === 0) {
    console.log('Aucun jour manquant, rien à faire.');
    return;
  }
  console.log(`${toFetch.length} jours à récupérer (${existing.filter(r => r.currency === currency).length} déjà en cache).`);

  const newRows = [];
  for (let i = 0; i < toFetch.length; i++) {
    await new Promise(r => setTimeout(r, DELAY_MS));
    const yyyymmdd = toFetch[i];
    try {
      const row = await goldapiHistorical(key, currency, yyyymmdd);
      newRows.push(toNorm(row));
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${toFetch.length}`);
    } catch (e) {
      console.warn(`  Erreur ${yyyymmdd}:`, e.message);
    }
  }

  const byDay = new Map();
  for (const r of existing) {
    const day = r.ts_utc.slice(0, 10);
    byDay.set(`${r.currency}|${day}`, toNorm(r));
  }
  for (const r of newRows) {
    const day = r.ts_utc.slice(0, 10);
    byDay.set(`${r.currency}|${day}`, r);
  }
  const out = Array.from(byDay.values()).sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

  fs.writeFileSync(SPOT_FILE, JSON.stringify(out, null, 2));
  console.log(`Écrit ${out.length} points dans ${SPOT_FILE}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
