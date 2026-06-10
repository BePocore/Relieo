# Carte interactive 3D

Site Vite + React + CesiumJS pour presenter une randonnee avec trace GPX,
photos geolocalisees, points d'interet et liens SkyPixel 360.

## Deux interfaces

- Consultation publique : `/`
- Creation / import : `/?mode=studio`

Partage le lien public sans `?mode=studio` aux visiteurs. Le studio contient les
imports GPX, JSON, photos, videos, l'ajout manuel de points et l'export
`points.json`.

## Sauvegarde en ligne

La carte publiee est stockee dans Vercel Blob. Les points, la trace et la
bibliotheque media sont donc communs au telephone, a l'iPad et a l'ordinateur.
Le mot de passe Studio est demande uniquement pour importer des medias et
publier des modifications.

Dans le projet Vercel :

1. Ouvre `Storage`, cree un Blob Store public et connecte-le au projet. Vercel
   ajoute automatiquement `BLOB_READ_WRITE_TOKEN`.
2. Dans `Settings > Environment Variables`, ajoute
   `RANDO3D_ADMIN_PASSWORD` avec le mot de passe de ton choix.
3. Redeploie le projet.

Le Studio est disponible avec `/?mode=studio`. Le bouton `Publier en ligne`
remplace la sauvegarde locale du navigateur. Les photos et videos importees
sont envoyees directement du navigateur vers Vercel Blob.

## Donnees

Tu peux travailler de deux facons :

- depuis l'interface du site, avec les boutons d'import GPX, JSON, photos et
  videos ;
- en remplacant les fichiers dans `public` avant de publier.

Dans le studio, l'import des photos lit les coordonnees GPS EXIF quand elles
existent et cree automatiquement un point sur la carte. Les videos sont aussi
analysees, mais leur GPS depend du format et de l'appareil : l'extraction est
faite au mieux lorsque le fichier contient une position ISO6709 ou QuickTime.
Si aucune position n'est trouvee, ajoute ou ajuste le point manuellement.

Fichiers publics :

- `public/data/trace.gpx` : trace GPX affichee sur le globe.
- `public/data/points.json` : points avec `lat`, `lng`, `title`, `type`,
  `image`, `video`, `skypixelUrl`, `description`.
- `public/photos/*` : images appelees par `points.json`.
- `public/videos/*` : videos appelees par `points.json`.

Types supportes dans `points.json` :

- `photo`
- `video`
- `360`
- `poi`

Exemple :

```json
{
  "id": "panorama",
  "lat": 45.93072,
  "lng": 6.88722,
  "title": "Panorama 360",
  "type": "360",
  "image": "/photos/panorama.jpg",
  "skypixelUrl": "https://www.skypixel.com/...",
  "description": "Vue panoramique au sommet."
}
```

Exemple video :

```json
{
  "id": "cascade-video",
  "lat": 45.93072,
  "lng": 6.88722,
  "title": "Cascade en video",
  "type": "video",
  "video": "/videos/cascade.mp4",
  "description": "Courte sequence video sur le parcours."
}
```

L'export `points.json` depuis l'interface garde les noms de fichiers importes.
Pour publier, place ensuite les photos dans `public/photos` et les videos dans
`public/videos`.

## Scripts

- `npm run dev` : serveur local.
- `npm run build` : build statique partageable.
- `npm run preview` : previsualisation du build.

## Deploiement

Le frontend Vite est genere dans `dist`. Les fichiers `api/project.ts` et
`api/upload.ts` deviennent des Vercel Functions pour la sauvegarde partagee et
l'import des medias.

## Terrain 3D Cesium

La carte utilise Cesium World Terrain pour afficher les montagnes en relief,
avec la trace GPX plaquee sur le terrain. Pour publier proprement, cree un token
Cesium Ion puis ajoute-le dans `.env` :

```env
VITE_CESIUM_ION_TOKEN=ton_token_ici
```

Si la carte reste plate ou affiche seulement le fallback clair, recree un token
Cesium Ion avec `assets:read`, l'acces aux assets publics / World Terrain, et
les URLs autorisees du site local puis publie.

Pour forcer une carte plate pendant des tests :

```env
VITE_FLAT_TERRAIN=true
```

## Fonds de carte

Le fond par defaut est `Topo`, plus fiable pour lire la randonnee, les reliefs
et la trace. Un selecteur sur la carte permet aussi de passer en `Relief`,
`Satellite` ou `Carte` classique.

## Suite prevue

La trace GPX est centralisee sous forme de coordonnees `TrackPoint[]`, ce qui
permettra d'ajouter ensuite une animation camera le long du parcours sans
changer le format des donnees.
