# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (port 5173). Frontend only; `/api/*` routes do NOT run.
- `npx vercel dev` — full stack on port 3000, including the serverless functions. Use this to exercise `/api/project` and `/api/upload` locally (project must be linked: `npx vercel link`).
- `npm run build` — `tsc -b && vite build`. Run after any change to catch type errors; the strict TS config fails on unused locals/imports.
- `npm run lint` — ESLint over the repo.
- `npm run preview` — serve the production build (port 4173).

There is no test suite.

Env vars: server-side **Firebase Admin** (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) authenticates API callers (prefer `FIREBASE_PRIVATE_KEY_B64` — base64 of the PEM or the full service-account JSON — to avoid newline-escaping bugs; `cleanPrivateKey` in `server/firebaseAdmin.ts` normalizes the key to a canonical PEM, re-wrapping the base64 body at 64 columns, which fixes `DECODER routines::unsupported`); `RANDO3D_ADMIN_PASSWORD` is now only a legacy admin/fallback gate; `ADMIN_UIDS` is the CSV allowlist of Firebase uids granted the admin console; `CREATOR_UIDS` is the CSV allowlist of Firebase uids that are **creators** (publish maps + creator dashboard) — everyone else is a **viewer** (social feed only); `RESEND_API_KEY` (+ optional `EMAIL_FROM`, default `Relieo <noreply@relieo.fr>`) enables transactional emails via Resend — when absent, email sending falls back to Firebase's native sender; plus the required `R2_*` variables documented in `README.md`. NB: these server secrets are set only for **Preview/Production** on Vercel (not Development) and are "sensitive" (cannot be pulled back), so `npx vercel dev` cannot exercise the R2/Firebase-admin routes locally — only the frontend.

## Architecture

React 19 + Vite + MapLibre GL JS single-page app deployed on Vercel. One URL, two modes selected at mount by `?mode=studio` (or `#studio`): **public** consultation (read-only) vs **studio** (editing). `App.tsx` holds essentially all state with `useState` — there is no store or router.

### Data model & persistence

The published map is one JSON object (`TrailProject` in `src/types.ts`) stored in **Cloudflare R2** under its **owner's** prefix: `relieo/users/<uid>/randonnees/<folder>/project.json` (the `uid` comes from the Firebase token; `<folder>` is the sanitized hike code). Fetched/saved through `/api/project` (GET/PUT). `relieo/index.json` is the registry of all maps (each entry carries `ownerId`, used to resolve the storage key on a public `?code=` read), and `relieo/active.json` identifies the currently published hike for the public default view. There is no browser or static-data fallback. (Historique : l'ancien schéma plat `rando3d/randonnees/<code>/` a été migré vers ce schéma par utilisateur le 2026-06-16.)

- Routes are `traces: Trace[]` (multiple GPX, each with a `color`). The legacy flat `track: TrackPoint[]` field is still written on save **because `api/project.ts` validates the PUT with `Array.isArray(project.track)`** — keep it populated (it's the concatenation of all traces). Old single-track projects are wrapped into one trace on load.
- `points: TrailPoint[]` are the photo/video/360/POI markers. `accessCode` (optional) drives the visitor gate.
- When persisting points, `exportablePoints()` in `App.tsx` **whitelists fields** — add any new persisted point field there. Some in-memory fields are deliberately not persisted (e.g. `locked`).

### Serverless API (`api/`, `server/`)

`api/project.ts` and `api/upload.ts` become Vercel Functions backed exclusively by Cloudflare R2. Auth is primarily a **Firebase ID token** (`Authorization: Bearer`, verified in `server/firebaseAdmin.ts` via `verifyRequestUser`, which also enforces `email_verified` server-side); the legacy `x-admin-password` header (compared to `RANDO3D_ADMIN_PASSWORD`, `server/auth.ts`) is only a fallback when Firebase Admin is unconfigured, and still gates admin-only endpoints (`/api/assign-hike`). **Storage is scoped per user**: every object a user writes lives under `relieo/users/<uid>/`, the single prefix summed for their quota (`server/userStorage.ts`) — so a user can neither write into another's folder nor escape their quota via unpublished folders. Media files are uploaded directly from the browser through signed R2 URLs; failed files are never added to the project and must be selected again.

### GPS trace recorder (`src/portal/TraceViews.tsx`, `src/portal/userTraces.ts`)

A phone-first GPS recorder, separate from the map editor. `TraceRecorderScreen` records positions via `navigator.geolocation.watchPosition` with accuracy/speed-jump guards and a screen Wake Lock; it autosaves a **local draft** (`localStorage`, key `relieo.tracker.draft`) on every point and pushes a **R2 autosave every 10 min**. Recorded traces are stored per user under `relieo/users/<uid>/traces/` (counted in the quota) and managed through `/api/upload` ops `relieo.list-user-traces` / `save-user-trace` / `delete-user-trace`. `TracesView` is the **Traces** tab: list, totals, per-trace GPX export (`traceToGpx`) and delete.

- **States** `idle | recording | paused | saving | saved`. **Pause/resume**: the GPS watch is torn down and the timer frozen while paused; the paused span is excluded from the saved duration (on resume `startedAtMs` is shifted forward, and duration math reads `pausedAtMsRef.current ?? Date.now()`); an `ignoreNextPointRef` guard drops the point that lands right at the pause and the first (often stale) point on resume.
- **Importing a recorded trace into a map** (it becomes a normal `Trace`): in the Studio, the import tab's "Importer une trace depuis Relieo" tile lists the user's traces (`onLoadRelioTraces`/`onImportRelioTrace`); from the Traces tab, the per-trace "Importer" button picks a target map and opens its Studio with the trace pre-added but **unsaved**, handed off via `src/lib/pendingTraceImport.ts` (sessionStorage) and consumed by `App.tsx` after the project loads (only if the code matches). The former "Exporter points.json" Studio button was removed.

### Emails (Resend) (`server/email.ts`, `server/emailTemplates.ts`, `server/emailUsage.ts`)

Transactional emails go through **Resend** via a direct HTTP call (not the SDK, so quota headers can be read). `sendEmail` never throws and returns a boolean; `emailConfigured()` is false when `RESEND_API_KEY` is unset, in which case callers fall back to Firebase's native sender (zero regression).

- **Email verification**: the signup/resend flow calls `POST /api/account {action:'send-verification'}`, which decodes the token with `decodeRequestUser` (does NOT require `email_verified`, unlike `verifyRequestUser`), generates the link with the Admin SDK (`generateEmailVerificationLink`) and sends our own HTML email. The link stays a genuine Firebase action link (Firebase verifies and flips `emailVerified`); only the envelope changes. If Resend is unconfigured/fails, the endpoint returns `{fallback:true}` and the client calls `sendEmailVerification` (Firebase).
- **Moderation emails**: the `map`/`user-action` branches of `api/admin/action.ts` send an email (on top of the in-app notification) when there's an owner message, via `notifyByEmail` (best-effort).
- **Password reset** stays Firebase-native (`sendPasswordResetEmail`): the user isn't authenticated at that point, so a Resend version would need a public endpoint with anti-enumeration + rate limiting. **Change password** lives in the profile (reauth + `updatePassword`, shown only for password-provider accounts).
- **Usage tracking**: Resend returns the real account usage in response headers (`x-resend-daily-quota`, `x-resend-monthly-quota`, marketing included); `recordEmailUsage` stores the latest snapshot in R2 `relieo/email-usage.json`, shown in the admin overview/Coûts. It refreshes on each send (the Resend Usage page is the live source).

### `src/lib/` — pure, framework-free logic

`geo.ts` (haversine `distanceBetween`, Douglas–Peucker `simplifyTrack`, `computeTrailStats`), `gpx.ts` (GPX → `TrackPoint[]`), `media.ts` (EXIF/GPS extraction via `exifr`, `resolvePointMedia` that maps a point to its displayable media), `markers.ts` (SVG marker pins as data URIs), `basemaps.ts`, `format.ts`, `pointMeta.ts`. These are imported widely; treat them as the stable core.

### MapLibre layer — `components/MapLibreTrailMap.tsx`

The map, terrain, route layers, clusters and HTML media markers live in this component. A MapLibre map is created once in a `useEffect`; subsequent effects update GeoJSON sources and markers. Notable patterns:

- **Native touch controls** handle pan, pinch zoom, rotation and pitch. Media markers are draggable in studio only when `locked === false`; double-clicking the map creates a point. `cameraCommand` drives the on-screen rotate/zoom/tilt buttons.
- Points use a clustered GeoJSON source at distant zoom levels. At closer zoom levels, HTML markers display the real lightweight previews while preserving direct clicks and full opacity over terrain.
- Routes are rendered as rounded GPU line layers over AWS Terrarium relief. Satellite, Topo and classic map raster sources can be switched without recreating the map.

### Client-side media thumbnailing (`src/useVideoPosters.ts`, `src/useFramedThumbnails.ts`)

Both hooks generate data-URL images on the fly and cache them. `useVideoPosters` captures a video's first non-black frame (uses `requestVideoFrameCallback` + a DOM-attached muted/playsinline element for iOS Safari, which won't decode frames from a detached/unplayed video). `useFramedThumbnails` draws the photo/poster into a canvas with a white frame. Both rely on the public R2 domain serving permissive CORS headers so cross-origin images can be drawn to canvas without tainting.

### Theming (jour / nuit / auto)

Semantic color tokens live in `src/index.css` (light by default, a blue-night palette under `:root[data-theme='dark']`). `src/lib/theme.ts` stores the preference (`light | dark | auto`) in localStorage, sets it as `data-theme` on `<html>` (applied at boot in `main.tsx`), and `auto` follows the OS setting; the picker (sun / moon / auto) is in the Settings tab. The admin console keeps its own variables and is unaffected.

**FPS gotcha (`.app-shell` in `App.css`)**: the map (public consultation **and** Studio) stays dark regardless of theme — light translucent panels + `backdrop-filter` over the WebGL canvas tank the framerate. Theme switching on the map must only swap the **global** local variables on `.app-shell` (`--bg`, `--text`, `--glass`, `--glass-strong`...), **never** per-element colors of animated MapLibre markers: those markers are repositioned every frame, and resolving `var()` on every style recalc (dozens of markers × 60 fps) collapses the render — so animated-element colors are kept as literals. The dark background is unified (blue-night `#0f1623`, matching the dashboard) across dashboard and Studio.

### Access control (server-enforced code, opaque URL slug) — refonte 2026-07-02

A map's URL now carries an **opaque `slug`** (`?m=<slug>`), decoupled from three things it used to be conflated with: the storage `folder`, and the **access code**. The **access code is a server-side secret**, stored only as a **salted SHA-256 hash** (`accessCodeHash`) in the R2 index (`server/hikeIndex.ts`), **never** in the URL, **never** returned to the client, **never** stored in `project.json` (the PUT handler strips it).

- **Identity**: `HikeIndexEntry.slug` (opaque, folder-safe → `folder === trailFolder(slug)`). `resolveHikeEntry(id)` resolves a slug first, then falls back to `folder` for legacy `?code=` links. New maps get a random opaque slug (`generateMapSlug` in `PortalApp.tsx`); Halsa keeps `slug === folder === "Halsa"` (no R2 move).
- **Enforcement**: for a protected map (`accessCodeHash` present) and a non-owner, `GET /api/project` returns **metadata only** (`{ protected:true, slug, title, coverUrl, hikeStatus }`, no points/media/traces) until the visitor has a **valid grant** — a valid media-ticket cookie for the map's prefix (`verifyTicket` in `server/mediaTicket.ts`). `POST /api/media-ticket` **requires the correct `accessCode`** for a protected map before issuing a ticket, so **content AND media are both gated** (the videur serves nothing without a ticket). This reuses the existing HMAC ticket as the access grant → **no new Vercel function**.
- **Client**: `AccessGate.tsx` submits the code to the server (async); on success the ticket cookie is set and `App.tsx` reloads the full content. The visitor's validated code is kept in a ref to renew the ticket (~60 s). The Studio's "Code d'accès (secret)" field is **write-only** (empty on load = unchanged); the map identity is the slug, not this field. `owner`/admin (Firebase token) always get full content, no code needed.
- **Migration**: the one-shot `migrate-slugs` admin action (slug = folder, plaintext access codes hashed then stripped from `project.json`) **was run in prod on 2026-07-03 and removed from the code** (button + `api/admin/action.ts` case).
- Studio is reachable from the public view by a hidden gesture: long-press the compass logo for 1.5s.

> ⚠️ Not exercised locally (server secrets are Preview/Production-only). Verify on a deployment: metadata-only without a valid grant, wrong code → 401, right code → content, direct `media.relieo.fr` URL refused without ticket.
> **TODO** (noted): move "change access code" out of the Studio into the dashboard 3-dots menu.

### Media access control (videur Cloudflare)

Media are **not public**: the R2 bucket's public `r2.dev` access is **disabled**, files are served only by a **Cloudflare Worker "videur"** at **`media.relieo.fr`** (custom domain; the relieo.fr DNS zone is now managed by **Cloudflare**, OVH staying the registrar + mail/Zimbra + Resend records). The Worker lives in `worker/` (deployed with `wrangler deploy`, **not** by a git push), has an R2 binding on `rando3d-media`, and on every request checks a **signed ticket** (HMAC-SHA256, `worker/src/ticket.ts`) carried by an httpOnly cookie `relieo_media_ticket` on `.relieo.fr` (~2 min, refreshed ~60s); it verifies the requested key is under the ticket's prefix, then serves with Range support + **private** cache + CORS (ACAO reflected + `Vary: Origin` always). Hardened: `ALLOW_HEADER_TICKET=0`, `ALLOWED_ORIGINS=https://relieo.fr`. The signing secret `MEDIA_TICKET_SECRET` must be **identical** on the Worker (`wrangler secret put`, set it via Bash `printf` — a PowerShell pipe corrupts the encoding) and on Vercel.

- **Ticket issuance** — `POST /api/media-ticket` (`api/media-ticket.ts` + `server/mediaTicket.ts`): `{code}` = one map (published → anyone with the code; draft → owner/admin only), `{scope:'user'}` = all of the caller's maps (dashboard), `{scope:'all'}` = everything (admin).
- **URL rewriting at read time** — `server/r2.ts:rewriteMediaUrls` rewrites stored `…r2.dev` URLs to `media.relieo.fr` in `/api/project` (consultation + Studio), `/api/hikes` (user dashboard covers), `/api/admin/dashboard` (admin covers) and `/api/upload`. Storage is unchanged (keys/URLs stay `r2.dev`); `r2KeyFromPublicUrl` accepts **both** bases so saving reconverts correctly.
- **Client** — `src/lib/mediaTicket.ts` (request + refresh loop), `src/lib/mediaAccess.ts` (canvas thumbnails/posters load with `crossOrigin="use-credentials"` when the URL is `media.relieo.fr`, so the cookie is sent). Wired in `App.tsx` (per-map ticket), `PortalApp` (scope user) and `AdminView` (scope all).
- **DNSSEC** was reactivated on Cloudflare after the DNS migration (DS published at OVH, algorithm 13).

### AI media moderation (Sightengine) — wired, enforce-ready

The videur Worker hosts the **AI moderation engine** (Sightengine), added 2026-06-21, activated by `MODERATION_ENFORCE`, `MODERATION_SIGNAL_SECRET` and Sightengine keys. Engine = `worker/src/{sightengine,moderation,scan}.ts` + `/_moderation/scan` & `/_moderation/callback` endpoints + a cron every 4 hours: it pushes media bytes to Sightengine (private bucket, no URL exposed), images sync + videos async (callback), and writes verdicts to 5 R2 state files. The videur's `canServe` refuses non-validated media to the public (fail-closed).

**Vercel side is now fully wired (`server/mediaModeration.ts`), but every branch is a no-op until the env vars are set:**
- **Public read filter** (`api/project.ts`): for a *public visitor only* (owner/admin see everything), media not yet scanned or flagged are stripped from the `?code=` and default reads, behind `moderationEnforced()` (`MODERATION_ENFORCE==='1'`).
- **Publish signal** (`api/hikes.ts`): on publish, prioritised scan request to the videur (`signalModerationScan`), gated on `MODERATION_SIGNAL_SECRET` being present (no R2 list cost otherwise).
- **Admin console**: `GET /api/admin/dashboard` returns `mediaModeration { items (enriched: videur `mediaUrl`, ownerEmail, mapCode/title), usage, dailyLimit, monthlyLimit }` + a **Sightengine** cost line. `POST /api/admin/action` handles `action:'media-mod'` (`op:'approve'|'reject'`) and `action:'scan-media'`. **Reject** deletes the original + its thumbnail from R2, removes the ref from `project.json`, notifies the owner (in-app `media-rejected` + best-effort email) and logs a `media-reject` sanction. The **« Modération IA »** tab in `AdminView.tsx` shows the flagged gallery (preview + category + score), a **« Lancer un scan »** button and day/month op gauges; nav badge = pending count.

**Terms & consent gate**: a `/terms` page (`TermsView` in `PortalApp.tsx`: CGU + privacy policy citing Sightengine + legal notice, **first draft to review**) is public (top-level route, readable logged-in or out), and a **blocking** consent screen (`TermsOnboarding`) is shown after plan choice, before the dashboard (existing users see it next login; admins are exempt). Profile carries `termsAccepted`/`termsAcceptedAt` (`saveTermsAcceptance`). This is the explicit consent for AI moderation, required before public launch.

**Large videos (>50 MB)**: `worker/src/sightengine.ts:submitVideoViaUpload` uses Sightengine's Upload API — `create-video.json` (presigned URL + media id), a **raw streamed PUT from R2** via `FixedLengthStream` (no Worker buffering), then `video/check.json` with `media_id`. `scan.ts` picks direct POST (≤50 MB) vs Upload API (>50 MB); above `VIDEO_UPLOAD_MAX_BYTES` (512 MB) it stays skipped/masked.

**The whole engine is now code-complete and compiles; nothing is left to build — only activation (Sightengine account + secrets + `wrangler deploy` + `MODERATION_ENFORCE=1`) and the legal review of the draft CGU. Full design + data contract + handoff: `docs/PLAN-moderation-ia.md` + `docs/STORAGE-moderation.md`.**

### Drafts vs published

A map is a **draft** by default. **Saving never changes visibility**: the Studio's primary button is **« Sauvegarder »** (`handleSaveProject`) which sends `hikeStatus: isPublished ? 'published' : 'draft'` (a new map stays a draft, a published one stays published); publishing is done only from the dashboard toggle. `api/project.ts` only writes `active.json` for published maps, and its `GET ?code=` is **auth-aware**: a draft is served only to its owner or an admin (anonymous reads get 404). **The index is the source of truth for status**, so `GET ?code=` injects `hikeStatus` from the index entry (un-publishing from the dashboard does NOT rewrite `project.json`, so the stored file's status is stale). The Studio sends the Firebase token on its `?code=` load **only in studio mode** (`App.tsx`), so an owner can reopen/edit their own drafts while a draft link stays 404 in public consultation. Media are uploaded to R2 at import time regardless of status (counted in the owner's quota).

**Unavailable map screen**: in public consultation, if the initial project load fails (unknown code, or a draft not accessible), `App.tsx` shows a full-screen **« Carte indisponible »** (`UnavailableMap.tsx`) instead of mounting the map under an error banner (`loadFailed` state; the boot-loader veil is lifted in that case too).

**New blank map**: `?mode=studio&new=<code>` starts an empty Studio (works in prod, gated on `isNewBlankStudio = Boolean(newTrailCode)` in `App.tsx`). On the first save (autosave or publish), `syncStudioUrlToCode` swaps `?new=` for `?code=` so a reload reloads the saved draft instead of a blank page.

**Owner publish/unpublish**: the dashboard hike card has a Publier/Dépublier toggle → `POST /api/hikes` (`{ code, status }`, owner- or admin-gated). It flips ONLY the index status (never rewrites `project.json`/media) and manages the `active.json` pointer (cleared if you unpublish the active map; set if you publish and none is active). Unpublishing is non-destructive: the map becomes a draft, still in the owner's dashboard and re-publishable, but anonymous `?code=` reads get 404.

### Auth session & login hero

The portal uses **local** Firebase auth persistence with a home-made **7-day sliding expiry** (`src/portal/firebase.ts`): a last-seen timestamp is kept in `localStorage` and the user is signed out only after 7 days without a visit (each visit pushes the deadline back). The login screen's hero is a **slideshow** (`HeroSlideshow.tsx`, crossfade + slow Ken Burns) of landscape photos in `public/hero/`, replacing the former static background image.

### Account types (viewer / creator) & social feed — tranche 1 (front-only)

Two account types: **viewer** (default — browses/follows/saves, no publishing) and **creator** (a viewer who also publishes maps and reaches the creator dashboard). The **role is server-authoritative**: `server/roles.ts` (`isCreatorUid`, `resolveAccountType`) reads the `CREATOR_UIDS` env allowlist (CSV, mirrors `ADMIN_UIDS`); `GET /api/admin/me` now returns `{ admin, accountType }` (no new serverless function — that endpoint is already hit at every login). The Firestore profile carries a reserved `accountType?` field (`profiles/<uid>`, `StoredProfile`/`ProfileExtras`) for a **future « devenir créateur » button** — but the client must never be trusted to self-set it (the profile doc is owner-writable), so the button will go through a controlled server action + a Firestore rule.

**Post-login home = the social feed** (`src/portal/SocialFeed.tsx`, styled by `Feed.css` with the `--c-*` theme tokens). It's a **front-only shell with mocked data** (no follows/likes/feed backend yet): header glass + search + notif bell + profile menu, left nav (Accueil/Explorer/Créateurs suivis/Enregistrées + « Dashboard créateur » for creators), a feed of map-post cards, a right suggestions column, a creator profile view, and a mobile bottom tab bar. Routing in `PortalApp.tsx` (`FirebasePortal`): the `admin` state now also carries `accountType` (graceful `'viewer'` fallback when `/api/admin/me` is unreachable, e.g. `npm run dev`); the **plan-choice step is creator-only** (viewers skip it, keep the CGU gate); the final branch renders `DashboardShell` only for a **creator on a dashboard route** (`/dashboard`, `/hikes`, `/profile`, `/plans`, `/traces`, `/settings`, `/notifications`, `/tracker`) and `SocialFeed` otherwise. The admin still short-circuits to `AdminApp` before any of this.

> **Not yet wired** (next tranches): real follows/likes/saves + a real feed of followed creators' public maps (new Firestore data + route consolidation — 11/12 Hobby functions), the « devenir créateur » button (+ Firestore rule blocking client-set `accountType`), and real viewer profile/settings screens (mocked in the shell for now). `CREATOR_UIDS` must list the creator account's uid on Vercel (Prod) + `.env.local`, else every account is a viewer.

### Admin console (`/api/admin/*`, `src/portal/admin/AdminView.tsx`)

Admins are identified by an **uid allowlist** (`ADMIN_UIDS`, CSV) re-checked server-side on every endpoint via `requireAdmin` (`server/admin.ts`) — never trust the client. The portal calls `GET /api/admin/me` to decide whether to show the Admin entry. **To stay under Vercel's 12-function limit, all admin reads and writes are consolidated into two endpoints** (plus `me`): `GET /api/admin/dashboard` returns everything in one shot (`{ overview, users, maps, sanctions, notifications, email, costs }`, shared data read once); `POST /api/admin/action` dispatches on `action`: `set-plan`, `map` (`op: unpublish|delete` + owner message), `user-action` (`op: block|unblock|delete-account|dismiss-deletion-request`), `mark-read` (admin notifications). **God access**: an admin editing someone's map writes under the real owner's prefix and never changes `ownerId`.

**Cost model** (`server/plans.ts` + `server/costs.ts`): **internal accounts** (admins + `INTERNAL_EMAILS`, today bepocore/quentintardivel) are NOT billed — the 10 Go R2 free tier is attributed to them; real users are billed at the **full per-Go rate** (`R2_COST_PER_GB_EUR`, `monthlyR2Cost` without the free tier) from the first Go. `overview.monthlyCostEur` = sum of billable users, so the R2 line and the top-consumers list match. **Deleted accounts are excluded from costs AND from revenue analytics** (MRR/paid/ARPU/growth chart). `server/costs.ts` also holds the fixed costs (`FIXED_COSTS`, e.g. the 6 €/an OVH domain), amortized monthly.

Console sections: **Vue d'ensemble** (stat cards + an **Emails (Resend)** quota panel `daily/100 + monthly/3000` + Revenus panel `MRR/projection/ARPU/par-forfait` from `plans.ts:monthlyPriceEur` + a hand-rolled SVG user-growth chart in `UserGrowthChart.tsx`), **Coûts** (budget: balance `MRR − coûts` with annual projection, per-platform costs from the `costs` payload, R2 top consumers), **Utilisateurs** (plan select + block/delete-account, a **« Supprimé »** column with date/admin, pending deletion requests shown in red and sorted to the bottom), **Cartes**, **Sanctions** (log), **Notifications** (appeals + deletion requests), **Stockage R2**.

### In-app notifications & moderation (sanctions)

Two layers, both written **only by the Admin SDK** (clients can't forge them):

- **User notifications** (`firestoreAdmin.pushUserNotification` → `profiles/<uid>.notifications[]`, each with a `read` flag): surfaced by a **notification center** in `DashboardShell` — a bell with a red unread badge, a floating menu (3 latest) and a full **Notifications** tab (`view === 'notifications'`). Opening the bell marks unread as read (`markUserNotificationsRead`, kept not deleted). Types listed in `POPUP_NOTIF_TYPES` (block, delete-account, unpublish, delete) also pop a full-screen modal on dashboard entry; extend that list to feature more.
- **Moderation state** (`server/moderation.ts` → Firestore `moderation/<uid>`, **admin-only write, owner-only read**): `status: active|blocked|deleted`, `message`, `banCount` (total bans, gates the 3-ban delete rule), `appeal` (one message per ban). `POST /api/admin/action {action:'user-action', op}` performs block/unblock/delete-account; **delete-account** wipes the owner's R2 prefix (`r2DeletePrefix(userStorageRoot)`) + all their maps (`removeOwnerFromIndex`); for a **3-ban** sanction it keeps the Firebase auth user (email reserved, disabled at next login). `api/upload.ts` and `api/project.ts` PUT reject a non-`active` account (server enforcement). Client: `PortalApp` routes a blocked user to `BlockedScreen` (shows the message, one appeal via `POST /api/account {action:'appeal'}`) and a deleted user to `DeletedScreen` (calls `POST /api/account {action:'finalize-deletion'}`, which sets the Firebase user `disabled:true` → no reconnection, no re-registration with that email). Appeals land in the admin **Notifications** section (R2 `relieo/admin-notifications.json`). The admin can **reply per appeal** (reply stored on the notification, not per-user); the reply to the *current* ban's appeal (linked via `moderation.appeal.notifId`) is mirrored into `moderation.adminReply` and shown on the user's `BlockedScreen`.
- **Voluntary deletion request** (`moderation.deletionRequest`, plus `email`/`deletedAt`/`deletedBy`): a user requests their own deletion from their profile (`requestAccountDeletion` → `POST /api/account {action:'request-deletion'}`), which sets `moderation.deletionRequest` and posts an admin notification (`type: 'deletion-request'`). The admin acts from that notification — **delete** (`user-action delete-account` is allowed when `banCount >= 3` **OR** a `deletionRequest` exists) or **dismiss** (`op: 'dismiss-deletion-request'`). A **requested** deletion also **deletes the Firebase auth user** (`getAuth().deleteUser`) so the email is freed (the user can re-register); the account is then rebuilt from `moderation` as a **ghost row** (status `deleted`, kept `email`/`deletedAt`/`deletedBy`) in `api/admin/dashboard.ts` so it still appears in the **« Supprimé »** column.
- **Sanctions log** (`server/sanctions.ts` → R2 `relieo/sanctions.json`): every map/account action is appended (action, target, admin, message, timestamp) and shown in the Sanctions tab.

> ⚠️ **`firestore.rules` is not auto-deployed** (no `firebase.json`). The `moderation/{userId}` read rule **was deployed manually on 2026-06-18**, so moderation/block/delete screens work. Any NEW Firestore rule still has to be published by hand (Firebase console or `firebase deploy --only firestore:rules`).

> **Emails via Resend** (see the Emails section): moderation actions (`map`/`user-action` in `api/admin/action.ts`) and email verification now send real emails when `RESEND_API_KEY` is set, falling back to Firebase/in-app otherwise. Appeals and deletion requests directed at the admin stay in-app only.
