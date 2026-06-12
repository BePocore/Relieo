# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (port 5173). Frontend only; `/api/*` routes do NOT run.
- `npx vercel dev` — full stack on port 3000, including the serverless functions. Use this to exercise `/api/project` and `/api/upload` locally (project must be linked: `npx vercel link`).
- `npm run build` — `tsc -b && vite build`. Run after any change to catch type errors; the strict TS config fails on unused locals/imports.
- `npm run lint` — ESLint over the repo.
- `npm run preview` — serve the production build (port 4173).

There is no test suite.

Env vars: `VITE_CESIUM_ION_TOKEN` (Cesium Ion), `VITE_FLAT_TERRAIN=true` (force flat terrain for testing), `RANDO3D_ADMIN_PASSWORD` (server, gates publishing/upload), `BLOB_READ_WRITE_TOKEN` (auto-added by Vercel Blob).

## Architecture

React 19 + Vite + CesiumJS single-page app deployed on Vercel. One URL, two modes selected at mount by `?mode=studio` (or `#studio`): **public** consultation (read-only) vs **studio** (editing). `App.tsx` holds essentially all state with `useState` — there is no store or router.

### Data model & persistence

The published map is one JSON object (`TrailProject` in `src/types.ts`) stored in **Vercel Blob** at `rando3d/project.json`, fetched/saved through `/api/project` (GET/PUT). On load, App also falls back to the static `public/data/trace.gpx` + `public/data/points.json` if no online project exists.

- Routes are `traces: Trace[]` (multiple GPX, each with a `color`). The legacy flat `track: TrackPoint[]` field is still written on save **because `api/project.ts` validates the PUT with `Array.isArray(project.track)`** — keep it populated (it's the concatenation of all traces). Old single-track projects are wrapped into one trace on load.
- `points: TrailPoint[]` are the photo/video/360/POI markers. `accessCode` (optional) drives the visitor gate.
- When persisting points, `exportablePoints()` in `App.tsx` **whitelists fields** — add any new persisted point field there. Some in-memory fields are deliberately not persisted (e.g. `locked`).

### Serverless API (`api/`, `server/`)

`api/project.ts` (read/write the project blob) and `api/upload.ts` (Vercel Blob client-upload handshake) become Vercel Functions. Both authenticate via the `x-admin-password` header compared to `RANDO3D_ADMIN_PASSWORD` (`server/auth.ts`). Media files are uploaded **directly from the browser** to Vercel Blob via `@vercel/blob/client`; the function only authorizes the token.

### `src/lib/` — pure, framework-free logic

`geo.ts` (haversine `distanceBetween`, Douglas–Peucker `simplifyTrack`, `computeTrailStats`), `gpx.ts` (GPX → `TrackPoint[]`), `media.ts` (EXIF/GPS extraction via `exifr`, `resolvePointMedia` that maps a point to its displayable media), `markers.ts` (SVG marker pins as data URIs), `basemaps.ts`, `terrain.ts`, `format.ts`, `pointMeta.ts`. These are imported widely; treat them as the stable core.

### Cesium layer — `components/TrailMap.tsx`

The only imperative Cesium code. A `Viewer` is created once in a `useEffect`; subsequent effects rebuild entities when `traces`/`points`/posters change. Notable patterns:

- **Native camera controls** are configured directly on `screenSpaceCameraController` (1-finger pan, pinch zoom, 2-finger/right-drag tilt). Custom pointer handlers add: marker **drag** in studio (points are **locked by default** — only `locked === false` is draggable) and **long-press** on empty map to create a point. `cameraCommand` prop drives the on-screen rotate/zoom/tilt buttons.
- **Points live in a `CustomDataSource` with clustering enabled** so overlapping thumbnails collapse into a stacked-count badge. For the count to be correct each point is exactly **one billboard** — the white photo frame is baked into the thumbnail image (see `useFramedThumbnails`) rather than drawn as a second billboard. Clicking a cluster zooms if the points are spread, or opens a gallery lightbox if they share a location.
- Route polylines stay in `viewer.entities`; only markers are clustered.

### Client-side media thumbnailing (`src/useVideoPosters.ts`, `src/useFramedThumbnails.ts`)

Both hooks generate data-URL images on the fly and cache them. `useVideoPosters` captures a video's first non-black frame (uses `requestVideoFrameCallback` + a DOM-attached muted/playsinline element for iOS Safari, which won't decode frames from a detached/unplayed video). `useFramedThumbnails` draws the photo/poster into a canvas with a white frame. Both rely on Vercel Blob serving `Access-Control-Allow-Origin: *` so the cross-origin images can be drawn to canvas without tainting (do not break this assumption).

### Access control

The `accessCode` gate (`components/AccessGate.tsx`) is **client-side only** — the project JSON is still readable in the `/api/project` response, so this is a light barrier for sharing, not real security. Studio mode bypasses it. Studio is reachable from the public view by a hidden gesture: long-press the compass logo for 1.5s.
