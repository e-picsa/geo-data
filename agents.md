# AI Assistants Architecture Guide

Welcome! This system is a monorepo consisting of:

1. `api/` (powered by Bun)
2. `web/` (React + Vite + Tailwind CSS)

## Core Tasks

### The API (Backend)

- Written in TypeScript and runs on **Bun**.
- Uses `Bun.serve()` in `api/src/main.ts` as the webserver (defaults to port `5174` in local dev).
- The core logic downloads Geofabrik PBF extracts, extracts boundary relations, then translates them via Mapshaper into TopoJSON.
- Environment variables are accessed via `process.env`. Make sure `CACHE_BUCKET` is present if you want GCS caching.
- **Deploys and prewarming**: the API deploys via Cloud Build (`cloudbuild.yaml`, Developer Connect trigger on `main`). Its final `Warm` step requests `GET /boundaries/{MW,ZM,ZW}` after the new revision is serving, so the cache is populated by the service's own identity — no CI credentials or repo variables. Keep the prewarm set small: it exists for the handful of countries the app opens on, not for everything configured in `GEOFABRIK_COUNTRIES`.
- **The prewarm list is deliberately duplicated**: `PREWARM_COUNTRIES` in `api/src/services/geofabrik/url-mapping.ts` and `_PREWARM_COUNTRIES` in `cloudbuild.yaml`. Change both, or the API's hint and the warm step disagree silently.
- **Cache versions are bumped by hand in two places**: `CACHE_VERSION` in `fetch-geofabrik.ts` (extraction output, `geofabrik/v6/…` — bumping forces a re-download and re-extract) and in `admin-boundaries.ts` (derived TopoJSON, `derived/v10/…` — bumping forces a Mapshaper re-run). A bump invalidates cached bytes for every country; see the README's cache-version table before touching conversion or extraction code.
- **Countries** are configured in `GEOFABRIK_COUNTRIES` (`api/src/services/geofabrik/url-mapping.ts`); anything not listed returns `404 COUNTRY_NOT_SUPPORTED`.
- To add dependencies, use `bun add <pkg> --cwd api`.
- To test the API, run `bun test` in the `api` folder.

### The Web (Frontend)

- Written in React + Vite + Tailwind CSS.
- **Vite Proxy:** Vite intercepts calls to `/api` and forwards them to `http://localhost:5174` (the Bun API).
- **Map:** Uses MapLibre to display map bounds and vector/raster layers. TopoJSON data from the API is run through `topojson-client` to render GeoJSON features.
- To add dependencies, use `bun add <pkg> --cwd web` (since shadcn initialization failed, we are avoiding `npx`).
- Styling uses pure Tailwind classes in `className`.

## Best Practices

- Avoid introducing any heavy DOM libraries into the frontend. The entire application is designed to be lightweight.
- For local dev, run `npm start` (or `bun start`) in the project root to spool up both instances concurrently.

## AI Assistant Operational Guidelines (Token & Tool Efficiency)

- **Minimal Tool Calls**: Do not run repetitive polling commands (e.g. repeatedly tailing or checking log files in loops). When executing long-running test commands, either wait synchronously or wait for the system to notify upon completion without intermediate polling.
- **Focused Execution**: When tasked with a targeted code change (such as removing console log spam or adjusting a UI component), make the targeted edit directly. Avoid expanding scope or running multi-minute integration suites unless explicitly requested.
- **Clean Console Output**: Keep runtime and test logs quiet. Never commit noisy loops, raw dump logs, or repetitive warning messages into production code paths.
- **Token Parsimony**: Keep reasoning and output direct, actionable, and succinct. Avoid speculative explanations or repeating context.

## Versioning

- The release version lives in the root `package.json` (surfaced in the web UI via `VITE_APP_VERSION`).
- Always bump it with every user-facing change: patch bump (e.g. `2.3.0` → `2.3.1`) for fixes, minor bump (e.g. `2.3.0` → `2.4.0`) for new features.
- Never leave the version unchanged when shipping a release.
