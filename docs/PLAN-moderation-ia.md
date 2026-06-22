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

## ⚡ ACTIVATION + TESTS (2026-06-22) — état réel, à lire en premier

**La modération est ACTIVÉE et tourne** (compte Sightengine créé, 4 secrets posés sur le videur +
`MODERATION_SIGNAL_SECRET` sur Vercel, videur déployé). Résultats des tests bout-en-bout :

- **Images : OK et fiable.** Nudité explicite, gore, symboles offensants, et **violence** (modèle
  `violence` ajouté ce jour, sur retour de test où une bagarre passait « Validé ») sont détectés.
  Seuils 0.5. La grille de test classe bien (nudity 99%, violence 79%, paysages/char validés, fichiers
  0 octet repérés « fichier vide (cassé) »).
- **Suppression automatique ≥ 70%** (décision Quentin) : un média ≥ `MODERATION_AUTO_THRESHOLD`
  (défaut 0.7) est rejeté **sans revue** ; entre le seuil de flag (0.5) et 0.7 → revue manuelle.
  **Gated sur `MODERATION_ENFORCE=1`** : en rodage (enforce=0) on observe, rien n'est supprimé ni
  masqué côté public. Code : `api/admin/action.ts` (`autoRejectFlaggedMedia`, cœur `rejectMediaCore`
  partagé avec le bouton « Rejeter »).
- **🔴 VIDÉO : NON DISPONIBLE sur le palier GRATUIT Sightengine — À RÉGLER EN AUTRE SESSION.**
  Confirmé par les logs (`wrangler tail relieo-media`) :
  - Upload API (vidéos > 50 Mo, `create-video.json`) → **400 code 1101** « Access to the Upload API is
    restricted. Feature not available on the free plan. »
  - POST direct (vidéos ≤ 50 Mo, `video/check.json`) → **400 `error.type:"usage_limit"`** (vérifié sur
    une vidéo fraîche de 38 Mo / 33 s).
  Donc **toute vidéo échoue quelle que soit la taille** : la modération vidéo n'est pas incluse dans le
  gratuit (les images, si). **Mitigation en place** : une soumission qui lève `SightengineUnsupportedError`
  (détection par **parsing JSON** de `error.type==='usage_limit'` ou code 1100-1110, pas un regex) envoie
  le média en **revue manuelle** (flaggé `verification-manuelle`, marqué scanné pour sortir de la boucle,
  masqué au public, l'admin décide). **À DÉCIDER (autre session)** : (a) passer Sightengine en **payant**
  (prévu pour le déploiement), OU (b) **contournement gratuit** = échantillonner des frames de la vidéo
  (côté client à l'upload, comme le poster) et les modérer via l'**API image** (gratuite).
- **Cron 2×/jour TOUJOURS KO** : `wrangler deploy` réussit pour le script mais les triggers cron
  échouent en **403 Cloudflare code 10063** « You need a workers.dev subdomain in order to proceed ».
  Fix : **créer une fois le sous-domaine workers.dev** (dashboard Cloudflare → Workers & Pages) puis
  redéployer. Non bloquant (scan manuel + signal de publication OK), à faire avant lancement public.
- **Message de scan** corrigé : un scan > ~9 s (timeout Vercel Hobby) affichait « non configurée » à
  tort ; distingue désormais `configured` (présence de `MODERATION_SIGNAL_SECRET`) → « scan en cours en
  arrière-plan, relance ».
- **Console admin enrichie** : page « Tous les médias » (inventaire complet, arborescence repliable
  utilisateur ▸ carte, **taille des fichiers**, statuts Vérification / Décision IA / Décision admin +
  « Analyse en cours » pour les vidéos en attente de callback) ; regroupement original+vignette en
  revue (fait par **Codex** en parallèle, commité `8997ab6`).
- **`MODERATION_ENFORCE` reste à 0** (rodage). À passer à 1 (videur `wrangler.jsonc` + Vercel) pour
  activer le blocage public + l'auto-suppression, **après** validation.

> ⚠️ **Process** : Codex (OpenAI) a tourné en parallèle sur le même dépôt ce jour (regroupement revue
> + nettoyage médias + posters). Risque de collisions entre deux agents : éviter, committer entre chaque.

**Reste à faire (autre session), par priorité :**
1. **Vidéo** : décider payant Sightengine vs contournement frames→API image (cf. plus haut).
2. **Cron** : créer le sous-domaine workers.dev puis redéployer le videur.
3. **`MODERATION_ENFORCE=1`** (videur + Vercel) quand prêt à bloquer pour de vrai.
4. **CGU** : compléter le nom de l'éditeur (particulier) + relecture juridique ; créer la redirection
   `contact@relieo.fr` → bepocore@gmail.com chez OVH.
5. **DevGate** : retirer `SITE_GATE_PASSWORD` au lancement public.

## État d'avancement (handoff, mis à jour 2026-06-21)

**Fait, commité (repo Relieo, commit `a2d49dc`) — moteur côté videur, compile, INACTIF (`MODERATION_ENFORCE=0`) :**
- `worker/src/sightengine.ts` : appels Sightengine, images (binaire sync) + vidéos (Upload + callback async).
- `worker/src/moderation.ts` : refus d'octet `canServe` (chemin chaud) + store des 5 fichiers d'état R2.
- `worker/src/scan.ts` : boucle de scan (file prioritaire publication → balayage → seed Halsa auto →
  cap quotidien) + `handleVideoCallback`.
- `worker/src/index.ts` : endpoints `/_moderation/scan` + `/_moderation/callback` + cron 2×/jour
  (`wrangler.jsonc`).
- Docs : ce plan + `docs/STORAGE-moderation.md` (contrat des 5 fichiers d'état).

**Fait, commité (commit `52ca704`) :**
- `server/mediaModeration.ts` : socle Vercel (lecture de l'état, `isPubliclyServable`, approve/reject,
  usage, `signalModerationScan`).

**Fait — BLOC A « branchements Vercel » (build OK, reste INACTIF tant que les env vars ne sont pas posées) :**
- `server/mediaModeration.ts` complété : `triggerModerationScan()` (attend le rapport du videur, bouton
  admin), `rejectModerationItems(ids[])` (rejette le couple original + vignette), `filterServableMedia()`
  (couche 2, retire les médias non validés à la lecture publique).
- `api/project.ts` : filtrage à la lecture, **uniquement pour un visiteur public** (le propriétaire/admin
  voit tout), derrière `moderationEnforced()`. No-op tant que `MODERATION_ENFORCE≠1`.
- `api/hikes.ts` : à la publication, signal prioritaire au videur (`signalModerationScan` des médias de la
  carte). Conditionné à `MODERATION_SIGNAL_SECRET` : **aucun coût** (pas même le listing R2) tant qu'absent.
- `api/admin/dashboard.ts` : renvoie `mediaModeration { items (enrichis : mediaUrl videur, ownerEmail,
  mapCode/title), usage, dailyLimit, monthlyLimit }` + une ligne de coût **Sightengine** (onglet Coûts).
- `api/admin/action.ts` : `action:'media-mod'` (`op:'approve'|'reject'`) et `action:'scan-media'`. Le rejet
  supprime original + vignette de R2, retire la réf du `project.json`, notifie le propriétaire (in-app +
  email best-effort, type `media-rejected`) et journalise une sanction `media-reject`.
- Front : onglet **« Modération IA »** dans `AdminView.tsx` (galerie des flaggés avec aperçu + catégorie +
  score, **bouton « Lancer un scan »**, jauges d'ops jour/mois, modale de rejet), badge = nb en attente.
  Type de notification `media-rejected` ajouté (`portalStore`, `firestoreAdmin`, `PortalApp` : titre, popup,
  icône) ; sanction `media-reject` ajoutée (`server/sanctions.ts`).

**Fait — BLOC C « CGU + consentement » (brique 3, build OK) :**
- `portalStore.ts` / `firebase.ts` : champs profil `termsAccepted` / `termsAcceptedAt` +
  `saveTermsAcceptance(uid)`.
- `PortalApp.tsx` : page **`/terms`** publique (`TermsView` : CGU + politique de confidentialité citant
  Sightengine + mentions légales, **premier jet à faire relire**), écran de consentement **bloquant**
  (`TermsOnboarding`, après le choix du forfait, avant le dashboard ; les comptes existants le voient à la
  prochaine connexion ; les admins en sont exemptés). Liens vers `/terms` depuis l'écran de connexion et
  l'onglet Paramètres. Routage `/terms` au niveau racine (lisible connecté comme déconnecté).
- ⚠️ Le contenu juridique est un **brouillon** : identité de l'éditeur à compléter, relecture conseillée.

**Fait — BLOC B « Upload API vidéos > 50 Mo » (worker typecheck OK) :**
- `worker/src/sightengine.ts` : `submitVideoViaUpload(body, size, …)` en 3 temps — `GET /1.0/upload/create-video.json`
  (URL d'upload + media id), **PUT binaire brut streamé depuis R2** via `FixedLengthStream(size)` (Content-Length
  connu, aucun buffer mémoire, jusqu'à plusieurs centaines de Mo), puis `POST /1.0/video/check.json` avec
  `media_id` + `callback_url`. Le callback est traité par le flux existant (`parseVideoCallback`, pending store).
- `worker/src/scan.ts` : le flux vidéo choisit selon la taille — ≤ 50 Mo POST direct, > 50 Mo Upload API. Au-delà
  de `VIDEO_UPLOAD_MAX_BYTES` (512 Mo, envoi resumable par morceaux non implémenté) la vidéo reste `skipped` =
  masquée (fail-closed). Contrat API vérifié sur la doc Sightengine (upload-api).

**Reste à faire : plus rien côté code.** Le chantier est complet et compile ; il ne reste que l'activation
ci-dessous (et la relecture juridique des CGU). La validation bout-en-bout des vidéos > 50 Mo se fera contre
l'API réelle au moment de l'activation (non testable sans compte Sightengine).

**À activer le moment venu (Quentin) — RIEN n'est créé/posé pour l'instant :**
- Créer un compte **Sightengine** (API user + secret).
- Poser les secrets : videur `wrangler secret put SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET /
  MODERATION_SIGNAL_SECRET / MODERATION_CALLBACK_SECRET` ; Vercel `MODERATION_SIGNAL_SECRET` (même
  valeur) + `MODERATION_ENFORCE`.
- `wrangler deploy` (le videur ne se déploie PAS via un git push).
- Vérifier de bout en bout, puis basculer `MODERATION_ENFORCE=1` (videur + Vercel) pour activer le blocage.

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

## Brique 0 — Garantir l'intégrité preview / original

Pourquoi : la preview affichée (miniature sur la carte) est générée par le navigateur et uploadée
**séparément** de l'original. Un client modifié pourrait donc mettre une vignette saine sur un
original inapproprié (ou l'inverse). Scanner uniquement l'original ne protège pas ce qui est affiché.

**Approche retenue (décision 2026-06-21) : on scanne LES DEUX objets, sans toucher au flux d'upload.**
L'upload va directement du navigateur vers R2 (URL signée) ; régénérer la vignette côté serveur
imposerait de retélécharger chaque original + `sharp` + ré-upload (refonte + risque de timeout au
save). On évite ça : le moteur **scanne l'original ET sa vignette** (comme le poster des vidéos), et
**chaque objet est bloqué selon son propre verdict**.

- **Photos** : on garde la vignette générée par le navigateur. Le moteur scanne l'original **et** la
  vignette. Si l'un des deux est flaggé, il est masqué au public (refus d'octet sur sa propre clé R2).
  Coût : 2 ops par photo (original + vignette) au lieu d'1, assumé (le poste de coût réel = la vidéo).
- **Vidéos** : on scanne la vidéo entière **et** le poster client (non fiable). Idem, chacun bloqué
  selon son verdict.
- Conséquence : aucune refonte du flux d'upload. Chaque clé R2 (média OU preview) porte son propre
  statut ; le videur la sert au public seulement si **elle** est scannée et non flaggée. Pas besoin de
  lier preview↔original pour le blocage.
- (Option future si on veut redescendre à 1 op/photo : génération serveur de la vignette via `sharp`.
  Non retenu pour l'instant, gain marginal vs surcoût de code.)

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
  (`media-moderation-queue.json`), puis le **balayage de fond** des brouillons, dans la limite du quota.
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
- L'exception est portée par la var `MODERATION_EXEMPT_FOLDERS` (CSV de folders, défaut `halsa`) et
  s'applique **uniquement au SCAN** : un média d'une carte exemptée n'est jamais envoyé à Sightengine
  (zéro coût). Le seed l'inscrit dans `media-scanned.json` avec un statut validé.
- **Le videur, lui, n'a AUCUNE exception** : tout le monde passe par le même contrôle d'accès, Halsa
  comprise. Elle reste servable au public non pas par un cas particulier, mais parce que le seed l'a
  marquée « scannée ». La règle `canServe` est identique pour toutes les cartes.
- **Par carte, pas par compte** : la nouvelle carte de test de Quentin n'est PAS exemptée → elle passe
  par l'IA, ce qui valide le flux réel de bout en bout.

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

**Suivi de la conso.** Compteur maison dans R2 `relieo/media-moderation-usage.json` (sur le modèle de
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
  non scannés sont poussés en tête d'une file prioritaire (`relieo/media-moderation-queue.json`). Le
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
- **Bouton « Lancer un scan maintenant » en haut de la vue** : déclenche un scan à l'appui
  (`action: 'scan-media'`, cf. 2.3), avec retour d'état (en cours / nombre traité / reste). Pratique
  pour tester sans attendre le cron 2×/jour.
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
- `action: 'scan-media'` → **branché sur le bouton « Lancer un scan maintenant »** (2.1) : signale au
  videur de lancer un lot de scan immédiat ; le mode normal reste le cron 2×/jour. Renvoie un état
  (traités / restants) pour l'affichage admin.

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

1. Intégrité preview/original (brique 0) — le moteur scanne l'original ET la vignette (pas de refonte
   du flux d'upload).
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
