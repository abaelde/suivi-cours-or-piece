# Analyse achat-or-et-argent.fr

## Fichiers sauvegardés

- **`data/achat-or-et-argent.html`** : HTML de la page d’accueil (récupéré par curl, ~896 lignes).

## Accès aux prix : tout passe par une API

**Les prix (cours des métaux et prix des pièces) ne sont pas présents dans le HTML.**  
Ils sont chargés en JavaScript après le chargement de la page, via l’endpoint **`POST /workerApi`**.

### 1. Cours des métaux (or, argent, platine, palladium)

- **Endpoint** : `POST https://www.achat-or-et-argent.fr/workerApi`
- **Paramètre** : `methode=getCours`
- **Réponse JSON** : `{ "values": [ ... ], "success": true }`

Chaque élément de `values` contient par exemple :

| Clé        | Exemple           | Description                    |
|------------|-------------------|--------------------------------|
| `id_metal` | `"1"`             | 1=Or, 2=Argent, 3=Platine, 4=Palladium |
| `label`    | `"Or"`            | Nom du métal                   |
| `value`    | `"131 474.00 €"`   | Cours (format affichage)        |
| `valueg`   | `"131.47 €"`       | Prix au gramme                 |
| `valueOnce`| `"4 089.30 €"`     | Prix once (pour id_metal=1)     |
| `veille`   | `"-2.75 %"`        | Variation veille                |
| `classAff` | `"moins"`         | Classe CSS (moins/plus)         |

### 2. Prix des pièces (vitrine « Nos meilleures ventes »)

- **Endpoint** : `POST https://www.achat-or-et-argent.fr/workerApi`
- **Paramètre** : `methode=getProductsVitrine`
- **Réponse JSON** : `{ "vitrine": [ ... ] }`

Chaque produit dans `vitrine` contient notamment :

| Clé           | Exemple | Description |
|---------------|---------|-------------|
| `id_item`     | 18860   | Identifiant produit |
| `nom`         | "10 Francs Marianne Coq" | Nom de la pièce |
| `prixV`       | "485.00 €" | Prix de vente affiché |
| `prixApartir` | "94.40 €" ou "" | « À partir de » (si plusieurs volumes) |
| `prixAffBF`   | ""      | Ancien prix barré (souvent vide) |
| `hasVolumes`  | true/false | Plusieurs quantités/disponibilités |
| `image1`      | URL     | Image du produit |
| `urlItem`     | URL     | Lien vers la fiche produit |

**Nombre de pièces** : c’est la longueur du tableau `vitrine` dans la réponse (ex. une dizaine d’articles en « meilleures ventes »). Pour un catalogue complet, il faudrait soit parcourir les catégories (ex. via `getVitrineCateg` avec un `idCat`), soit d’autres endpoints non analysés ici.

### 3. Autres endpoints utiles (identifiés dans le JS)

- **`/workerApi`** avec `methode=getVitrineCateg` (dans `functions.js`, appelé avec `idCat`, `sort`, `displayCat`) : produits d’une catégorie.
- **`/getCoursChart`** : données pour les graphiques de cours (paramètres : `idmetal`, `duree`, `type`, `sorte`).
- **`/getVitrineCateg`** (POST, dans `functions.js`) : autre accès aux produits par catégorie.

## Conclusion

- **Prix de l’or (et autres métaux)** : accessibles uniquement via l’API `workerApi` + `methode=getCours`.
- **Prix et caractéristiques des pièces** : accessibles via `workerApi` + `methode=getProductsVitrine` (vitrine accueil) ; pour plus de produits, utiliser les endpoints par catégorie (`getVitrineCateg` / `getVitrineCateg` côté workerApi si disponible).
- Le HTML sauvegardé ne contient que la structure et les templates (placeholders du type `__value__`, `__nom__`, etc.) ; les valeurs réelles sont injectées par le script `home-v5.js` après les appels API.

---

## Intégration dans le projet

Le connecteur **`src/connectors/achat_or_et_argent.js`** permet de récupérer les prix des pièces par une méthode :

- **`fetchProductsVitrine()`** : retourne la vitrine « Nos meilleures ventes » avec pour chaque pièce : `id_item`, `nom`, `prixV` / `prixV_num`, `prixApartir` / `prixApartir_num`, `currency`, `urlItem`, `image1`, etc.
- **`fetchCours()`** : retourne les cours des métaux (or, argent, platine, palladium).
- **`healthCheck()`** : vérification de l’accès à l’API.

**API HTTP** : `GET /prices/live?provider=aoea` retourne la vitrine (vendor + liste `vitrine`).  
**Santé** : `GET /health/providers` inclut le statut du provider `aoea`.
