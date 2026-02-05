'use strict';

const https = require('https');

const BASE_URL = 'www.achat-or-et-argent.fr';
const WORKER_PATH = '/workerApi';

/**
 * POST form data to workerApi.
 * @param {Record<string, string>} form - Form body (e.g. { methode: 'getProductsVitrine' })
 * @returns {Promise<object>} Parsed JSON response
 */
function postWorkerApi(form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE_URL,
        path: WORKER_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (compatible; suivi-cours-or-piece/1)',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse price string like "485.00 €" or "4 259.00 €" to { value, currency }.
 */
function parsePrice(str) {
  if (!str || typeof str !== 'string') return { value: null, currency: 'EUR' };
  const cleaned = str.replace(/\s/g, '').replace(',', '.');
  const match = cleaned.match(/^([\d.]+)\s*€?$/);
  if (!match) return { value: null, currency: 'EUR' };
  return { value: parseFloat(match[1], 10), currency: 'EUR' };
}

/**
 * Récupère les prix des pièces (vitrine "Nos meilleures ventes") via l’API du site.
 * @returns {Promise<{ vitrine: Array<object>, raw?: object }>}
 */
async function fetchProductsVitrine() {
  const raw = await postWorkerApi({ methode: 'getProductsVitrine' });
  const vitrine = Array.isArray(raw.vitrine) ? raw.vitrine : [];

  const items = vitrine.map((p) => {
    const prixV = parsePrice(p.prixV);
    const prixApartir = parsePrice(p.prixApartir);
    return {
      id_item: p.id_item,
      nom: p.nom,
      prixV: p.prixV,
      prixV_num: prixV.value,
      currency: prixV.currency,
      prixApartir: p.prixApartir || null,
      prixApartir_num: prixApartir.value,
      hasVolumes: !!p.hasVolumes,
      urlItem: p.urlItem || null,
      image1: p.image1 || null,
    };
  });

  return { vitrine: items, raw };
}

/**
 * Récupère les cours des métaux (or, argent, platine, palladium).
 * @returns {Promise<{ values: Array<object>, raw?: object }>}
 */
async function fetchCours() {
  const raw = await postWorkerApi({ methode: 'getCours' });
  const values = Array.isArray(raw.values) ? raw.values : [];
  return { values, raw };
}

async function healthCheck() {
  try {
    await postWorkerApi({ methode: 'getCours' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  fetchProductsVitrine,
  fetchCours,
  healthCheck,
  postWorkerApi,
};
