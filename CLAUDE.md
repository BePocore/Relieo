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

### `src/lib/` — pure, framework-free logic

`geo.ts` (haversine `distanceBetween`, Douglas–Peucker `simplifyTrack`, `computeTrailStats`), `gpx.ts` (GPX → `TrackPoint[]`), `media.ts` (EXIF/GPS extraction via `exifr`, `resolvePointMedia` that maps a point to its displayable media), `markers.ts` (SVG marker pins as data URIs), `basemaps.ts`, `format.ts`, `pointMeta.ts`. These are imported widely; treat them as the stable core.

### MapLibre layer — `components/MapLibreTrailMap.tsx`

The map, terrain, route layers, clusters and HTML media markers live in this component. A MapLibre map is created once in a `useEffect`; subsequent effects update GeoJSON sources and markers. Notable patterns:

- **Native touch controls** handle pan, pinch zoom, rotation and pitch. Media markers are draggable in studio only when `locked === false`; double-clicking the map creates a point. `cameraCommand` drives the on-screen rotate/zoom/tilt buttons.
- Points use a clustered GeoJSON source at distant zoom levels. At closer zoom levels, HTML markers display the real lightweight previews while preserving direct clicks and full opacity over terrain.
- Routes are rendered as rounded GPU line layers over AWS Terrarium relief. Satellite, Topo and classic map raster sources can be switched without recreating the map.

### Client-side media thumbnailing (`src/useVideoPosters.ts`, `src/useFramedThumbnails.ts`)

Both hooks generate data-URL images on the fly and cache them. `useVideoPosters` captures a video's first non-black frame (uses `requestVideoFrameCallback` + a DOM-attached muted/playsinline element for iOS Safari, which won't decode frames from a detached/unplayed video). `useFramedThumbnails` draws the photo/poster into a canvas with a white frame. Both rely on the public R2 domain serving permissive CORS headers so cross-origin images can be drawn to canvas without tainting.

### Access control

The `accessCode` gate (`components/AccessGate.tsx`) is **client-side only** — the project JSON is still readable in the `/api/project` response, so this is a light barrier for sharing, not real security. Studio mode bypasses it. Studio is reachable from the public view by a hidden gesture: long-press the compass logo for 1.5s.

### Drafts vs published

A map is a **draft** by default and only becomes **published** on an explicit action (the Studio "publish" save → `handleSaveProject` sends `hikeStatus: 'published'`; the autosave preserves the current status). `api/project.ts` only writes `active.json` for published maps, and its `GET ?code=` is **auth-aware**: a draft is served only to its owner (matching Firebase uid) or an admin — anonymous reads get 404. Media are uploaded to R2 at import time regardless of status (counted in the owner's quota).

**New blank map**: `?mode=studio&new=<code>` starts an empty Studio (works in prod, gated on `isNewBlankStudio = Boolean(newTrailCode)` in `App.tsx`). On the first save (autosave or publish), `syncStudioUrlToCode` swaps `?new=` for `?code=` so a reload reloads the saved draft instead of a blank page.

**Owner publish/unpublish**: the dashboard hike card has a Publier/Dépublier toggle → `POST /api/hikes` (`{ code, status }`, owner- or admin-gated). It flips ONLY the index status (never rewrites `project.json`/media) and manages the `active.json` pointer (cleared if you unpublish the active map; set if you publish and none is active). Unpublishing is non-destructive: the map becomes a draft, still in the owner's dashboard and re-publishable, but anonymous `?code=` reads get 404.

### Admin console (`/api/admin/*`, `src/portal/admin/AdminView.tsx`)

Admins are identified by an **uid allowlist** (`ADMIN_UIDS`, CSV) re-checked server-side on every endpoint via `requireAdmin` (`server/admin.ts`) — never trust the client. The portal calls `GET /api/admin/me` to decide whether to show the Admin entry. **To stay under Vercel's 12-function limit, all admin reads and writes are consolidated into two endpoints** (plus `me`): `GET /api/admin/dashboard` returns everything in one shot (`{ overview, users, maps, sanctions, notifications }`, shared data read once); `POST /api/admin/action` dispatches on `action`: `set-plan`, `map` (`op: unpublish|delete` + owner message), `user-action` (`op: block|unblock|delete-account`), `mark-read` (admin notifications). **God access**: an admin editing someone's map writes under the real owner's prefix and never changes `ownerId`. R2 cost uses `monthlyR2Cost`/`R2_COST_PER_GB_EUR`/`R2_FREE_BYTES` in `server/plans.ts`.

Console sections: **Vue d'ensemble** (stat cards + Revenus panel `MRR/projection/ARPU/par-forfait` from `plans.ts:monthlyPriceEur`, + a hand-rolled SVG user-growth chart in `UserGrowthChart.tsx`), **Utilisateurs** (plan select + block/delete-account actions), **Cartes**, **Sanctions** (log), **Notifications** (appeals), **Stockage R2**.

### In-app notifications & moderation (sanctions)

Two layers, both written **only by the Admin SDK** (clients can't forge them):

- **User notifications** (`firestoreAdmin.pushUserNotification` → `profiles/<uid>.notifications[]`, each with a `read` flag): surfaced by a **notification center** in `DashboardShell` — a bell with a red unread badge, a floating menu (3 latest) and a full **Notifications** tab (`view === 'notifications'`). Opening the bell marks unread as read (`markUserNotificationsRead`, kept not deleted). Types listed in `POPUP_NOTIF_TYPES` (block, delete-account, unpublish, delete) also pop a full-screen modal on dashboard entry; extend that list to feature more.
- **Moderation state** (`server/moderation.ts` → Firestore `moderation/<uid>`, **admin-only write, owner-only read**): `status: active|blocked|deleted`, `message`, `banCount` (total bans, gates the 3-ban delete rule), `appeal` (one message per ban). `POST /api/admin/action {action:'user-action', op}` performs block/unblock/delete-account; **delete-account** wipes the owner's R2 prefix (`r2DeletePrefix(userStorageRoot)`) + all their maps (`removeOwnerFromIndex`) but keeps the Firebase auth user (email stays reserved). `api/upload.ts` and `api/project.ts` PUT reject a non-`active` account (server enforcement). Client: `PortalApp` routes a blocked user to `BlockedScreen` (shows the message, one appeal via `POST /api/account {action:'appeal'}`) and a deleted user to `DeletedScreen` (calls `POST /api/account {action:'finalize-deletion'}`, which sets the Firebase user `disabled:true` → no reconnection, no re-registration with that email). Appeals land in the admin **Notifications** section (R2 `relieo/admin-notifications.json`). The admin can **reply per appeal** (reply stored on the notification, not per-user); the reply to the *current* ban's appeal (linked via `moderation.appeal.notifId`) is mirrored into `moderation.adminReply` and shown on the user's `BlockedScreen`.
- **Sanctions log** (`server/sanctions.ts` → R2 `relieo/sanctions.json`): every map/account action is appended (action, target, admin, message, timestamp) and shown in the Sanctions tab.

> ⚠️ **`firestore.rules` is not auto-deployed** (no `firebase.json`). The `moderation/{userId}` read rule must be published manually (Firebase console or `firebase deploy --only firestore:rules`); until then the client can't read its own status and the block/delete screens won't appear.

> **Emails are deferred**: sanctions/appeals are in-app only for now. Hook points for a future provider (e.g. Resend): the `map` and `user-action` branches of `api/admin/action.ts`, and the `appeal` branch of `api/account.ts`.
