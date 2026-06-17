# Carte interactive 3D

Site Vite + React + MapLibre GL JS pour presenter une randonnee avec trace GPX,
photos geolocalisees, points d'interet et liens SkyPixel 360.

## Deux interfaces

- Consultation publique : `/`
- Creation / import : `/?mode=studio`

Partage le lien public sans `?mode=studio` aux visiteurs. Le studio contient les
imports GPX, JSON, photos, videos, l'ajout manuel de points et l'export
`points.json`.

La consultation est centree sur la carte : elle occupe tout l'ecran, les
medias sont accessibles dans un ruban horizontal et les details s'ouvrent dans
un panneau flottant sur ordinateur ou une feuille basse sur mobile et iPad.

## Navigation 3D

- glisser avec un doigt ou la souris pour tourner et incliner la vue ;
- pincer avec deux doigts pour zoomer et deplacer la vue ;
- molette et boutons `+` / `-` pour le zoom ;
- boutons de rotation et de recentrage disponibles sur tous les ecrans.

Dans le Studio, un marqueur peut etre saisi et deplace directement sur le
terrain pour corriger une position GPS avant publication.

## Sauvegarde Cloudflare R2

Cloudflare R2 est l'unique source de verite. Chaque randonnée vit sous le
dossier de son **propriétaire** : `relieo/users/<uid>/randonnees/<folder>/`
(le `uid` vient du token Firebase) avec le projet, les originaux et les
aperçus. `relieo/index.json` recense toutes les cartes (avec leur `ownerId`)
et `relieo/active.json` désigne la carte publiée par défaut. Le fichier
`project.json` contient les traces, points, couleurs, descriptions et
références média. Les originaux sont ouverts dans leur qualité d'import ; la
carte utilise une vignette légère pour rester fluide. Ranger le stockage par
utilisateur garantit le quota par compte (somme du préfixe `relieo/users/<uid>/`)
et empêche d'écrire dans le dossier d'un autre.

Cloudflare R2 est obligatoire pour le projet et les médias.

Variables Vercel :

1. `R2_ACCOUNT_ID`
2. `R2_ACCESS_KEY_ID`
3. `R2_SECRET_ACCESS_KEY`
4. `R2_BUCKET_NAME`
5. `R2_PUBLIC_BASE_URL` (domaine public du bucket, sans slash final)
6. `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (Firebase Admin, auth serveur des appels API)
7. `RANDO3D_ADMIN_PASSWORD` (verrou admin/repli hérité, plus l'auth principale)
8. `ADMIN_UIDS` (liste blanche d'uid Firebase pour la console admin `/api/admin/*`, CSV)

Ces secrets serveur sont définis pour **Preview/Production** uniquement (pas
Development) et sont « sensibles » : on ne peut pas les relire une fois créés.
`npx vercel dev` n'a donc pas R2/Firebase Admin en local et n'exécute que le front.

Le bucket R2 doit autoriser les requetes `PUT` depuis le domaine Vercel et les
requetes `GET` publiques. Les uploads utilisent une URL signee temporaire : les
cles R2 ne sont jamais envoyees au navigateur. Une empreinte de fichier evite
de renvoyer deux fois le meme original.

En plus des projets, R2 stocke quelques fichiers JSON transverses :
`relieo/index.json` (registre des cartes), `relieo/active.json` (carte publique
par défaut), `relieo/sanctions.json` (journal de modération admin) et
`relieo/admin-notifications.json` (messages d'appel des comptes bloqués).

## Console admin & modération

Les comptes listés dans `ADMIN_UIDS` accèdent à une console plein écran
(`/api/admin/*`, `src/portal/admin/`) : vue d'ensemble (stats + revenus +
graphe d'évolution des inscriptions), utilisateurs, cartes (god-view), journal
des sanctions et notifications. Un admin peut **dépublier/supprimer** une carte
et **bloquer/supprimer** un compte, toujours avec un message transmis au
propriétaire (affiché à sa prochaine connexion). La suppression de compte n'est
possible qu'après 3 bannissements : elle efface le contenu R2 mais **conserve
l'authentification et l'email** (réservés, recréation impossible).

L'état de modération vit dans la collection Firestore `moderation/<uid>`
(écriture réservée à l'Admin SDK, lecture par le propriétaire). **Important :**
`firestore.rules` n'est pas déployé automatiquement (pas de `firebase.json`).
Publier la règle `moderation/{userId}` via la console Firebase ou
`firebase deploy --only firestore:rules`, sinon les écrans de blocage/suppression
ne s'affichent pas. Les emails de notification sont prévus mais pas encore
branchés (in-app uniquement pour l'instant).

Le Studio est disponible avec `/?mode=studio`. Le bouton `Publier en ligne`
partage la derniere copie avec le telephone, l'iPad et l'ordinateur.

## Donnees

Les données sont importées depuis le Studio avec les boutons GPX, JSON, photos
et vidéos, puis enregistrées dans le dossier Cloudflare R2 de la randonnée.

Dans le studio, l'import des photos lit les coordonnees GPS EXIF quand elles
existent et cree automatiquement un point sur la carte. Les videos sont aussi
analysees, mais leur GPS depend du format et de l'appareil : l'extraction est
faite au mieux lorsque le fichier contient une position ISO6709 ou QuickTime.
Si aucune position n'est trouvee, ajoute ou ajuste le point manuellement.

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

## Terrain 3D MapLibre

La carte utilise MapLibre GL JS et les tuiles d'altitude AWS Terrarium pour
afficher les montagnes en relief, avec la trace GPX superposee au terrain.
Aucun token cartographique n'est necessaire. Le bouton `Relief 3D` permet de
basculer temporairement en vue 2D.

## Fonds de carte

Le fond par defaut est `Topo`, plus fiable pour lire la randonnee, les reliefs
et la trace. Un selecteur sur la carte permet aussi de passer en `Satellite` ou
`Carte` classique.

## Suite prevue

La trace GPX est centralisee sous forme de coordonnees `TrackPoint[]`, ce qui
permettra d'ajouter ensuite une animation camera le long du parcours sans
changer le format des donnees.
