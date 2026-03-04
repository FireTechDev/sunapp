# SunApp

Application **100 % client-side** pour trouver des zones ensoleillées autour de vous. Aucun backend ni Node.js requis.

## Test local

Ouvrez simplement `index.html` dans le navigateur (double-clic) ou servez le dossier via un serveur statique.

## Fichiers

- `index.html` : application (logique + style + UI)
- `places.js` / `places.json` : données historiques conservées dans le repo (non nécessaires au runtime actuel).

## Stack

HTML, React + Babel (CDN), Tailwind CSS (CDN), Leaflet. Données runtime : API Open-Meteo (météo) + API Adresse (reverse géocodage).

## Fonctionnement

- Géolocalisation au chargement
- Points candidats : génération d'une grille dans le rayon choisi (15 min à 3 h), puis sélection des meilleurs points météo
- Météo : appel direct à Open-Meteo pour les coordonnées des points
- Nommage : reverse géocodage via API Adresse
- Filtrage « soleil » (codes 0, 1, 2) et tri par score/distance
- Carte Leaflet avec marqueurs
