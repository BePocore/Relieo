# Relieo

Application Vite + React + MapLibre GL JS pour creer, publier et consulter des
cartes de randonnee avec traces GPX, photos, videos, points d'interet et vues
360. Le projet est deploye sur Vercel, avec Cloudflare R2 comme source de
verite pour les projets et les medias.

## Commandes

- `npm run dev` : serveur Vite frontend sur le port 5173. Les routes `/api/*`
  ne tournent pas dans ce mode.
- `npx vercel dev` : serveur full stack local sur le port 3000 si le projet est
  lie a Vercel. Attention : les secrets sensibles Preview/Production ne peuvent
  pas etre recuperes en Development, donc les routes R2/Firebase Admin restent
  limitees localement.
- `npm run build` : `tsc -b && vite build`.
- `npm run lint` : ESLint sur tout le depot.
- `npm run preview` : preview du build de production sur le port 4173.

Il n'y a pas de suite de tests dediee.

## Interfaces

- Consultation publique : `/` ou `/?code=<code>`.
- Studio : `/?mode=studio`, `/?mode=studio&code=<code>` ou
  `/?mode=studio&new=<code>`.
- Portail utilisateur : `/dashboard`.
- Console admin : accessible depuis le portail pour les uid listes dans
  `ADMIN_UIDS`.

Le Studio permet d'importer des traces GPX, photos, videos et traces enregistrees
dans Relieo. L'ancien export `points.json` n'est plus le flux de publication :
une carte est sauvegardee directement dans R2 via `/api/project`.

Le bouton `Sauvegarder` conserve le statut courant de la carte. Une nouvelle
carte reste en brouillon ; la publication/depublication se fait depuis le
dashboard via `/api/hikes`.

## Donnees et stockage R2

Cloudflare R2 est l'unique source de verite. Chaque carte vit sous le prefixe du
proprietaire Firebase :

```text
relieo/users/<uid>/randonnees/<folder>/project.json
relieo/users/<uid>/randonnees/<folder>/media/
relieo/users/<uid>/randonnees/<folder>/previews/
```

Les fichiers transverses principaux sont :

- `relieo/index.json` : registre des cartes avec `ownerId`, statut, metadonnees
  et cover.
- `relieo/active.json` : carte publique par defaut.
- `relieo/sanctions.json` : journal de moderation admin.
- `relieo/admin-notifications.json` : appels, demandes de suppression et autres
  notifications admin.
- `relieo/email-usage.json` : dernier snapshot d'usage Resend.
- `relieo/media-scanned.json`, `relieo/media-moderation.json`,
  `relieo/media-moderation-usage.json`, `relieo/media-moderation-queue.json` :
  etat de moderation IA des medias.

Le modele projet garde `traces: Trace[]` pour les traces multiples, mais le champ
legacy `track: TrackPoint[]` reste alimente par concatenation des traces parce
que `/api/project` le valide encore.

Les points supportent `photo`, `video`, `360` et `poi`. Les champs persistants
des points sont filtres par `exportablePoints()` dans `src/App.tsx`; tout nouveau
champ de point a sauvegarder doit y etre ajoute.

## Gestion des medias dans le Studio

Les medias importes sont envoyes dans R2 avec une URL signee. La bibliotheque du
Studio liste les originaux importes et leurs apercus.

Comportement de suppression :

- Supprimer un point supprime aussi le media associe dans R2 si ce media n'est
  pas encore utilise par un autre point.
- Supprimer un media depuis la bibliotheque supprime le fichier R2 sans supprimer
  le point ; les points lies restent sur la carte mais perdent leur media.
- `Supprimer les fichiers inutilises` supprime uniquement les originaux/apercus
  R2 qui ne sont plus relies a aucun point.

Les medias echoues ne sont pas ajoutes au projet et doivent etre selectionnes a
nouveau.

## Acces aux medias

Les medias ne sont pas servis publiquement par le bucket R2. Les URL stockees
peuvent rester au format R2 public historique, mais les API les reecrivent a la
lecture vers le Worker Cloudflare :

```text
https://media.relieo.fr/<cle R2>
```

Le Worker `worker/` verifie un ticket HMAC porte par un cookie httpOnly
`relieo_media_ticket` sur `.relieo.fr`. Les tickets sont emis par
`POST /api/media-ticket` :

- `{ code }` : une carte.
- `{ scope: "user" }` : toutes les cartes de l'utilisateur connecte.
- `{ scope: "all" }` : acces admin global.

Le Worker gere aussi les requetes Range pour la video, CORS avec credentials et
un cache prive. En production, `ALLOW_HEADER_TICKET=0` : le ticket passe par le
cookie, pas par un header.

## Moderation IA des medias

La moderation IA tourne dans le Worker Cloudflare avec Sightengine. Les images
sont envoyees en synchrone a Sightengine ; les videos sont soumises en asynchrone
avec callback. Les modeles actifs sont :

```text
nudity-2.1,gore,offensive,violence
```

Le scan est lance par cron deux fois par jour et peut aussi etre declenche depuis
la console admin. A la publication d'une carte, `/api/hikes` signale les medias
de cette carte en priorite au Worker si `MODERATION_SIGNAL_SECRET` est configure.

`MODERATION_ENFORCE=1` active le blocage fail-closed cote public : un visiteur
ne voit que les medias scannes et non bloques. Le proprietaire et l'admin voient
les medias en attente ou flagges, sauf ceux definitivement rejetes.

La console admin expose :

- une file de revue IA pour approuver/rejeter les medias flagges ;
- un inventaire complet de tous les medias avec etat `pending`, `exempt`, `ok`,
  `flagged` ou `rejected` ;
- les compteurs journaliers/mensuels du palier gratuit Sightengine.

`MODERATION_AUTO_THRESHOLD` permet de supprimer automatiquement les cas evidents
au-dessus du score choisi.

## Authentification et comptes

L'auth principale repose sur Firebase. Les routes serveur utilisent Firebase
Admin (`verifyRequestUser`) et exigent un email verifie pour les operations
protegees. Le header legacy `x-admin-password` reste un repli quand Firebase
Admin n'est pas configure.

Le portail utilise une persistance Firebase locale avec deconnexion glissante a
7 jours. Les comptes bloques ou supprimes sont rediriges vers des ecrans dedies.

Les variables importantes :

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` ou `FIREBASE_PRIVATE_KEY_B64`
- `ADMIN_UIDS`
- `RANDO3D_ADMIN_PASSWORD` pour le repli legacy

## Emails

Les emails transactionnels passent par Resend quand `RESEND_API_KEY` est present.
L'appel est fait en HTTP direct pour lire les headers de quota et enregistrer le
dernier usage dans R2. Si Resend est absent ou echoue, les actions principales ne
doivent pas echouer.

Flux couverts :

- verification d'email via `/api/account { action: "send-verification" }`, avec
  fallback vers l'envoi natif Firebase ;
- notifications de moderation carte/utilisateur envoyees en best-effort en plus
  des notifications in-app.

La reinitialisation de mot de passe reste Firebase-native cote client.

Variables :

- `RESEND_API_KEY`
- `EMAIL_FROM` optionnel, defaut `Relieo <noreply@relieo.fr>`

## Admin et moderation des comptes

Les admins sont controles par `ADMIN_UIDS`, avec verification serveur dans
`server/admin.ts`.

Endpoints consolides pour rester sous la limite de fonctions Vercel :

- `GET /api/admin/me`
- `GET /api/admin/dashboard`
- `POST /api/admin/action`

La console admin couvre les vues overview, utilisateurs, cartes, sanctions,
notifications, couts, emails, moderation IA et inventaire medias.

Les sanctions utilisateur sont stockees dans Firestore `moderation/<uid>` et le
journal complet dans R2 `relieo/sanctions.json`. Un compte peut etre bloque,
debloque ou supprime. La suppression par sanction est reservee aux comptes avec
au moins 3 bannissements ; la suppression volontaire passe par une demande depuis
le profil utilisateur.

Important : `firestore.rules` n'est pas deploye automatiquement. Les regles
doivent etre deployees manuellement si elles changent.

## Trace GPS Relieo

Le portail contient un enregistreur GPS mobile-first dans
`src/portal/TraceViews.tsx`. Il utilise `navigator.geolocation.watchPosition`,
des gardes d'accuracy/sauts, le Wake Lock, un brouillon localStorage et un
autosave R2 toutes les 10 minutes.

Les traces utilisateur sont stockees sous :

```text
relieo/users/<uid>/traces/<traceId>/trace.json
```

Elles peuvent etre listees, exportees en GPX, supprimees, ou importees dans une
carte comme trace normale non sauvegardee.

## MapLibre et rendu

La carte est geree par `src/components/MapLibreTrailMap.tsx`. Elle cree une
instance MapLibre une seule fois, puis met a jour les sources, couches et markers
via effets React.

Fonctions principales :

- traces GPU arrondies, multi-traces et couleurs ;
- terrain AWS Terrarium avec bascules relief/2D ;
- fonds Topo, Satellite et Carte ;
- clusters de points a distance ;
- markers HTML avec apercus medias aux zooms proches ;
- deplacement des markers en Studio seulement quand le point est deverrouille.

Le theme global est jour/nuit/auto, mais la carte reste volontairement sombre
pour eviter les couts de recalcul CSS sur les markers animes.

## Variables d'environnement principales

R2 :

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

Media ticket / Worker :

- `MEDIA_TICKET_SECRET` identique cote Vercel et Worker
- `MEDIA_COOKIE_DOMAIN`
- `MODERATION_SIGNAL_SECRET`
- `MODERATION_CALLBACK_SECRET`
- `SIGHTENGINE_API_USER`
- `SIGHTENGINE_API_SECRET`
- `MODERATION_ENFORCE`
- `MODERATION_AUTO_THRESHOLD`

Facturation/couts :

- `INTERNAL_EMAILS`
- `FIXED_COSTS` dans `server/costs.ts`

## Deploiement

Le frontend est genere dans `dist`. Les fichiers `api/*.ts` deviennent des
Vercel Functions. Le Worker media se deploie separement depuis `worker/` avec
Wrangler :

```text
wrangler deploy
```

Les secrets Worker (`MEDIA_TICKET_SECRET`, Sightengine, secrets moderation) se
posent via `wrangler secret put`. Le secret `MEDIA_TICKET_SECRET` doit etre
strictement identique cote Vercel et cote Worker.
