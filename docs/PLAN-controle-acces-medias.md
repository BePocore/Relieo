# Plan : Contrôle d'accès des médias (le « videur » + tickets)

> Document de conception, à faire évoluer pendant le dev. Rien n'est codé à ce stade.
> Complète le [PLAN-moderation-ia.md](./PLAN-moderation-ia.md) : c'est le **même Cloudflare Worker**
> qui assurera à la fois la modération (scan) et le contrôle d'accès décrit ici.

## Contexte

Aujourd'hui, les médias (photos, vidéos, previews) sont stockés sur un bucket Cloudflare R2 **public** :
exposés sur un domaine public (`R2_PUBLIC_BASE_URL`), avec cache CDN « immutable » d'un an et CORS
permissifs. Conséquence : **toute personne qui connaît l'URL exacte d'un fichier peut l'ouvrir**, sans
compte, même pour une carte en brouillon ou « privée ». La confidentialité repose uniquement sur le
secret du lien, pas sur une barrière technique.

Ça pose deux problèmes :
- **Confidentialité** : brouillons et cartes partagées par code/mot de passe ne sont pas réellement
  privés (cf. la franchise écrite dans les CGU, section 6).
- **Modération** : « masquer » un média flaggé ne fait que le retirer de l'affichage de la carte ; le
  fichier brut reste accessible par son URL tant qu'il n'est pas supprimé. « Masqué » ≠ « inaccessible ».

Objectif : que **l'URL seule ne suffise plus**. L'accès à un fichier passe par un contrôle.

## Décisions validées avec Quentin

- **Bucket R2 rendu privé.** Plus d'accès direct par URL publique. Les fichiers ne sont servis que par
  un **« videur »** (Cloudflare Worker) qui vérifie le droit d'accès à chaque requête.
- **Système de tickets temporaires.** Quand un visiteur est autorisé sur une carte, il reçoit un
  **ticket** ; chaque demande de média est servie uniquement avec un ticket valide.
- **Ticket lié au navigateur (« renfort 2 »).** Le ticket est attaché à la **session du navigateur**
  (cookie `httpOnly`, illisible par le JavaScript) → un ticket copié dans un autre navigateur ne marche
  pas.
- **Rafraîchissement toutes les 2 minutes.** Le ticket expire vite et l'app le renouvelle
  automatiquement en arrière-plan (renouvellement à mi-vie, avec marge). Invisible pour le visiteur.
- **Cookie technique = pas de bandeau de consentement.** C'est un cookie « strictement nécessaire »
  (sécurité/accès), exempté de consentement RGPD/ePrivacy. À mentionner par transparence dans la
  politique de confidentialité, sans bandeau.
- **Médias servis depuis un sous-domaine relieo.fr** (ex. `media.relieo.fr`) pour que le cookie soit
  first-party et envoyé automatiquement avec les requêtes d'images.
- **Plafond assumé (honnêteté).** Un visiteur autorisé peut toujours faire une **capture d'écran**.
  Aucun système ne l'empêche. On bloque le vol de lien/ticket, pas la copie de ce qu'on a le droit de voir.

## Vue d'ensemble

```
Navigateur                     Vercel (app + API)              Cloudflare Worker (videur)        R2 (privé)
   |                                |                                   |                            |
   | 1. ouvre une carte             |                                   |                            |
   |------------------------------->|                                   |                            |
   |   (token Firebase / mot de passe)                                  |                            |
   | 2. ticket (cookie httpOnly,    |                                   |                            |
   |    lié session, ~2 min) <------|                                   |                            |
   |                                                                    |                            |
   | 3. <img src="media.relieo.fr/...">  (cookie ticket envoyé auto)    |                            |
   |------------------------------------------------------------------->|                            |
   |                                       4. vérifie ticket + média autorisé (scanné & non flaggé)   |
   |                                                                    |---- lit l'objet ---------->|
   |   5. fichier servi (ou 403 refusé) <-------------------------------|<---------------------------|
   |                                                                    |                            |
   | 6. toutes les 2 min : renouvelle le ticket en fond --------------->| (via l'API d'émission)     |
```

## Composants à construire

### A. Rendre le bucket R2 privé + brancher le Worker
- Retirer l'accès public direct du bucket (plus de domaine public ouvert).
- Créer un **Cloudflare Worker** avec un **binding R2** sur le bucket.
- Router le sous-domaine `media.relieo.fr` vers ce Worker (config DNS/Cloudflare).
- ⚠️ Étape sensible : pendant la bascule, les anciennes URLs publiques cessent de marcher. Voir
  « Migration » plus bas.

### B. Le videur (Worker) — `GET media.relieo.fr/<clé R2>`
À chaque requête de fichier, le Worker :
1. Lit le **cookie ticket**. Absent/expiré/invalide → `403`.
2. Vérifie que le ticket correspond bien à **cette carte** (le ticket porte l'identifiant de la carte)
   et à **cette session** (renfort 2).
3. Vérifie que **ce média a le droit d'être servi en ce moment** : présent dans `media-scanned.json`
   et **non flaggé** dans `media-moderation.json` (état lu dans R2, écrit par la partie modération).
   → C'est ce contrôle « à la requête » qui rend la **révocation instantanée** (un média flaggé
   disparaît pour tout le monde, même avec un ticket valide).
4. Si tout passe : lit l'objet dans R2 (binding) et le sert, **avec support des requêtes Range** (lecture
   des vidéos par morceaux).
- Le **propriétaire** (ticket « owner ») voit tout, y compris ses médias pas encore scannés (badge
  « en attente » côté app).

### C. Émission du ticket — endpoint d'autorisation
Un endpoint (Vercel `/api/media-ticket`, ou route dédiée du Worker) qui délivre le ticket selon le cas :
- **Carte publique** : ticket délivré automatiquement à tout visiteur (aucune preuve demandée).
- **Carte protégée par mot de passe** : le visiteur envoie le mot de passe ; **vérifié côté serveur**
  (aujourd'hui le `accessCode` est purement client → ça devient une vraie sécurité). Bon mot de passe →
  ticket. Mauvais → refus.
- **Brouillon** : ticket délivré seulement au **propriétaire connecté** (token Firebase) ou à l'admin.
- Le ticket est un **jeton signé** (le Worker peut vérifier la signature sans appeler Vercel) portant :
  identifiant de carte, rôle (public/owner), identifiant de session, date d'expiration (~2 min).
- Déposé en **cookie `httpOnly; Secure; SameSite`** scoped sur `.relieo.fr`.

### D. Côté client (app React)
- Les URLs des médias pointent désormais sur `media.relieo.fr` (cf. Migration).
- À l'ouverture d'une carte : appeler `/api/media-ticket` pour obtenir le ticket avant d'afficher les
  médias.
- **Boucle de rafraîchissement** : re-demander un ticket toutes les ~2 min (à mi-vie) tant que la carte
  est ouverte. Invisible.
- Gérer proprement le **gate mot de passe** (formulaire → appel serveur → ticket).
- Les `<img>`/`<video>` n'ont rien de spécial à faire : le cookie part tout seul.

### E. Migration des URLs existantes
- Les `project.json` stockent des URLs sur l'ancien domaine public. Deux options :
  - **Réécriture à la lecture** : `GET /api/project` réécrit les URLs vers `media.relieo.fr` à la volée
    (pas de modification des fichiers stockés). **Recommandé** (réversible, pas de migration de données).
  - Réécriture en dur des `project.json` (plus risqué, déconseillé).
- Prévoir que le Worker accepte la **même structure de clés** que l'actuelle (`relieo/users/<uid>/...`).

## Points d'attention techniques

- **Cache.** Le ticket est dans un **cookie**, pas dans l'URL → les URLs restent stables, donc le
  navigateur garde les médias en cache (zéro re-téléchargement, zéro clignotement au renouvellement).
  ⚠️ Attention au cache **partagé** (CDN) : pour du contenu privé, le Worker doit servir en cache
  **privé** (par navigateur), jamais en cache public partagé (sinon un fichier servi à un autorisé
  pourrait être resservi sans contrôle). À régler dans les en-têtes du Worker.
- **Vidéos.** Le ticket de 2 min ne doit pas couper une lecture : le Worker s'appuie sur le
  renouvellement (cookie rafraîchi) et le support des Range. À tester avec une vidéo longue.
- **Thumbnailing canvas.** Le code actuel dessine des previews dans un canvas (besoin de CORS). Le
  Worker doit renvoyer les bons en-têtes CORS pour ne pas casser `useFramedThumbnails` /
  `useVideoPosters`.
- **CORS + credentials.** Les requêtes d'images cross-subdomain avec cookie : vérifier la conf
  (`crossorigin`, `Access-Control-Allow-Credentials`, domaine cookie `.relieo.fr`).
- **`/api/project` lui-même.** Pour une carte protégée/brouillon, penser à aussi gater le JSON du projet
  (il porte les métadonnées) — le plus gros risque reste les fichiers médias, mais à garder en tête.
- **Performance.** Le Worker lit `media-scanned.json` / `media-moderation.json` à chaque requête : les
  mettre en cache courte durée côté Worker pour ne pas relire R2 à chaque image.

## Le plafond (à dire honnêtement)

- On empêche : l'accès par URL seule, le vol/partage de lien, l'accès à un média flaggé.
- On n'empêche pas : qu'un visiteur **autorisé** fasse une capture d'écran ou photographie son écran.
  C'est inévitable (même les DRM vidéo échouent). Option future si besoin : **filigrane** (visible ou
  invisible) pour tracer une fuite. Non retenu pour l'instant.

## Ordre de mise en œuvre suggéré

1. Créer le Worker + binding R2 + sous-domaine `media.relieo.fr` (sans encore couper le public).
2. Émission de ticket (`/api/media-ticket`) pour les 3 cas + signature/vérif du jeton.
3. Logique du videur (ticket + contrôle scanné/non-flaggé + Range + CORS).
4. Client : récupération + boucle de rafraîchissement 2 min + gate mot de passe serveur.
5. Réécriture des URLs à la lecture (`/api/project`) vers `media.relieo.fr`.
6. **Bascule** : rendre le bucket privé (couper l'accès public direct).
7. Tests, puis surveillance.

## Vérification (end-to-end)

- **URL seule** : copier l'URL d'un média et l'ouvrir sans ticket → **refusé (403)**.
- **Carte publique** : un visiteur anonyme ouvre la carte → médias visibles ; média flaggé → absent.
- **Carte protégée** : mauvais mot de passe → pas de médias ; bon mot de passe → médias visibles.
- **Brouillon** : visiteur non propriétaire → aucun média ; propriétaire connecté → tout visible.
- **Ticket copié** : coller le cookie ticket dans un autre navigateur → ne marche pas (lié session).
- **Révocation** : flaguer un média en cours de session → il disparaît à la requête suivante.
- **Fluidité** : naviguer dans une carte > 2 min → aucun clignotement, aucune image cassée ; une vidéo
  longue se lit sans coupure.
