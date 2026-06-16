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

### Admin console (`/api/admin/*`, `src/portal/admin/`)

Admins are identified by an **uid allowlist** (`ADMIN_UIDS`, CSV) re-checked server-side on every endpoint via `requireAdmin` (`server/admin.ts`) — never trust the client. The portal calls `GET /api/admin/me` to decide whether to show the Admin entry. Endpoints (all admin-gated): `users` (all accounts + plan + maps/media + R2 usage & real cost), `overview` (site totals + R2 cost), `maps` (god-view of every map incl. drafts), `set-plan` (override a user's plan via Firestore Admin), `map` (unpublish/delete a map). **God access**: an admin editing someone's map writes under the real owner's prefix and never changes `ownerId` (ownership is preserved). R2 cost uses `monthlyR2Cost`/`R2_COST_PER_GB_EUR`/`R2_FREE_BYTES` in `server/plans.ts`.
