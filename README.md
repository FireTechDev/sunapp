# SunApp

Application **100 % client-side** pour trouver les villes ensoleillées autour de vous. Aucun backend ni Node.js requis.

## Test local

**Sans localhost** : gardez `index.html` et **`places.js`** dans le **même dossier**, puis ouvrez `index.html` dans le navigateur (double-clic). Les lieux sont chargés via `<script src="places.js">` (aucun fetch, donc pas de CORS en `file://`). La météo est récupérée depuis Open-Meteo.

## Fichiers

- `index.html` : application (logique + style + UI)
- `places.js` : définit `window.SUNAPP_PLACES` (liste des lieux). À conserver dans le même dossier qu’`index.html`. Généré à partir de `places.json` si besoin.

## Stack

HTML, React + Babel (CDN), Tailwind CSS (CDN), Leaflet. Données : `places.js` (local) + API Open-Meteo (météo).

## Fonctionnement

- Géolocalisation au chargement
- Lieux : chargés via `places.js` (script tag, pas de fetch), filtrés par distance (Haversine) dans le rayon choisi (50–300 km)
- Météo : appel direct à Open-Meteo pour les coordonnées des lieux trouvés
- Filtrage « soleil » (codes 0, 1, 2) et tri par distance
- Carte Leaflet avec marqueurs
