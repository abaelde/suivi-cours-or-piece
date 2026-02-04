# Endpoints (brouillon)

- GET /spot?from=..&to=..&currency=USD|EUR
  - Retourne timeseries du spot (oz, g).
- GET /coins
  - Liste des pièces (catalogue).
- GET /prices?coin_id=..&from=..&to=..&vendor=..
  - Timeseries de prix par pièce.
- GET /premium?coin_id=..&from=..&to=..&currency=USD|EUR
  - Calcule la prime à partir des prix pièce + spot.

Notes:
- v0: lit JSON/CSV depuis `data/`.
- v1: SQLite + Prisma, cron pour spot, adaptateurs pour vendeurs.
