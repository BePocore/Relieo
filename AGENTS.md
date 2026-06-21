# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (port 5173). Frontend only; `/api/*` routes do NOT run.
- `npx vercel dev` — full stack on port 3000, including the serverless functions. Use this to exercise `/api/project` and `/api/upload` locally (project must be linked: `npx vercel link`).
- `npm run build` — `tsc -b && vite build`. Run after any change to catch type errors; the strict TS config fails on unused locals/imports.
- `npm run lint` — ESLint over the repo.
- `npm run preview` — serve the production build (port 4173).

There is no test suite.

Env vars: server-side **Firebase Admin** (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) authenticates API callers (prefer `FIREBASE_PRIVATE_KEY_B64` — base64 of the PEM or full service-account JSON; `cleanPrivateKey` normalizes the key to a canonical PEM, fixing `DECODER routines::unsupported`); `RANDO3D_ADMIN_PASSWORD` is now only a legacy admin/fallback gate; `ADMIN_UIDS` is the CSV allowlist of Firebase uids granted the admin console (`/api/admin/*`, re-checked server-side); `RESEND_API_KEY` (+ optional `EMAIL_FROM`, default `Relieo <noreply@relieo.fr>`) enables transactional emails via Resend (absent → fallback to Firebase's native sender); plus the required `R2_*` variables documented in `README.md`. NB: these server secrets are set only for **Preview/Production** on Vercel (not Development) and are "sensitive" (cannot be pulled back), so `npx vercel dev` cannot exercise the R2/Firebase-admin routes locally — only the frontend.

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

Transactional emails go through **Resend** via a direct HTTP call (not the SDK, so quota headers can be read). `sendEmail` never throws and returns a boolean; `emailConfigured()` is false when `RESEND_API_KEY` is unset, then callers fall back to Firebase's native sender (zero regression).

- **Email verification**: signup/resend calls `POST /api/account {action:'send-verification'}`, which decodes the token with `decodeRequestUser` (does NOT require `email_verified`, unlike `verifyRequestUser`), generates the link via the Admin SDK (`generateEmailVerificationLink`) and sends our own HTML email — the link stays a genuine Firebase action link (only the envelope changes). Resend unconfigured/failing → `{fallback:true}` and the client uses `sendEmailVerification`.
- **Moderation emails**: `map`/`user-action` branches of `api/admin/action.ts` also email the owner (via `notifyByEmail`, best-effort) on top of the in-app notification.
- **Password reset** stays Firebase-native (`sendPasswordResetEmail`, user not authenticated → a Resend version would need a public endpoint with anti-enumeration + rate limiting). **Change password** is in the profile (reauth + `updatePassword`, password-provider accounts only).
- **Usage tracking**: Resend returns real account usage in response headers (`x-resend-daily-quota`, `x-resend-monthly-quota`, marketing included); `recordEmailUsage` stores the latest snapshot in R2 `relieo/email-usage.json`, shown in the admin overview/Coûts (refreshes on each send).

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

Semantic tokens in `src/index.css` (light default, blue-night `[data-theme='dark']`); `src/lib/theme.ts` keeps the preference (`light|dark|auto`, auto follows the OS) in localStorage and sets `data-theme` on `<html>` (applied at boot in `main.tsx`); picker is in Settings. Admin keeps its own colors. **FPS gotcha**: the map (consultation + Studio) stays dark always (light translucent panels + `backdrop-filter` over the WebGL canvas tank FPS), and theme switching on the map only swaps the global `.app-shell` variables (`--bg`, `--text`, `--glass`...), **never** per-element colors of animated MapLibre markers (repositioned every frame — resolving `var()` per recalc across dozens of markers collapses the render, so those stay literal). Dark background unified to blue-night `#0f1623` across dashboard and Studio.

### Media access control (videur Cloudflare)

Media are **not public**: the R2 bucket's public `r2.dev` access is **disabled**, files are served only by a **Cloudflare Worker "videur"** at **`media.relieo.fr`** (custom domain; the relieo.fr DNS zone is now managed by **Cloudflare**, OVH staying the registrar + mail/Zimbra + Resend records). The Worker lives in `worker/` (deployed with `wrangler deploy`, **not** by a git push), has an R2 binding on `rando3d-media`, and on every request checks a **signed ticket** (HMAC-SHA256, `worker/src/ticket.ts`) carried by an httpOnly cookie `relieo_media_ticket` on `.relieo.fr` (~2 min, refreshed ~60s); it verifies the requested key is under the ticket's prefix, then serves with Range support + **private** cache + CORS (ACAO reflected + `Vary: Origin` always). Hardened: `ALLOW_HEADER_TICKET=0`, `ALLOWED_ORIGINS=https://relieo.fr`. The signing secret `MEDIA_TICKET_SECRET` must be **identical** on the Worker (`wrangler secret put`, set it via Bash `printf` — a PowerShell pipe corrupts the encoding) and on Vercel.

- **Ticket issuance** — `POST /api/media-ticket` (`api/media-ticket.ts` + `server/mediaTicket.ts`): `{code}` = one map (published → anyone with the code; draft → owner/admin only), `{scope:'user'}` = all of the caller's maps (dashboard), `{scope:'all'}` = everything (admin).
- **URL rewriting at read time** — `server/r2.ts:rewriteMediaUrls` rewrites stored `…r2.dev` URLs to `media.relieo.fr` in `/api/project` (consultation + Studio), `/api/hikes` (user dashboard covers), `/api/admin/dashboard` (admin covers) and `/api/upload`. Storage is unchanged (keys/URLs stay `r2.dev`); `r2KeyFromPublicUrl` accepts **both** bases so saving reconverts correctly.
- **Client** — `src/lib/mediaTicket.ts` (request + refresh loop), `src/lib/mediaAccess.ts` (canvas thumbnails/posters load with `crossOrigin="use-credentials"` when the URL is `media.relieo.fr`, so the cookie is sent). Wired in `App.tsx` (per-map ticket), `PortalApp` (scope user) and `AdminView` (scope all).
- **DNSSEC** reactivated on Cloudflare after the DNS migration (DS published at OVH, algorithm 13). Future moderation (Sightengine) will reuse this same Worker to refuse a flagged media at request time (TODO hook in `worker/src/index.ts`).

### Access control

The `accessCode` gate (`components/AccessGate.tsx`) is **client-side only** — the project JSON is still readable in the `/api/project` response, so this is a light barrier for sharing, not real security. Studio mode bypasses it. Studio is reachable from the public view by a hidden gesture: long-press the compass logo for 1.5s. The portal uses **local** Firebase persistence with a **7-day sliding sign-out** (`src/portal/firebase.ts`); the login hero is a landscape **slideshow** (`HeroSlideshow.tsx`, photos in `public/hero/`).

### Drafts & admin console

Maps are **drafts** by default; the Studio's button is **« Sauvegarder »** (`handleSaveProject` keeps the current status — a new map stays a draft), publishing is done from the dashboard. `api/project.ts` writes `active.json` for published maps only; its `GET ?code=` is auth-aware (a draft is served to its owner or an admin, else 404), **injects the real `hikeStatus` from the index** (un-publishing never rewrites `project.json`), and the Studio sends the Firebase token on `?code=` load **only in studio mode** (an owner can reopen drafts; a draft link 404s in public consultation → full-screen **« Carte indisponible »**, `UnavailableMap.tsx`). `?mode=studio&new=<code>` starts an empty Studio in prod (`isNewBlankStudio` in `App.tsx`); the first save swaps `?new=`→`?code=` (`syncStudioUrlToCode`). The owner (or admin) flips publish/draft from the dashboard via `POST /api/hikes {code,status}` — status-only, never rewrites `project.json`/media; manages the `active.json` pointer. Admins are an **uid allowlist** (`ADMIN_UIDS`) re-checked server-side by `requireAdmin` (`server/admin.ts`). **Endpoints are consolidated to stay under Vercel's 12-function limit**: `GET /api/admin/me`, `GET /api/admin/dashboard` (returns `{overview,users,maps,sanctions,notifications,email,costs}` in one call), `POST /api/admin/action` (dispatch on `action`: `set-plan`|`map`|`user-action`|`mark-read`). God access preserves ownership. **Cost model** (`server/plans.ts` + `server/costs.ts`): internal accounts (admins + `INTERNAL_EMAILS`) are not billed (the 10 Go R2 free tier is attributed to them), real users are billed at the full per-Go rate from the first Go; deleted accounts are excluded from costs AND revenue analytics; `FIXED_COSTS` holds fixed costs (e.g. the OVH domain). UI: `src/portal/admin/AdminView.tsx` (Vue d'ensemble incl. an Emails/Resend quota panel + Revenus + SVG growth chart, **Coûts** = balance `MRR − coûts` + per-platform costs + R2 top consumers, Utilisateurs, Cartes, Sanctions, Notifications, Stockage).

### Notifications & account moderation (sanctions)

All admin-written, never client-forgeable. **User notifications** (`pushUserNotification` → `profiles/<uid>.notifications[]`, with a `read` flag) feed a bell + floating menu + Notifications tab in `DashboardShell`; types in `POPUP_NOTIF_TYPES` also pop a full-screen modal on entry. Admin replies to appeals are stored per-notification and mirrored to `moderation.adminReply` for the current ban (via `moderation.appeal.notifId`). **Moderation state** (`server/moderation.ts` → Firestore `moderation/<uid>`, admin-only write / owner-only read): `status active|blocked|deleted`, `message`, `banCount` (gates the 3-ban delete), `appeal` (1/ban). `POST /api/admin/action {action:'user-action'}` does block/unblock/delete-account/**dismiss-deletion-request**; a **3-ban** delete-account wipes the owner's R2 prefix + maps (`removeOwnerFromIndex`) but keeps the Firebase user (email reserved); `POST /api/account {action:'finalize-deletion'}` sets `disabled:true` on acknowledgment. `upload`/`project` PUT reject a non-`active` account. Blocked/deleted users hit `BlockedScreen`/`DeletedScreen` in `PortalApp`; appeals (`POST /api/account {action:'appeal'}`) go to the admin Notifications section (R2 `relieo/admin-notifications.json`). **Voluntary deletion**: a user can request deletion from their profile (`POST /api/account {action:'request-deletion'}` → `moderation.deletionRequest` + admin notif `type:'deletion-request'`); the admin deletes (allowed if `banCount>=3` OR a request exists) or dismisses. A requested deletion also `deleteUser`s the Firebase account (email freed, re-registration possible) and is kept as a **ghost row** (`email`/`deletedAt`/`deletedBy`) for the admin « Supprimé » column. The full log is R2 `relieo/sanctions.json` (`server/sanctions.ts`). ⚠️ `firestore.rules` is **not auto-deployed** (no `firebase.json`): the `moderation/{userId}` rule was deployed manually on 2026-06-18; any new rule needs manual deployment. **Emails via Resend** (see the Emails section): moderation (`map`/`user-action`) and email verification send real emails when `RESEND_API_KEY` is set, else fall back to Firebase/in-app; appeals and deletion requests to the admin stay in-app.
