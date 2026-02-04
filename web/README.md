# Front-end (proposition)

- Stack: React + TypeScript (Vite) + ECharts.
- Vues:
  - Dashboard: graphe spot, sélecteur période (1j, 1s, 1m, 1a, max), devise USD/EUR.
  - Pièce: graphe prix vs valeur de fonte + courbe de prime (%), sources filtre (vendeurs/marketplace).
  - Table des pièces: recherche, tri par prime actuelle.

Composants clés:
- `<SpotChart />`, `<CoinChart />`, `<PremiumBadge />`, `<CoinSelector />`.

Int:
- Appelle `/spot`, `/coins`, `/prices`, `/premium`.
