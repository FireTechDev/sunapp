# SunApp

Application **100 % client-side** pour trouver des zones ensoleillées autour de vous. Aucun backend ni Node.js requis.

## Test local

Servez le dossier via un serveur statique (HTTP/HTTPS).  
Exemple rapide :

```bash
python3 -m http.server 8080
```

Puis ouvrez `http://localhost:8080`.

Note: le service worker et certaines APIs (geolocalisation) ne fonctionnent pas de facon fiable en ouvrant directement `index.html` via `file://`.

## Fichiers

- `index.html` : application (logique + style + UI)
- `places.js` / `places.json` : données historiques conservées dans le repo (non nécessaires au runtime actuel).
- `manifest.webmanifest` : metadata PWA (install, theme, icones)
- `sw.js` : service worker (cache shell + runtime, fallback offline, update)
- `offline.html` : page de secours hors ligne
- `version.json` : metadata de version comparee au demarrage

## Stack

HTML, React + Babel (CDN), Tailwind CSS (CDN), Leaflet. Données runtime : API Open-Meteo (météo) + API Adresse (reverse géocodage).

## Fonctionnement

- Géolocalisation au chargement
- Points candidats : génération d'une grille dans le rayon choisi (15 min à 3 h), puis sélection des meilleurs points météo
- Météo : appel direct à Open-Meteo pour les coordonnées des points
- Nommage : reverse géocodage via API Adresse
- Filtrage « soleil » (codes 0, 1, 2) et tri par score/distance
- Carte Leaflet avec marqueurs
- Verification de nouvelle version au demarrage (service worker + version.json)
- Mise a jour in-app via banniere "Mettre a jour"
