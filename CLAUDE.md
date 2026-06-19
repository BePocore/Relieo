# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (port 5173). Frontend only; `/api/*` routes do NOT run.
- `npx vercel dev` — full stack on port 3000, including the serverless functions. Use this to exercise `/api/project` and `/api/upload` locally (project must be linked: `npx vercel link`).
- `npm run build` — `tsc -b && vite build`. Run after any change to catch type errors; the strict TS config fails on unused locals/imports.
- `npm run lint` — ESLint over the repo.
- `npm run preview` — serve the production build (port 4173).

There is no test suite.

Env vars: server-side **Firebase Admin** (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) authenticates API callers (prefer `FIREBASE_PRIVATE_KEY_B64` — base64 of the PEM or the full service-account JSON — to avoid newline-escaping bugs; `cleanPrivateKey` in `server/firebaseAdmin.ts` normalizes the key to a canonical PEM, re-wrapping the base64 body at 64 columns, which fixes `DECODER routines::unsupported`); `RANDO3D_ADMIN_PASSWORD` is now only a legacy admin/fallback gate; `ADMIN_UIDS` is the CSV allowlist of Firebase uids granted the admin console; plus the required `R2_*` variables documented in `README.md`. NB: these server secrets are set only for **Preview/Production** on Vercel (not Development) and are "sensitive" (cannot be pulled back), so `npx vercel dev` cannot exercise the R2/Firebase-admin routes locally — only the frontend.

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

### Access control

The `accessCode` gate (`components/AccessGate.tsx`) is **client-side only** — the project JSON is still readable in the `/api/project` response, so this is a light barrier for sharing, not real security. Studio mode bypasses it. Studio is reachable from the public view by a hidden gesture: long-press the compass logo for 1.5s.

### Drafts vs published

A map is a **draft** by default. **Saving never changes visibility**: the Studio's primary button is **« Sauvegarder »** (`handleSaveProject`) which sends `hikeStatus: isPublished ? 'published' : 'draft'` (a new map stays a draft, a published one stays published); publishing is done only from the dashboard toggle. `api/project.ts` only writes `active.json` for published maps, and its `GET ?code=` is **auth-aware**: a draft is served only to its owner or an admin (anonymous reads get 404). **The index is the source of truth for status**, so `GET ?code=` injects `hikeStatus` from the index entry (un-publishing from the dashboard does NOT rewrite `project.json`, so the stored file's status is stale). The Studio sends the Firebase token on its `?code=` load **only in studio mode** (`App.tsx`), so an owner can reopen/edit their own drafts while a draft link stays 404 in public consultation. Media are uploaded to R2 at import time regardless of status (counted in the owner's quota).

**Unavailable map screen**: in public consultation, if the initial project load fails (unknown code, or a draft not accessible), `App.tsx` shows a full-screen **« Carte indisponible »** (`UnavailableMap.tsx`) instead of mounting the map under an error banner (`loadFailed` state; the boot-loader veil is lifted in that case too).

**New blank map**: `?mode=studio&new=<code>` starts an empty Studio (works in prod, gated on `isNewBlankStudio = Boolean(newTrailCode)` in `App.tsx`). On the first save (autosave or publish), `syncStudioUrlToCode` swaps `?new=` for `?code=` so a reload reloads the saved draft instead of a blank page.

**Owner publish/unpublish**: the dashboard hike card has a Publier/Dépublier toggle → `POST /api/hikes` (`{ code, status }`, owner- or admin-gated). It flips ONLY the index status (never rewrites `project.json`/media) and manages the `active.json` pointer (cleared if you unpublish the active map; set if you publish and none is active). Unpublishing is non-destructive: the map becomes a draft, still in the owner's dashboard and re-publishable, but anonymous `?code=` reads get 404.

### Auth session & login hero

The portal uses **local** Firebase auth persistence with a home-made **7-day sliding expiry** (`src/portal/firebase.ts`): a last-seen timestamp is kept in `localStorage` and the user is signed out only after 7 days without a visit (each visit pushes the deadline back). The login screen's hero is a **slideshow** (`HeroSlideshow.tsx`, crossfade + slow Ken Burns) of landscape photos in `public/hero/`, replacing the former static background image.

### Admin console (`/api/admin/*`, `src/portal/admin/AdminView.tsx`)

Admins are identified by an **uid allowlist** (`ADMIN_UIDS`, CSV) re-checked server-side on every endpoint via `requireAdmin` (`server/admin.ts`) — never trust the client. The portal calls `GET /api/admin/me` to decide whether to show the Admin entry. **To stay under Vercel's 12-function limit, all admin reads and writes are consolidated into two endpoints** (plus `me`): `GET /api/admin/dashboard` returns everything in one shot (`{ overview, users, maps, sanctions, notifications }`, shared data read once); `POST /api/admin/action` dispatches on `action`: `set-plan`, `map` (`op: unpublish|delete` + owner message), `user-action` (`op: block|unblock|delete-account|dismiss-deletion-request`), `mark-read` (admin notifications). **God access**: an admin editing someone's map writes under the real owner's prefix and never changes `ownerId`. R2 cost uses `monthlyR2Cost`/`R2_COST_PER_GB_EUR`/`R2_FREE_BYTES` in `server/plans.ts`.

Console sections: **Vue d'ensemble** (stat cards + Revenus panel `MRR/projection/ARPU/par-forfait` from `plans.ts:monthlyPriceEur`, + a hand-rolled SVG user-growth chart in `UserGrowthChart.tsx`), **Utilisateurs** (plan select + block/delete-account, a **« Supprimé »** column with date/admin, pending deletion requests shown in red and sorted to the bottom), **Cartes**, **Sanctions** (log), **Notifications** (appeals + deletion requests), **Stockage R2**.

### In-app notifications & moderation (sanctions)

Two layers, both written **only by the Admin SDK** (clients can't forge them):

- **User notifications** (`firestoreAdmin.pushUserNotification` → `profiles/<uid>.notifications[]`, each with a `read` flag): surfaced by a **notification center** in `DashboardShell` — a bell with a red unread badge, a floating menu (3 latest) and a full **Notifications** tab (`view === 'notifications'`). Opening the bell marks unread as read (`markUserNotificationsRead`, kept not deleted). Types listed in `POPUP_NOTIF_TYPES` (block, delete-account, unpublish, delete) also pop a full-screen modal on dashboard entry; extend that list to feature more.
- **Moderation state** (`server/moderation.ts` → Firestore `moderation/<uid>`, **admin-only write, owner-only read**): `status: active|blocked|deleted`, `message`, `banCount` (total bans, gates the 3-ban delete rule), `appeal` (one message per ban). `POST /api/admin/action {action:'user-action', op}` performs block/unblock/delete-account; **delete-account** wipes the owner's R2 prefix (`r2DeletePrefix(userStorageRoot)`) + all their maps (`removeOwnerFromIndex`); for a **3-ban** sanction it keeps the Firebase auth user (email reserved, disabled at next login). `api/upload.ts` and `api/project.ts` PUT reject a non-`active` account (server enforcement). Client: `PortalApp` routes a blocked user to `BlockedScreen` (shows the message, one appeal via `POST /api/account {action:'appeal'}`) and a deleted user to `DeletedScreen` (calls `POST /api/account {action:'finalize-deletion'}`, which sets the Firebase user `disabled:true` → no reconnection, no re-registration with that email). Appeals land in the admin **Notifications** section (R2 `relieo/admin-notifications.json`). The admin can **reply per appeal** (reply stored on the notification, not per-user); the reply to the *current* ban's appeal (linked via `moderation.appeal.notifId`) is mirrored into `moderation.adminReply` and shown on the user's `BlockedScreen`.
- **Voluntary deletion request** (`moderation.deletionRequest`, plus `email`/`deletedAt`/`deletedBy`): a user requests their own deletion from their profile (`requestAccountDeletion` → `POST /api/account {action:'request-deletion'}`), which sets `moderation.deletionRequest` and posts an admin notification (`type: 'deletion-request'`). The admin acts from that notification — **delete** (`user-action delete-account` is allowed when `banCount >= 3` **OR** a `deletionRequest` exists) or **dismiss** (`op: 'dismiss-deletion-request'`). A **requested** deletion also **deletes the Firebase auth user** (`getAuth().deleteUser`) so the email is freed (the user can re-register); the account is then rebuilt from `moderation` as a **ghost row** (status `deleted`, kept `email`/`deletedAt`/`deletedBy`) in `api/admin/dashboard.ts` so it still appears in the **« Supprimé »** column.
- **Sanctions log** (`server/sanctions.ts` → R2 `relieo/sanctions.json`): every map/account action is appended (action, target, admin, message, timestamp) and shown in the Sanctions tab.

> ⚠️ **`firestore.rules` is not auto-deployed** (no `firebase.json`). The `moderation/{userId}` read rule **was deployed manually on 2026-06-18**, so moderation/block/delete screens work. Any NEW Firestore rule still has to be published by hand (Firebase console or `firebase deploy --only firestore:rules`).

> **Emails are deferred**: sanctions/appeals are in-app only for now. Hook points for a future provider (e.g. Resend): the `map` and `user-action` branches of `api/admin/action.ts`, and the `appeal` branch of `api/account.ts`.
