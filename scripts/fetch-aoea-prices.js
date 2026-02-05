#!/usr/bin/env node
'use strict';
/**
 * Récupère les cours des métaux et les prix des pièces (vitrine) depuis
 * Achat Or et Argent et enregistre le tout dans data/aoea-prices-YYYY-MM-DD.json.
 *
 * Usage (depuis la racine du projet) :
 *   node scripts/fetch-aoea-prices.js
 *
 * Fichier généré : data/aoea-prices-2025-02-05.json (date du jour)
 * Contenu : cours (or, argent, platine, palladium) + vitrine (meilleures ventes).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const aoea = require(path.join(ROOT, 'src', 'connectors', 'achat_or_et_argent'));

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const date = todayStr();

  console.log('Récupération des cours (or, argent, platine, palladium)...');
  const { values: cours, raw: coursRaw } = await aoea.fetchCours();

  console.log('Récupération de la vitrine (prix des pièces)...');
  const { vitrine, raw: vitrineRaw } = await aoea.fetchProductsVitrine();

  const out = {
    fetched_at: fetchedAt,
    date: date,
    source: 'https://www.achat-or-et-argent.fr',
    cours: {
      description: 'Cours des métaux (au kg ou affichés par le site)',
      values: cours,
    },
    vitrine: {
      description: 'Prix des pièces - Nos meilleures ventes',
      count: vitrine.length,
      items: vitrine,
    },
  };

  const filename = `aoea-prices-${date}.json`;
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(out, null, 2), 'utf-8');

  console.log('');
  console.log('Fichier sauvegardé :', filepath);
  console.log('  - Cours :', cours.length, 'métaux');
  console.log('  - Vitrine :', vitrine.length, 'pièces');
  console.log('');
  console.log('Aperçu cours:', cours.map((c) => `${c.label} ${c.value}`).join(' | '));
  console.log('Aperçu vitrine (3 premières):');
  vitrine.slice(0, 3).forEach((p) => {
    console.log('  -', p.nom, ':', p.prixV, p.prixApartir ? `(à partir de ${p.prixApartir})` : '');
  });
}

main().catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
