# Suivi Cours Or & Pièces (MVP)

Objectif: visualiser le cours de l’or et des pièces (prix, prime) dans une interface simple.

## Vision MVP
- Graphe du spot or (XAU) par période.
- Fiches pièces (poids, titre, AGW) + graphe des prix et prime.
- Calcul de prime = prix_piece / (spot_par_gramme * or_fin_en_grammes) - 1.

## Périmètre MVP
- Source spot: provider d’API (configurable), stockage SQLite.
- Source prix pièces: entrée manuelle/CSV au départ, connecteurs vendeurs plus tard.
- Dev front: React (Vite/Next), graphes: ECharts/Recharts.

## Démarrage rapide (proposé)
1) Remplir `data/coins.json` si besoin.
2) Ajouter des points de prix dans `data/coin_prices.sample.csv`.
3) Copier `.env.example` vers `.env` et définir le provider spot:
   - `SPOT_PROVIDER=goldapi` et `GOLDAPI_KEY=...` (ou `SPOT_PROVIDER=metals` + `METALS_API_KEY=...`).
   - `DEFAULT_CURRENCY=USD`.
4) Lancer serveur API (Node natif): `node src/server.js`.
5) Ouvrir `http://localhost:8787/` pour le front démo.

## Roadmap courte
- v0: fichiers statiques + calculs locaux.
- v1: SQLite + tâches cron pour le spot (cache disque déjà présent) + conversions multi‑devises.
- v2: connecteurs prix pièces (eBay/numista/partenaires).


node src/server.js
http://localhost:8787/
