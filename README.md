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
3) Copier `.env.example` vers `.env`, ne mettre que les clés sensibles (`GOLDAPI_KEY`, etc.) et `DEFAULT_CURRENCY`.
4) Placez votre CSV historique des cours (`xauusd_d.csv`) à la racine si vous voulez le mode CSV. À défaut, si vous avez des clés API, le mode API sera utilisé. Sinon, un échantillon local est utilisé.
5) (Optionnel GoldAPI) Remplir l’historique spot: `node scripts/fetch-spot-history.js [--from YYYY-MM-DD] [--currency USD]` → écrit `data/spot.timeseries.json`.
6) Lancer serveur API: `node src/server.js`. Ouvrir `http://localhost:8787/`.

## Roadmap courte
- v0: fichiers statiques + calculs locaux.
- v1: SQLite + tâches cron pour le spot (cache disque déjà présent) + conversions multi‑devises.
- v2: connecteurs prix pièces (eBay/numista/partenaires).


node src/server.js
http://localhost:8787/


prix de l'or historique : https://stooq.com/q/d/?f=20000301&t=20260205&s=xauusd&c=0
