# Plan : Modération IA des médias + CGU (Relieo)

## Contexte

Relieo va bientôt permettre des cartes et médias **réellement publics** (visibles par tous,
au-delà du simple partage par code). Dès lors qu'un contenu utilisateur devient public, il faut
le modérer : repérer la nudité, le contenu sexuel, la violence, les gestes/symboles inappropriés.

Décisions validées avec Quentin :
- **Service IA : Sightengine** (français, données en UE, suppression immédiate après traitement,
  RGPD natif, spécialiste NSFW). Retenu pour la priorité confidentialité.
- **On modère les ORIGINAUX, pas les vignettes.** La vignette (`preview`) est générée par le
  navigateur et uploadée séparément du média : un client modifié pourrait envoyer une vignette saine
  et un original inapproprié → modérer la vignette est contournable. On analyse donc le fichier
  original (photo, vidéo courte ET longue).
- **L'IA lit directement les fichiers dans R2.** Tous les objets R2 ont une URL publique
  (`R2_PUBLIC_BASE_URL`). On envoie à Sightengine **l'URL de l'original** ; c'est Sightengine qui va
  chercher et analyse le fichier. Notre serveur ne télécharge ni ne ré-uploade les médias, il ne fait
  que transmettre des URLs.
- **Aucun déclenchement par le site / le navigateur.** Le scan est un processus serveur autonome.
  Moteur retenu : **Cloudflare Worker** (R2 déjà chez Cloudflare → accès au bucket par binding natif,
  100% découplé du site, peut héberger l'endpoint de callback vidéo de Sightengine).
- **Vidéos analysées EN ENTIER** (pas de plafond de durée). Objectif : zéro angle mort.
- **Scan incrémental, une seule fois par média** : on balaye TOUS les médias (photos + vidéos,
  brouillons inclus), mais chaque média n'est analysé qu'une fois (liste `media-scanned.json`).
  Seuls les nouveaux médias sont traités.
- **Modèle de visibilité à deux niveaux (objectif « 0 problème » sur le public)** :
  - *Brouillon / partage par code (semi-privé)* : **optimiste**, média visible tout de suite (confort).
  - *Publication PUBLIQUE (visible par tous)* : **strict**. Une carte ne bascule en public que si
    **tous ses médias sont scannés et validés**. Sinon la publication reste « en attente de
    vérification » jusqu'au prochain passage du scan. Rien de non vérifié n'atteint le grand public.
  - Si l'IA flague un média : il est **masqué** partout en attendant l'admin. Si l'admin le juge non
    conforme → suppression de R2 + de la carte, + mail (Resend perso) + notification in-app, tracé
    dans un nouvel onglet « Modération » de la console admin.
- **Seuils Sightengine bas (flag large)** : on préfère des faux positifs (que l'admin lève vite) à
  un faux négatif. La modération humaine reste légère, juste une validation du flux flaggé.
- **CGU obligatoires** : l'utilisateur doit accepter des conditions d'utilisation qui autorisent
  explicitement le contrôle de ses médias par une IA de modération.

---

## Vue d'ensemble de l'architecture

Trois briques :

1. **Moteur de modération** (serveur, autonome via cron) : liste les originaux dans R2, envoie les URLs
   des nouveaux à Sightengine, stocke un verdict, gère l'état « scanné / flaggé / approuvé / rejeté ».
2. **Onglet Modération** (console admin) : l'admin voit les médias flaggés par l'IA, avec l'aperçu,
   la raison et le score, et décide : approuver (rétablit l'affichage) ou rejeter (supprime tout).
3. **CGU + consentement** : page CGU + écran d'acceptation au premier accès, champ de consentement
   stocké dans le profil.

Principe : on analyse **les fichiers originaux** (pas les vignettes, contournables), directement
depuis R2 via leurs URLs publiques. Sightengine récupère et analyse le fichier lui-même. Les photos
sont analysées en synchrone, les vidéos (courtes et longues) via l'API vidéo de Sightengine
(échantillonnage de frames, asynchrone avec callback pour les longues).

---

## Brique 0 — Garantir l'intégrité preview / original (prérequis)

Pourquoi : scanner l'original ne suffit que si la **preview affichée est forcément dérivée de
l'original**. Aujourd'hui la preview est générée par le navigateur et uploadée séparément → original
et preview peuvent diverger (une preview inappropriée pourrait s'afficher même si l'original est
propre). On rend les deux **indissociables** : le client n'envoie plus jamais de preview, elle est
dérivée côté serveur de l'original.

- **Photos** : suppression de l'upload de preview côté client. La vignette est générée **côté serveur**
  à partir de l'original avec `sharp` (redimensionnement). Original et vignette indissociables.
  Impacts : retirer `kind: 'preview'` du flux client photo (`src/lib/cloudUpload.ts`,
  `useFramedThumbnails.ts`), générer la vignette dans le pipeline serveur (`api/upload.ts` ou
  `api/project.ts` lors du `moveProjectMedia`).
- **Vidéos** : le poster reste généré par le client (éviter ffmpeg en serverless), MAIS on le considère
  comme non fiable → on le **scanne aussi** en plus de la vidéo entière (coût négligeable, une image).
  Ainsi aucune image inappropriée ne peut s'afficher. (Option future « pure » : extraire le poster
  côté serveur via ffmpeg ou un Cloudflare Worker — non retenu pour l'instant.)
- Conséquence : pour les **photos**, scanner uniquement l'original suffit. Pour les **vidéos**, on scanne
  la vidéo + son poster.

---

## Brique 1 — Moteur de modération (serveur)

### 1.1 Nouveau module `server/sightengine.ts`
Client HTTP direct vers l'API Sightengine (pas de SDK, comme le pattern déjà adopté pour Resend
dans `server/email.ts`). Variables d'env : `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`.
- **On envoie toujours l'URL de l'ORIGINAL** (pas la vignette) : Sightengine va chercher le fichier
  dans R2 et l'analyse lui-même.
- `moderateImageUrl(url): Promise<ModerationVerdict>` (photos) : endpoint image, modèles `nudity-2.1`,
  `gore`, `offensive` (gestes/symboles), `weapon` selon besoin.
- `moderateVideoUrl(url): Promise<ModerationVerdict>` (vidéos courtes ET longues) : endpoint vidéo de
  Sightengine, qui échantillonne les frames sur **toute la durée** (pas de plafond, objectif 0 angle
  mort). Pour les vidéos longues, mode **asynchrone avec callback** (Sightengine rappelle une URL quand
  l'analyse est finie ; l'endpoint de callback est servi par le Cloudflare Worker, cf. 1.3).
  Le verdict d'une vidéo = la frame la plus risquée.
- Mappe la réponse Sightengine vers un verdict normalisé :
  `{ decision: 'ok' | 'flag', topCategory: string, score: number, raw: {...} }`.
- Tolérant aux pannes : si l'API échoue, le média n'est PAS marqué scanné (re-tenté au prochain
  passage), jamais bloquant pour l'utilisateur. Même philosophie de repli que les emails.

### 1.2 Nouveau module `server/mediaModeration.ts` (état persistant dans R2)
Réutilise le pattern JSON R2 déjà en place (`server/sanctions.ts`, `server/adminNotifications.ts`).
- Fichier R2 : `relieo/media-moderation.json`, forme `{ items: MediaModerationEntry[] }`.
- Type :
  ```ts
  type MediaModerationEntry = {
    id: string                 // = clé R2 du média original (identifiant unique, stable)
    mediaKey: string           // clé R2 du média original (analysé)
    mediaUrl: string           // URL publique de l'original (pour l'aperçu admin)
    ownerUid: string
    ownerEmail: string | null
    mapCode: string
    mediaKind: 'image' | 'video'
    status: 'approved' | 'flagged' | 'rejected'  // 'approved' = scanné OK ; pas de 'pending' stocké
    aiCategory: string         // ex: 'nudity', 'gore', 'offensive'
    aiScore: number
    scannedAt: string
    reviewedAt: string | null
    reviewedBy: string | null
  }
  ```
- Fonctions : `readMediaModeration()`, `upsertMediaModeration(entry)`, `setMediaModerationStatus(id, status, reviewedBy)`,
  et un **index des médias déjà scannés** : un Set des `id` présents (quel que soit le statut) sert à
  ne jamais re-scanner. Les médias OK sont enregistrés en `approved` (trace légère) pour marquer
  « déjà vu » ; pour limiter la taille du fichier, on peut ne stocker que les `flagged`/`rejected`
  et tenir l'ensemble « déjà scanné » dans un fichier compagnon léger `relieo/media-scanned.json`
  (juste une liste d'`id`). **Choix retenu : deux fichiers** — `media-scanned.json` (liste d'ids,
  léger, source de vérité « déjà traité ») + `media-moderation.json` (seulement les flaggés/rejetés,
  ce que l'admin voit).

### 1.3 Le balayage incrémental — Cloudflare Worker (la modération reste serveur)
La modération elle-même ne tourne JAMAIS dans le navigateur : c'est toujours le **Cloudflare Worker**
qui appelle Sightengine. Le Worker accède au bucket R2 par **binding natif** (R2 est déjà chez
Cloudflare → pas de sous-requête externe, pas besoin des URLs publiques pour lister/lire) et sert
l'endpoint HTTP qui reçoit les **callbacks vidéo** de Sightengine.

**Deux déclencheurs complémentaires :**
- **Cron 2x/jour** (Worker scheduled) : balayage de fond de tous les nouveaux médias, même en
  brouillon. Filet de sécurité, garde tout propre en continu.
- **À la demande de publication** : quand un user veut rendre sa carte **publique**, la route Vercel
  appelle l'endpoint HTTP du Worker (secret partagé) pour un **scan ciblé immédiat des médias non
  scannés de CETTE carte** (pas tout R2). L'utilisateur n'attend pas le prochain cron. Le site ne fait
  qu'envoyer un signal, la modération reste côté Worker. Photos = synchrone (publication quasi
  instantanée) ; vidéos = asynchrone (carte « en attente de vérification » quelques minutes, puis
  publique au retour du callback).

Logique de scan (commune aux deux déclencheurs) :
- Liste les **originaux** dans R2 (binding), sous `relieo/users/.../media/` (exclut `previews/`).
- Pour chaque média **absent** de `media-scanned.json` : appelle Sightengine
  (image en synchrone ; vidéo en asynchrone avec callback), écrit le résultat, ajoute l'id à
  `media-scanned.json`.
  - **Photo** : on scanne l'original (la vignette est dérivée serveur, donc fiable).
  - **Vidéo** : on scanne la vidéo entière **et** le poster client (poster non fiable, cf. Brique 0).
  - Verdict `ok` → marqué scanné.
  - Verdict `flag` → entrée `flagged` dans `media-moderation.json` **et** masquage du média (cf. 1.4).
- **Limites Cloudflare Free** (cf. section Contraintes) : 50 sous-requêtes **externes**/invocation →
  on traite ~25-50 médias par tick de cron ; le tick suivant continue. R2 (binding) ne compte pas dans
  cette limite. CPU 10ms suffisant (travail I/O, pas calcul). Si le volume grossit : Workers Paid 5 $/mois.
- Les verdicts/états (`media-scanned.json`, `media-moderation.json`) sont écrits **dans R2**, donc lus
  indifféremment par le Worker et par les routes Vercel (console admin + filtrage public).
- Secrets du Worker : `SIGHTENGINE_API_USER/SECRET`, accès R2 (binding), un secret partagé pour
  authentifier les callbacks.

### 1.4 Règle de visibilité publique + gating de la publication
Tout repose sur **une seule règle de filtrage** appliquée à la lecture publique, qui couvre tous les
cas (non scanné, flaggé, validé) :

> **Un média n'est visible publiquement que s'il est scanné ET non flaggé.**

Conséquences directes de cette règle unique :
- Média **non encore scanné** → masqué au public (donc un nouvel ajout est invisible tant que pas vérifié).
- Média **flaggé** → masqué au public.
- Média **scanné OK** → visible.
- Le **propriétaire** (et l'accès par code, semi-privé) voit **tout, tout le temps** (optimiste, confort
  d'édition), avec un badge « en attente de vérification » sur les médias pas encore validés.

Implémentation : la lecture publique (`GET /api/project?code=` / pointeur public) filtre `mediaLibrary`
et les refs des `points` en croisant avec `media-scanned.json` (scanné & non flaggé). Pas besoin de
réécrire les `project.json` des utilisateurs. Le statut par média est lu dans R2
(`media-scanned.json` / `media-moderation.json`), écrit par le Worker.

**Gating de la 1re mise en PUBLIC (carte entière) :**
- Niveaux de visibilité : *brouillon* / *partagé par code (semi-privé)* / *public (visible par tous)*.
- Pour basculer une carte de privé → **public** : on exige que **TOUS ses médias soient scannés et non
  flaggés**. Si au moins un est en attente → la carte entière passe en **« en attente de publication »**
  (carte grisée, badge dédié), elle n'est PAS exposée au public. Un **scan ciblé** est déclenché.
- Quand tous les médias deviennent OK → la carte passe effectivement en ligne et on envoie **la notif de
  publication + le mail** au propriétaire. (Pour les vidéos, ça peut arriver quelques minutes plus tard
  via le callback ; pour des photos déjà scannées, c'est immédiat.)
- Si un média est rejeté entre-temps → la carte reste en attente, l'user est notifié (flux de rejet).
- Helper serveur `assertMapPubliclyClean(code, ownerUid)` appelé au moment de la mise en public
  (route qui gère le statut public, cf. `api/hikes` / index R2).

**Cas : ajout de médias sur une carte DÉJÀ en ligne.**
- La carte **reste publique** (on ne la dé-publie jamais à l'édition). Les anciens médias validés restent
  visibles.
- Le **nouveau média** est automatiquement invisible au public (règle de filtrage ci-dessus : pas encore
  scanné), visible seulement pour le propriétaire avec le badge « en attente de vérification ».
- La sauvegarde déclenche un **scan ciblé** ; au verdict OK le média apparaît tout seul (pas de notif
  nécessaire), au verdict flag il part en modération admin (et suit le flux de rejet si non conforme).
- Donc le « gating carte entière » ne concerne QUE la 1re mise en public ; ensuite c'est du gating
  **par média**, sans jamais faire disparaître la carte.

### 1.5 Initialisation (seed) — pré-valider Halsa sans payer
Pour ne pas gaspiller d'appels Sightengine sur des médias déjà connus comme sains :
- **Seed one-shot** : un script/endpoint admin liste tous les médias de la carte **Halsa** dans R2 et
  les inscrit dans `media-scanned.json` avec un statut « validé », **sans aucun appel à Sightengine**.
- Le Worker ne traite que les médias **absents** de `media-scanned.json` → Halsa ne sera jamais
  re-scannée.
- La **nouvelle carte de test** (à créer par Quentin) n'est PAS seedée → elle passe par l'IA, ce qui
  permet de valider le flux réel de bout en bout.
- (Extensible plus tard à tous les comptes `INTERNAL_EMAILS` si on veut exclure tous les comptes de
  test ; non retenu pour l'instant afin de pouvoir tester.)

---

## Brique 2 — Onglet « Modération » dans la console admin

Suit exactement le pattern des onglets existants (Sanctions, Notifications) dans
`src/portal/admin/AdminView.tsx`.

### 2.1 Front (`src/portal/admin/AdminView.tsx`)
- Ajouter `'media-moderation'` au type `AdminSection`, à `SECTION_TITLES`, et un bouton dans `navItems`
  (badge = nombre de médias `flagged` en attente).
- Nouveau composant `MediaModerationView` : tableau / galerie des entrées `flagged`, chaque ligne
  affiche **l'aperçu du média original** (image, ou poster pour une vidéo), le propriétaire, la carte,
  la catégorie IA + score, et deux actions :
  - **Approuver** → l'IA s'est trompée : on retire le média de l'occultation, statut `approved`.
  - **Rejeter** → non conforme : suppression R2 (original + sa vignette) et retrait de la carte,
    mail Resend perso + notif in-app à l'utilisateur, statut `rejected`, sanction journalisée.

### 2.2 Données (`api/admin/dashboard.ts`)
- Ajouter `readMediaModeration()` (les entrées flaggées/rejetées) au `Promise.all` existant et
  le renvoyer dans la réponse consolidée (aucune nouvelle route GET).

### 2.3 Actions (`api/admin/action.ts`)
Ajouter au switch existant (réutilise `requireAdmin`, `pushUserNotification`, `appendSanction`,
`notifyByEmail`, `r2DeleteObject`) :
- `action: 'media-mod', op: 'approve'` → `setMediaModerationStatus(id, 'approved', admin)` : le média
  passe « scanné & non flaggé » → il redevient visible publiquement (et débloque le gating de sa carte).
- `action: 'media-mod', op: 'reject'` → supprime l'original + sa vignette (`r2DeleteObject`), retire la
  réf du `project.json` de la carte, `pushUserNotification(owner, {type:'media-rejected', message})`,
  `notifyByEmail(...)` (mail Resend perso), `appendSanction({action:'media-reject', ...})`,
  `setMediaModerationStatus(id, 'rejected', admin)`.
- `action: 'scan-media'` → déclenchement manuel d'un lot de scan (cf. 1.3) ; le mode normal reste le cron.

### 2.4 Notification utilisateur
- Réutiliser `pushUserNotification` (`server/firestoreAdmin.ts`) avec un nouveau type
  `'media-rejected'`, et l'ajouter à `POPUP_NOTIF_TYPES` pour un popup plein écran à la prochaine
  connexion. Mail via le système Resend + repli Firebase déjà en place.

---

## Brique 3 — CGU + consentement IA

### 3.1 Page CGU publique
- Nouvelle vue `'terms'` dans `PortalView` (`src/portal/PortalApp.tsx`), détectée sur `/terms`,
  composant `TermsView` calqué sur `ProfileView`/`SettingsView`. Contenu : conditions d'utilisation
  incluant une clause explicite « vos médias publiés sont analysés par un prestataire d'IA de
  modération (Sightengine, UE, suppression immédiate après traitement) » + mention RGPD + lien vers
  une politique de confidentialité.
- Lien vers cette page depuis l'écran de connexion et le profil.

### 3.2 Champ de consentement dans le profil
- Étendre `ProfileExtras` / `PortalUser` (`src/portal/portalStore.ts`) avec
  `termsAccepted?: boolean` et `termsAcceptedAt?: string`.
- Lire/écrire via `readUserProfile` / `saveUserProfile` (`src/portal/firebase.ts`), `merge: true`
  déjà géré.

### 3.3 Écran d'acceptation bloquant
- Nouveau `TermsOnboarding` calqué sur `PlanOnboarding`, inséré dans le flux post-inscription
  (`src/portal/PortalApp.tsx`) : affiché si `!session.portalUser.termsAccepted`, avant l'accès au
  dashboard. Bouton « J'accepte » → `saveUserProfile(uid, {termsAccepted:true, termsAcceptedAt:now})`.
- Les comptes existants verront cet écran à leur prochaine connexion (consentement rétroactif).

---

## Contenu juridique à rédiger (hors code)

- **CGU** avec clause IA de modération + droits de l'admin (retrait/suppression de contenu).
- **Politique de confidentialité** : citer Sightengine comme sous-traitant, finalité (modération),
  base légale, localisation UE, durée de conservation (suppression immédiate), droits RGPD.
- **Mentions légales** (éditeur du site).
- Idéalement, faire relire par un tiers ; je peux produire un premier jet.

---

## Variables d'environnement à ajouter (Vercel + .env.local)

- **Côté Cloudflare Worker** : `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`, binding R2,
  secret partagé pour authentifier les callbacks vidéo.
- **Côté Vercel** : (option) seuils de flag par catégorie, ex. `MODERATION_NUDITY_THRESHOLD=0.6`
  (bas = flag large). Le bucket R2 est déjà configuré.

---

## Contraintes & points d'attention

- **Le scan ne consomme PAS de fonction serverless Vercel** : il tourne dans le Cloudflare Worker.
  L'onglet admin réutilise les routes existantes (`action.ts`, `dashboard.ts`) → **aucune nouvelle
  fonction Vercel**, on reste sous la limite de 12.
- **Limites Cloudflare Free** : 100k req/jour, CPU 10ms/invocation (OK, travail I/O), **50 sous-requêtes
  externes/invocation** (→ ~25-50 médias/tick, le cron repasse), 1000 sous-requêtes R2 (binding),
  5 cron triggers. Suffisant pour démarrer ; Workers Paid 5 $/mois si le volume explose.
- **Coût Sightengine** : payant à l'usage ; le scan « une seule fois par média » évite les
  re-facturations. Les **vidéos en entier** coûtent plus (analyse sur toute la durée) : assumé pour
  l'objectif 0 problème.
- **Confidentialité** : Sightengine récupère le fichier lui-même (depuis R2), prestataire UE qui
  supprime après traitement. À refléter dans les CGU.
- **Règles Firestore** : si on ajoute des champs profil, vérifier que les règles existantes les
  autorisent (le profil est déjà en écriture propriétaire).

---

## Ordre de mise en œuvre suggéré (quand on codera)

1. CGU + consentement (brique 3) — indispensable juridiquement avant tout traitement IA.
2. Intégrité preview/original (brique 0) — génération serveur des vignettes photo, base saine.
3. Cloudflare Worker : scan incrémental Sightengine (cron 2x/jour + à la publication) + état R2 +
   endpoint callback vidéo (brique 1).
4. Seed Halsa (1.5) — avant le premier passage du Worker, pour ne pas la scanner.
5. Masquage des médias flaggés + gating de la publication publique (1.4) + filtrage en lecture publique.
6. Onglet Modération admin (brique 2).
7. Branchement notifications/mail + journal des sanctions.
8. Tests bout-en-bout (cf. ci-dessous).

---

## Vérification (end-to-end, quand ce sera codé)

- **Seed Halsa** : après le seed, lancer le Worker → vérifier qu'aucun média de Halsa n'est envoyé à
  Sightengine (zéro coût), tous présents dans `media-scanned.json`.
- **Carte de test** (nouvelle, non seedée) : uploader une image saine → après scan, reste visible,
  marquée scannée, pas dans l'onglet Modération.
- Uploader une image test NSFW dans la carte de test → après scan, masquée, visible côté admin dans
  l'onglet Modération avec aperçu + catégorie + score.
- **Publication publique** : tenter de publier la carte de test avec un média non encore scanné →
  scan ciblé déclenché ; carte « en attente de vérification » puis publique si tout est OK.
- **Gating** : une carte avec un média flaggé ne peut pas devenir publique.
- Admin « Approuver » → l'image réapparaît, la carte peut devenir publique.
- Admin « Rejeter » → original + vignette supprimés de R2, retirés de la carte, l'utilisateur reçoit
  mail + notif popup, entrée dans le journal des sanctions.
- Relancer le scan → ne re-traite aucun média déjà scanné (vérifier via logs / compteur « reste N »).
- Nouveau compte → écran CGU bloquant ; refus = pas d'accès, acceptation = `termsAccepted` en base.
- Lancer le front en dev avec `npx vercel dev` ; le Worker se teste avec `wrangler dev`.
