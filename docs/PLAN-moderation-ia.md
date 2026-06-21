# Plan : Modération IA des médias + CGU (Relieo)

> **Révision du 2026-06-21.** Ce plan a été écrit avant le chantier « contrôle d'accès des
> médias » (bucket R2 passé **privé** + videur Cloudflare `media.relieo.fr`). Trois points ont été
> corrigés en conséquence :
> 1. **Accès Sightengine aux fichiers** : le bucket étant privé, on n'envoie plus d'URL publique
>    `r2.dev`. On **pousse les octets** vers Sightengine (méthode officielle pour du contenu non
>    public). Aucune URL n'est jamais exposée. Voir Décisions + Brique 1.1.
> 2. **Le « moteur Worker » = le videur existant**, pas un nouveau Worker. Voir Brique 1.3.
> 3. **Le filtrage public a deux couches** : le videur refuse l'octet en amont (sécurité réelle) +
>    filtrage à la lecture du `project.json` (pas de marqueur vide). Voir Brique 1.4.
>
> Ajout : section **Brique 1.6 — Coût & budget** (suivi des opérations, garde-fous).

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
- **On POUSSE les fichiers vers Sightengine (upload binaire), on n'expose aucune URL.** Le bucket R2
  est **privé** (accès `r2.dev` désactivé, médias servis seulement par le videur). Sightengine
  recommande lui-même l'**upload direct** quand le fichier n'est pas public (« *when you submit an
  image URL, the image must be publicly accessible... if this is not the case, consider using the
  direct upload method* »). Donc :
  - **Photos** → upload binaire direct sur l'API image (verdict synchrone).
  - **Vidéos** → **Upload API** de Sightengine (on crée une URL d'upload chez **eux**, on y pousse le
    fichier, jusqu'à plusieurs centaines de Mo, puis modération vidéo async + callback).
  - Le Worker **streame** le fichier depuis son binding R2 vers Sightengine (flux, pas de chargement
    complet en mémoire → même une grosse vidéo passe). **R2 ne facture pas l'egress**, donc ce
    transfert ne coûte rien en bande passante. Aucune URL signée, aucun objet rendu accessible même
    temporairement.
- **Aucun déclenchement par le site / le navigateur.** Le scan est un processus serveur autonome.
  Moteur retenu : **le videur Cloudflare existant** (`media.relieo.fr`, dossier `worker/`). Il a déjà
  le binding R2 natif (lecture des fichiers sans sous-requête externe), il sert déjà les médias, et il
  peut héberger le **cron** du balayage et l'**endpoint de callback** vidéo de Sightengine. On ne crée
  pas de second Worker. Avantage clé : **aucune fonction serverless Vercel ajoutée** (on est à 11/12).
- **Vidéos analysées EN ENTIER** (pas de plafond de durée). Objectif : zéro angle mort. Échantillonnage
  Sightengine par défaut (1 frame / 2 s). Conséquence budget assumée, voir Brique 1.6.
- **Scan incrémental, une seule fois par média** : on balaye TOUS les médias (photos + vidéos,
  brouillons inclus), mais chaque média n'est analysé qu'une fois (liste `media-scanned.json`).
  Seuls les nouveaux médias sont traités. Le coût est donc un **one-shot par média, jamais récurrent**.
- **Modèle de visibilité (objectif « 0 problème » sur le public), fail-closed** :
  - *Brouillon / propriétaire* : le propriétaire (et l'admin) voit **tout, tout le temps**, même non
    encore scanné, avec un badge « en attente de vérification » (confort d'édition). C'est le `role:
    owner` du ticket du videur.
  - *Public (carte publiée, accès par code)* : **strict**. Un média n'est servi au public que s'il est
    **scanné ET non flaggé**. C'est le `role: public` du ticket : le videur **refuse l'octet** d'un
    média non approuvé. Rien de non vérifié n'atteint le grand public, même en cas de panne ou de
    quota épuisé (le média reste simplement masqué jusqu'à son verdict).
  - Si l'IA flague un média : il est **masqué** partout (sauf revue admin) en attendant l'admin. Si
    l'admin le juge non conforme → suppression de R2 + de la carte, + mail (Resend perso) +
    notification in-app, tracé dans un nouvel onglet « Modération » de la console admin.
- **Seuils Sightengine bas (flag large)** : on préfère des faux positifs (que l'admin lève vite) à
  un faux négatif. La modération humaine reste légère, juste une validation du flux flaggé.
- **Exception Halsa** : la carte Halsa (compte de Quentin) est pré-validée sans appel Sightengine
  (seed). L'exception est **par carte**, pas par compte, pour pouvoir tester la détection avec une
  autre carte sur le même compte. Voir Brique 1.5.
- **CGU obligatoires** : l'utilisateur doit accepter des conditions d'utilisation qui autorisent
  explicitement le contrôle de ses médias par une IA de modération.

---

## Vue d'ensemble de l'architecture

Trois briques :

1. **Moteur de modération** (le videur Cloudflare, autonome via cron) : liste les originaux dans R2
   (binding), **pousse** les nouveaux vers Sightengine, stocke un verdict, gère l'état
   « scanné / flaggé / approuvé / rejeté », et applique le refus d'octet côté public.
2. **Onglet Modération** (console admin) : l'admin voit les médias flaggés par l'IA, avec l'aperçu,
   la raison et le score, et décide : approuver (rétablit l'affichage) ou rejeter (supprime tout).
3. **CGU + consentement** : page CGU + écran d'acceptation au premier accès, champ de consentement
   stocké dans le profil.

Principe : on analyse **les fichiers originaux** (pas les vignettes, contournables), en les
**poussant** vers Sightengine depuis le binding R2 du videur. Les photos sont analysées en synchrone
(upload binaire), les vidéos via l'Upload API + API vidéo de Sightengine (échantillonnage de frames
sur toute la durée, asynchrone avec callback).

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

## Brique 1 — Moteur de modération (le videur Cloudflare)

### 1.1 Appels Sightengine (dans le Worker)
Client HTTP direct vers l'API Sightengine (pas de SDK, comme le pattern Resend de `server/email.ts`).
Variables d'env (secrets Worker) : `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`.
- **On POUSSE toujours l'ORIGINAL** (jamais la vignette, jamais une URL). Le Worker lit le fichier via
  son binding R2 et l'envoie à Sightengine.
- **Photos** — `moderateImageBinary(bytes)` : POST multipart sur l'endpoint image (`/1.0/check.json`,
  champ `media`), modèles `nudity-2.1`, `gore`, `offensive` (gestes/symboles), `weapon` selon besoin.
  Verdict **synchrone**. Limite 50 Mo (large pour une photo).
- **Vidéos** — `moderateVideoBinary(stream)` : **Upload API** (créer une URL d'upload Sightengine →
  PUT le fichier en streaming, jusqu'à plusieurs centaines de Mo) → lancer la modération vidéo
  **asynchrone** avec `callback_url` (le videur). Échantillonnage sur **toute la durée** (pas de
  plafond, objectif 0 angle mort). Le verdict d'une vidéo = la frame la plus risquée.
- Réponse Sightengine normalisée en verdict :
  `{ decision: 'ok' | 'flag', topCategory: string, score: number, framesAnalyzed?: number, raw: {...} }`.
  `framesAnalyzed` sert au compteur d'ops (Brique 1.6).
- Tolérant aux pannes : si l'API échoue, le média n'est PAS marqué scanné (re-tenté au prochain
  passage), jamais bloquant. Le média reste masqué au public tant qu'il n'a pas de verdict (fail-closed).

### 1.2 État persistant dans R2
Réutilise le pattern JSON R2 déjà en place (`server/sanctions.ts`, `server/adminNotifications.ts`).
**Deux fichiers** :
- `relieo/media-scanned.json` : liste légère des `id` (= clés R2) **déjà traités** (quel que soit le
  verdict). Source de vérité « déjà vu » → ne jamais re-scanner.
- `relieo/media-moderation.json` : seulement les entrées **flaggées / rejetées** (ce que l'admin voit).
  Type :
  ```ts
  type MediaModerationEntry = {
    id: string                 // = clé R2 du média original (identifiant unique, stable)
    mediaKey: string           // clé R2 du média original (analysé)
    mediaUrl: string           // URL videur de l'original (aperçu admin, via ticket scope all)
    ownerUid: string
    ownerEmail: string | null
    mapCode: string
    mediaKind: 'image' | 'video'
    status: 'flagged' | 'rejected'
    aiCategory: string         // ex: 'nudity', 'gore', 'offensive'
    aiScore: number
    scannedAt: string
    reviewedAt: string | null
    reviewedBy: string | null
  }
  ```
- Fonctions : `readMediaScanned()`, `addMediaScanned(id)`, `readMediaModeration()`,
  `upsertMediaModeration(entry)`, `setMediaModerationStatus(id, status, reviewedBy)`.
- Ces fichiers sont écrits par le **videur** (binding R2) et lus indifféremment par le videur (refus
  d'octet) et par les routes Vercel (console admin + filtrage lecture).

### 1.3 Le balayage incrémental (dans le videur)
La modération ne tourne JAMAIS dans le navigateur : c'est toujours le **videur** qui pousse les
fichiers à Sightengine. Il accède au bucket R2 par **binding natif** (pas de sous-requête externe pour
lire/lister) et sert l'endpoint HTTP qui reçoit les **callbacks vidéo**.

**Deux déclencheurs complémentaires :**
- **Cron 2×/jour** (Worker scheduled) : balayage de fond de tous les nouveaux médias, **même en
  brouillon**. Filet de sécurité, garde tout propre en continu.
- **À la demande de publication** : quand un user publie sa carte, la route Vercel (`api/hikes`) appelle
  l'endpoint HTTP du videur (secret partagé `MODERATION_SIGNAL_SECRET`) pour un **scan ciblé immédiat
  des médias non scannés de CETTE carte** (pas tout R2). L'utilisateur n'attend pas le prochain cron.
  Photos = synchrone (publication quasi immédiate) ; vidéos = asynchrone (carte « en attente de
  vérification » quelques minutes, puis publique au retour du callback).

Logique de scan (commune aux deux déclencheurs) :
- Liste les **originaux** dans R2 (binding), sous `relieo/users/.../media/` (exclut `previews/`).
- Pour chaque média **absent** de `media-scanned.json` (et hors exceptions, cf. 1.5) : lit les octets
  via le binding, **pousse** à Sightengine (image binaire sync ; vidéo via Upload API + callback),
  écrit le résultat, ajoute l'id à `media-scanned.json`.
  - **Photo** : on scanne l'original (la vignette est dérivée serveur, donc fiable).
  - **Vidéo** : on scanne la vidéo entière **et** le poster client (poster non fiable, cf. Brique 0).
  - Verdict `ok` → ajouté à `media-scanned.json`, rien dans `media-moderation.json`.
  - Verdict `flag` → entrée `flagged` dans `media-moderation.json` (le refus d'octet 1.4 s'applique).
- **Ordre de traitement** : d'abord la **file prioritaire « demandes de publication »**
  (`publish-queue.json`), puis le **balayage de fond** des brouillons, dans la limite du quota.
- **Garde-fou budget** (cf. 1.6) : on respecte un cap quotidien d'opérations. Les médias non traités
  faute de quota restent non scannés → masqués au public → repris au créneau suivant. Pas de perte.
- **Limites Cloudflare Free** (cf. Contraintes) : 50 sous-requêtes **externes**/invocation. Lire R2
  (binding) ne compte PAS ; seuls les appels à Sightengine comptent → on traite ~25-50 médias par tick,
  le tick suivant continue. CPU 10 ms ne compte pas l'attente I/O (streaming).

### 1.4 Règle de visibilité publique + double filtrage
**Couche 1 (sécurité réelle) — le videur refuse l'octet.** À chaque requête média, le videur lit
`media-scanned.json` / `media-moderation.json` (cache mémoire ~60 s) et applique selon le `role` du
ticket :
- `role: public` → ne sert QUE les médias **scannés ET non flaggés**. Non scanné ou flaggé → 403.
- `role: owner` (propriétaire + admin) → sert tout sauf les `rejected` (le propriétaire voit ses
  médias en attente / l'admin peut juger un flaggé).

**Couche 2 (confort d'affichage) — filtrage à la lecture.** La lecture publique
(`GET /api/project?code=` / pointeur public) filtre `mediaLibrary` et les refs des `points` en
croisant avec l'état R2 (scanné & non flaggé), pour ne pas afficher de **marqueur vide** côté visiteur.
Pas besoin de réécrire les `project.json`.

> Règle unique sous-jacente : **un média n'est visible publiquement que s'il est scanné ET non
> flaggé.** Couvre les trois cas : non scanné → masqué ; flaggé → masqué ; scanné OK → visible. Le
> propriétaire voit tout, avec un badge « en attente de vérification ».

**Gating de la 1re mise en PUBLIC (carte entière) :**
- Pour publier une carte, on déclenche le scan ciblé de ses médias non scannés. Tant qu'au moins un
  média n'est pas validé, le visiteur ne le verra pas (refus d'octet) ; la carte peut être marquée
  « en attente de vérification » côté propriétaire jusqu'à ce que tout soit OK.
- Helper serveur `signalPublishScan(code, ownerUid)` dans `api/hikes` : appelle le videur (secret
  partagé) pour lancer le scan ciblé. La bascule de statut (déjà gérée par `api/hikes`) n'a pas besoin
  d'attendre le verdict : le fail-closed garantit que rien de non validé ne fuit.

**Cas : ajout de médias sur une carte DÉJÀ en ligne.**
- La carte **reste publique** (on ne la dé-publie jamais à l'édition). Les anciens médias validés
  restent visibles.
- Le **nouveau média** est automatiquement invisible au public (pas encore scanné), visible seulement
  pour le propriétaire avec le badge « en attente de vérification ».
- Il sera scanné au prochain cron 2×/jour (ou via un signal de publication si le user republie) ; au
  verdict OK il apparaît tout seul, au verdict flag il part en modération admin.

### 1.5 Initialisation (seed) — pré-valider Halsa sans payer
- **Seed one-shot** : un script/endpoint admin liste tous les médias de la carte **Halsa** dans R2 et
  les inscrit dans `media-scanned.json`, **sans aucun appel à Sightengine** (donc zéro coût).
- Le videur ne traite que les médias **absents** de `media-scanned.json` → Halsa n'est jamais scannée.
- L'exception est portée par une constante/env `MODERATION_EXEMPT_FOLDERS` (défaut : le folder de
  Halsa). **Par carte, pas par compte** : la nouvelle carte de test de Quentin n'est PAS exemptée →
  elle passe par l'IA, ce qui valide le flux réel de bout en bout.

### 1.6 Coût & budget (NOUVEAU)

**Modèle de coût.** Le scan est un **one-shot par média** : un média scanné reste « déjà vu » pour
toujours et ne reconsomme jamais. Le coût d'un mois = uniquement le **flux de nouveaux médias** scannés
dans le mois, pas le stock existant.

**Tarifs Sightengine (juin 2026).**
- **Gratuit** : 2000 opérations/mois, **max 500/jour**.
- **Starter** : 29 $/mois, 10 000 ops incluses, puis 0,002 $/op au-delà.
- 1 **photo** = 1 op. 1 **vidéo** = 1 op **par frame analysée** ; au défaut (1 frame/2 s), une vidéo de
  durée D secondes ≈ **D/2 ops** (1 min ≈ 30 ops, 5 min ≈ 150 ops).

**Conséquence assumée.** Avec les vidéos analysées **en entier au défaut**, le quota gratuit
(2000 ops/mois) se consomme vite dès qu'il y a quelques vidéos longues. Il faut donc s'attendre à
basculer sur le plan **Starter 29 $/mois** rapidement si le volume de vidéos décolle. Le réglage
d'échantillonnage reste **configurable** (`MODERATION_VIDEO_FRAME_INTERVAL`) si on veut resserrer
plus tard pour réduire le coût sans repasser par le code.

**Suivi de la conso.** Compteur maison dans R2 `relieo/moderation/usage.json` (sur le modèle de
`relieo/email-usage.json`) : ops du jour + du mois, incrémenté à chaque scan (1 par image, `framesAnalyzed`
réel par vidéo lu dans la réponse). Affiché dans l'**onglet Coûts** de la console admin via
`server/costs.ts` : ligne Sightengine (ops jour/mois, jauge vs gratuit 500/2000, coût € si plan payant).
Si Sightengine expose aussi l'usage réel du compte (à confirmer côté API), on le croisera comme pour Resend.

**Garde-fous (le budget ne contourne JAMAIS la modération, il ne fait que différer).**
- **Cap quotidien** configurable `MODERATION_DAILY_OP_CAP` (défaut ~480, sous les 500 gratuits). Au cap,
  le balayage s'arrête ; les médias restants sont repris au créneau suivant. Comme ils ne sont pas
  scannés, ils restent **masqués au public** (fail-closed) : un délai, jamais une faille.
- **Priorité publication (file à deux niveaux)** : les médias liés à une **demande de publication**
  sont traités EN PREMIER, avant le balayage de fond des brouillons. Quand un user publie, ses médias
  non scannés sont poussés en tête d'une file prioritaire (`relieo/moderation/publish-queue.json`). Le
  cron et le scan ciblé vident **d'abord** cette file, et le balayage de fond ne prend que le **quota
  restant**. Si le cap quotidien est atteint, la priorité est conservée le lendemain (les publications
  restent en tête). Un user qui publie n'est donc jamais coincé derrière les brouillons des autres.
- **Alerte** : notification admin quand on approche ~80 % du quota mensuel → décider du passage Starter.

---

## Brique 2 — Onglet « Modération » dans la console admin

Suit exactement le pattern des onglets existants (Sanctions, Notifications) dans
`src/portal/admin/AdminView.tsx`.

### 2.1 Front (`src/portal/admin/AdminView.tsx`)
- Ajouter `'media-moderation'` au type `AdminSection`, à `SECTION_TITLES`, et un bouton dans `navItems`
  (badge = nombre de médias `flagged` en attente).
- Nouveau composant `MediaModerationView` : tableau / galerie des entrées `flagged`, chaque ligne
  affiche **l'aperçu du média original** (image, ou poster pour une vidéo, chargé via ticket admin
  scope all), le propriétaire, la carte, la catégorie IA + score, et deux actions :
  - **Approuver** → l'IA s'est trompée : on retire le média de l'occultation, il redevient visible.
  - **Rejeter** → non conforme : suppression R2 (original + sa vignette) et retrait de la carte,
    mail Resend perso + notif in-app à l'utilisateur, statut `rejected`, sanction journalisée.

### 2.2 Données (`api/admin/dashboard.ts`)
- Ajouter `readMediaModeration()` (entrées flaggées/rejetées) + l'instantané `usage.json` (Brique 1.6)
  au `Promise.all` existant et les renvoyer dans la réponse consolidée (aucune nouvelle route GET).

### 2.3 Actions (`api/admin/action.ts`)
Ajouter au switch existant (réutilise `requireAdmin`, `pushUserNotification`, `appendSanction`,
`notifyByEmail`, `r2DeleteObject`) :
- `action: 'media-mod', op: 'approve'` → `setMediaModerationStatus(id, 'approved', admin)` (retire de
  `media-moderation.json`, garde l'id dans `media-scanned.json`) : le média redevient visible.
- `action: 'media-mod', op: 'reject'` → supprime l'original + sa vignette (`r2DeleteObject`), retire la
  réf du `project.json`, `pushUserNotification(owner, {type:'media-rejected', message})`,
  `notifyByEmail(...)`, `appendSanction({action:'media-reject', ...})`, statut `rejected`.
- `action: 'scan-media'` → signal manuel d'un lot de scan au videur ; le mode normal reste le cron.

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

## Variables d'environnement à ajouter

- **Côté videur Cloudflare (secrets `wrangler`)** : `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`,
  `MODERATION_CALLBACK_SECRET` (authentifie les callbacks vidéo de Sightengine),
  `MODERATION_SIGNAL_SECRET` (authentifie l'appel Vercel → videur à la publication). Binding R2 déjà
  présent. Optionnel : seuils par catégorie (`MODERATION_NUDITY_THRESHOLD=0.6`...),
  `MODERATION_VIDEO_FRAME_INTERVAL`, `MODERATION_DAILY_OP_CAP`, `MODERATION_EXEMPT_FOLDERS`.
- **Côté Vercel** : `MODERATION_SIGNAL_SECRET` (même valeur, pour signer l'appel à la publication).
  Le bucket R2 et le `MEDIA_TICKET_SECRET` sont déjà configurés.

---

## Contraintes & points d'attention

- **Le scan ne consomme PAS de fonction serverless Vercel** : il tourne dans le videur. L'onglet admin
  réutilise les routes existantes (`action.ts`, `dashboard.ts`) → **aucune nouvelle fonction Vercel**,
  on reste sous la limite de 12 (on est à 11).
- **Pas de presign, pas de credentials S3 dans le Worker** : on pousse les octets (binding R2 + upload
  Sightengine), donc rien à exposer ni à signer côté stockage.
- **Limites Cloudflare Free** : 100k req/jour, CPU 10 ms/invocation (l'I/O de streaming ne compte pas),
  **50 sous-requêtes externes/invocation** (→ ~25-50 médias/tick, le cron repasse), 5 cron triggers.
  Suffisant pour démarrer ; Workers Paid 5 $/mois si le volume explose.
- **R2 sans frais d'egress** : streamer les fichiers du binding vers Sightengine ne coûte rien en
  bande passante.
- **Coût Sightengine** : payant à l'usage (cf. Brique 1.6). Le scan « une seule fois par média » évite
  les re-facturations. Les **vidéos en entier** coûtent plus : assumé pour l'objectif 0 problème,
  réglage d'échantillonnage configurable si besoin.
- **Confidentialité** : on pousse le fichier à Sightengine (prestataire UE qui supprime après
  traitement) ; aucune URL n'est exposée. À refléter dans les CGU.
- **Règles Firestore** : si on ajoute des champs profil (`termsAccepted`), le profil est déjà en
  écriture propriétaire, pas de nouvelle règle.

---

## Ordre de mise en œuvre suggéré (quand on codera)

1. Intégrité preview/original (brique 0) — génération serveur des vignettes photo, base saine.
2. Videur : appels Sightengine (upload binaire image + Upload API vidéo) + état R2
   (`media-scanned.json` / `media-moderation.json`) + compteur d'ops (1.6) + cron 2×/jour + endpoint
   callback vidéo + endpoint signal de publication (brique 1).
3. Seed Halsa (1.5) — avant le premier passage du videur, pour ne pas la scanner.
4. Refus d'octet côté public + double filtrage + signal de publication depuis `api/hikes` (1.4).
5. Onglet Modération admin + ligne de coût Sightengine (brique 2 + 1.6).
6. Branchement notifications/mail + journal des sanctions.
7. CGU + consentement (brique 3) — avant le retrait du DevGate / lancement public.
8. Tests bout-en-bout (cf. ci-dessous).

> Note : les CGU restent **indispensables avant le lancement public** (traitement de médias de tiers
> par une IA). Tant que le site est derrière le DevGate et qu'on ne teste que sur les comptes internes,
> on peut coder/valider le moteur d'abord, puis poser les CGU avant d'ouvrir au public.

---

## Vérification (end-to-end, quand ce sera codé)

- **Seed Halsa** : après le seed, lancer le videur → vérifier qu'aucun média de Halsa n'est envoyé à
  Sightengine (zéro coût), tous présents dans `media-scanned.json`.
- **Carte de test** (nouvelle, non seedée) : uploader une image saine → après scan, reste visible,
  marquée scannée, pas dans l'onglet Modération ; le compteur d'ops s'incrémente de 1.
- Uploader une image test NSFW dans la carte de test → après scan, **403 côté public** (refus d'octet),
  visible côté admin dans l'onglet Modération avec aperçu + catégorie + score.
- **Vidéo** : uploader une vidéo → Upload API + callback → verdict reçu en différé ; compteur d'ops
  augmenté du nombre de frames analysées.
- **Publication** : publier la carte de test avec un média non encore scanné → scan ciblé déclenché ;
  le média reste masqué au public tant qu'il n'est pas validé, puis apparaît seul.
- Admin « Approuver » → l'image réapparaît (videur la sert de nouveau).
- Admin « Rejeter » → original + vignette supprimés de R2, retirés de la carte, l'utilisateur reçoit
  mail + notif popup, entrée dans le journal des sanctions.
- **Budget** : forcer le cap quotidien → vérifier que le balayage s'arrête, que les médias restants
  restent masqués au public et sont repris au créneau suivant (aucun média public non scanné).
- Relancer le scan → ne re-traite aucun média déjà scanné (compteur « reste N »).
- Nouveau compte → écran CGU bloquant ; refus = pas d'accès, acceptation = `termsAccepted` en base.
- Lancer le front en dev avec `npx vercel dev` ; le videur se teste avec `wrangler dev`.
