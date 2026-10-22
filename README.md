# PICSA Geo Data

A bun monorepo for managing Geo data within the E-PICSA App

![](./home-screen.png)

## Quickstart

Prerequisites: [Bun](https://bun.sh/) installed. The API uses `sharp` for converting PNG map tiles into WebP images. Node's package manager handles the precompiled binaries during install automatically.

```bash
# Install dependencies (both workspaces)
bun install

# Run both API and frontend concurrently
bun start
```

The Vite dev server proxies `/api` requests to the Bun API at [localhost:5174](http://localhost:5174), so the frontend works seamlessly in development without CORS issues.

Use a rest client like [Insomnia](https://insomnia.rest) to test requests

E.g. POST request for admin_4 boundaries

```shell
curl --request POST --url http://localhost:5174/ --data '{"country_code":"ZM","admin_level":2}'
```

First request will download the Geofabrik PBF extract for the country
This may take significant time as it involves downloading the full `.pbf` from http://download.geofabrik.de/, which could be > 100MB

Subsequent requests will be served from local cache [./api/.cache](./api/.cache)

## Architecture

| Component        | Stack                       | Deployment                  |
| ---------------- | --------------------------- | --------------------------- |
| **API** (`api/`) | Bun + TypeScript            | Google Cloud Run via Docker |
| **Web** (`web/`) | React + Vite + Tailwind CSS | GitHub Pages                |

## Environment Variables

| Variable       | Description                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `PORT`         | The port the API server listens on (default: `5174` locally, `8080` in Docker/Cloud Run)        |
| `CACHE_BUCKET` | GCS bucket name for caching PBF extracts and derived TopoJSON. If not set, caching is disabled. |
| `VITE_API_URL` | (Frontend build-time) The production API URL. Defaults to `/api` for local dev.                 |

### Caching Configuration (GCS)

To speed up requests, raw Geofabrik PBF extracts and derived TopoJSON are cached in Google Cloud Storage.

**Setup Requirements:**

1. A GCS bucket.
2. Provide the bucket name via the `CACHE_BUCKET` environment variable.
3. Configure **Object Lifecycle Management** on the bucket to automatically delete objects older than 90 days.
4. The compute identity running this service (e.g., Cloud Run service account) needs `roles/storage.objectAdmin` on the target bucket.

### Cache Versions

Cached objects are namespaced by two independent versions, both bumped by hand when the code that produces them changes:

| Constant            | Location                                        | Invalidates                                                                            | Cost of bumping                                        |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `CACHE_VERSION = 6` | `api/src/services/geofabrik/fetch-geofabrik.ts` | Extraction output under `geofabrik/v6/…` (raw PBF, extracted relations, intermediates) | Full cold path: re-download the PBF and re-extract     |
| `CACHE_VERSION = 10` | `api/src/services/admin-boundaries.ts`         | Derived TopoJSON under `derived/v10/…`                                                 | Mapshaper re-run over already-extracted data (seconds) |

Bump the **extraction** version when anything upstream of the extracted relations changes (`api/src/services/geofabrik/**`, including the OSM entity handling). Bump the **derived** version when the conversion, simplification, or centring changes (`topojson.utils.ts`, `geometry.utils.ts`, cache paths, response shaping that alters stored bytes). Dependency bumps matter too: `mapshaper` affects the derived output, `osmix`/`pbf` the extraction output. If unsure, bump both — the cost is a slower first generation, never wrong data.

Because the keys are versioned in source, the `Warm` step picks up a bump automatically; that is the only time warming does real work instead of three cache reads.

### Boundary Prewarm (MW, ZM, ZW)

Only a small subset of countries is actually used, so only those are warmed — everything else generates on demand and then caches. Adding a country to this list is a two-file change; see [Adding a Country](#adding-a-country).

Warming is the final `Warm` step of the Cloud Build pipeline (`cloudbuild.yaml`), which runs immediately after the new revision is deployed. `gcloud run services update` only returns once the revision is serving, so the step is a true post-rollout hook — no polling, no deploy-ordering race. It simply requests `GET /boundaries/{MW,ZM,ZW}`: the service generates and caches them with the identity it already runs as, so **no extra credentials or repository variables are needed**, and the exact code path end users hit is exercised.

The step costs three cache reads on a normal deploy and only does real work after a cache-version bump. It warns instead of failing the build, because by that point the revision is already serving — a failed warm rolls nothing back, and the country simply generates on the first user request.

To fill gaps without a redeploy (e.g. after GCS 90-day lifecycle expiry):

```bash
for cc in MW ZM ZW; do
  curl -fsS "https://geo-data-api.picsa.app/boundaries/$cc" -o /dev/null && echo "$cc warmed"
done
```

If a country's cold generation exceeds the Cloud Run request timeout (300s by default), the warm step logs a warning but the country stays cold — raise the service timeout (`--timeout=900`) or warm it manually with the loop above.

## Features

- Fetches OSM boundary data from Geofabrik PBF extracts for `admin_level`s 2 through 8.
- Converts GeoJSON natively into TopoJSON.
- Uses Mapshaper (`-clean`, `-simplify`, `-filter-islands`) to aggressively reduce file size and complexity.
- Validates requests via Zod.
- Interactive React frontend with live MapLibre Liberty vector preview, boundary overlay, and TopoJSON download.

## Administrative Levels (OSM)

This service extracts boundary data from OpenStreetMap (OSM) using the `admin_level` tag. In OSM, the `admin_level` values (1-11) have different meanings depending on the specific country's geopolitical structure.

As a general guideline:

- **`admin_level=2`**: National borders (Country level).
- **`admin_level=3`**: First-level subnational divisions (e.g., states, provinces, regions — used in some countries).
- **`admin_level=4`**: First-level subnational divisions (e.g., states, provinces, regions — most common level for this).
- **`admin_level=5`**: Second-level subnational divisions (e.g., counties, districts, departments).

The API does not currently support levels greater than 5, as these are not used within the E-PICSA app.

**Further Reference:**
[OSM Wiki for admin_level](https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries).

## Adding a Country

Every served country comes from one config map: `GEOFABRIK_COUNTRIES` in `api/src/services/geofabrik/url-mapping.ts`. Add an entry:

```ts
GH: { geofabrikPath: 'africa/ghana', pbfSizeMb: 95 },
```

- **`geofabrikPath`** — the extract path from [download.geofabrik.de](https://download.geofabrik.de/), relative to the site root (`africa/ghana`). A country with no entry returns `404 COUNTRY_NOT_SUPPORTED`.
- **`pbfSizeMb`** — approximate upstream size, informational only (ops visibility). Nothing enforces a limit against it.
- **`adminLevels`** — optional override of `DEFAULT_ADMIN_LEVELS` (`[2, 3, 4, 5, 6]`). Set it where a country's OSM tagging doesn't map cleanly onto those levels; Zimbabwe is the existing example (`[2, 4, 6]` — levels 3 and 5 aren't used there). `bun run update:osm-levels` regenerates candidate levels from OSM for review.

A new country works immediately: the first request downloads the extract, generates, and caches it. No deploy-time step is involved.

### Adding a Country to the Prewarm List

Prewarming is reserved for the few countries the app opens on. It costs real generation time on every cache-version bump, so keep the list short — everything else is generated on demand and cached.

Promoting a country to the prewarm list means editing **both**:

1. `PREWARM_COUNTRIES` in `api/src/services/geofabrik/url-mapping.ts` — drives the "instantly available" hint in `404` responses.
2. `_PREWARM_COUNTRIES` in `cloudbuild.yaml` — drives the `Warm` step after each rollout.

Editing only one is silent: nothing fails, the API just advertises a country the warm step never fetches, or warms one it doesn't mention. There is no automated check for the mismatch.

## Cloud Run Deployment (API)

The API is containerized via Docker for deployment to Google Cloud Run.

```bash
# Build the Docker image
docker build -t epicsa-geo-api .

# Run locally
docker run --rm -p 8080:8080 epicsa-geo-api

# Test the health endpoint
curl http://localhost:8080/health
```

### Continuous Deployment

The easiest way to deploy is through the Google Cloud Run Console using **Developer Connect**:

1. Go to **Cloud Run** in the Google Cloud Console.
2. Click **Create Service** → **Continuously deploy from a repository**.
3. Select **Developer Connect** and link your repository.
4. Cloud Run will automatically detect the `Dockerfile` at the repo root.
5. Set environment variables (`CACHE_BUCKET`, etc.) as needed.
6. Cloud Run will automatically build and deploy on every push to your selected branch.

The build itself is defined in [`cloudbuild.yaml`](./cloudbuild.yaml): pull → build → push → `gcloud run services update` → warm. The trigger must be configured to read it — set **Configuration** to _Cloud Build configuration file_ with path `cloudbuild.yaml`, and clear any inline substitutions on the trigger, since trigger substitutions override the file's.

Because `gcloud run services update` blocks until the new revision is serving traffic, anything added after the `Deploy` step is a genuine post-deploy hook and anything before it is a genuine pre-deploy hook. `$COMMIT_SHA` is available throughout, so steps can target the exact image that was built.

The API is currently deployed at `https://geo-data-api.picsa.app`.

## GitHub Pages Deployment (Frontend)

The frontend is deployed automatically to GitHub Pages via the `.github/workflows/deploy-frontend.yml` workflow.

**How it works:**

1. On push to `main` (when `web/` files change), the workflow builds the Vite app.
2. `VITE_API_URL` is set to the Cloud Run URL at build time, so API calls go directly to Cloud Run.
3. The built SPA is deployed to GitHub Pages.

**Custom Domain Setup:**

1. In your GitHub repo, go to **Settings → Pages**.
2. Under **Custom domain**, enter your subdomain (e.g., `geo-data.picsa.app`).
3. Add a `CNAME` DNS record pointing your subdomain to `e-picsa.github.io`.
4. Enable **Enforce HTTPS**.

## API Usage

### 1. Healthcheck

**Endpoint:** `GET /` or `GET /health`

**Response:** HTTP 200 OK

```json
{ "status": "ok" }
```

### 2. Generate Boundaries

**Endpoint:** `POST /`

**Request Body:**

```json
{
  "country_code": "MW",
  "admin_level": 2
}
```

**Response:** HTTP 200 OK

```json
{
  "country_code": "MW",
  "admin_level": 2,
  "source": "generated",
  "size_kb": 128,
  "feature_count": 1,
  "bbox": [32.668, -17.129, 35.92, -9.364],
  "topojson": { ... }
}
```

### 3. Clear Cache

> [!NOTE]
> This endpoint is disabled when `NODE_ENV=production` — set that variable on deployed services.

**Endpoint:** `POST /admin/clear-cache`

Clears the boundary-data cache **and** all rendered tile caches (per-country exports + preview tiles).

**Response:** HTTP 200 OK

```json
{ "status": "success", "message": "Cache cleared", "cleared": ["boundary-cache", "tile-renders"] }
```

### 4. Export Map Tiles Archive

**Endpoint:** `POST /export-tiles`
**Request Body:**

```json
{
  "country_code": "MW",
  "bbox": [32.668, -17.129, 35.92, -9.364],
  "minZoom": 0,
  "maxZoom": 8
}
```

**Response:** HTTP 200 OK
Returns a binary blob stream `Content-Type: application/gzip` representing a `.tar.gz` archive of WebP tiles.

Tiles are rendered server-side in the **OpenFreeMap Liberty** style (the same style `picsa-apps` uses for online vector maps, so there is no cartographic discontinuity at the offline/online handoff). Rendering uses MapLibre Native against OpenFreeMap's public vector tiles — no tile-server infrastructure or per-country `.mbtiles` builds required.

The web UI offers a max-zoom dropdown (z6–z12, default z8) with a rough tile/size/time estimate before download. Large jobs shard rendering across up to 4 worker sidecars (~200MB each — set `RENDER_WORKERS=1` on memory-constrained instances).

The archive contains `{z}/{x}/{y}.webp` tiles plus a `manifest.json` at the root (`style`, `styleUrl`, planet `dataDate`, `tileCount`, `rendered` — tiles freshly rendered by this export, 0 when fully served from cache — plus per-tile `sha256`) so app and tiles cannot silently drift out of sync.

> [!IMPORTANT]
> The `maxZoom` parameter is restricted to a maximum value of 12. Tile counts quadruple per zoom (Malawi: 44 tiles at z0–8, ~4,800 at z0–12) — large exports take minutes and are best run against a local dev API rather than Cloud Run.

> [!NOTE]
> Tile rendering shells out to Node.js (`api/src/services/render-liberty-tiles.mjs`) because `@maplibre/maplibre-gl-native` cannot load under the Bun runtime. Local dev therefore requires Node.js 20+ on `PATH` (plus `xvfb` on Linux — macOS needs no wrapper). The production Docker image already includes both.

### 5. Export Vector Tiles (PMTiles)

**Endpoint:** `POST /export-pmtiles`

```json
{
  "country_code": "GLOBAL",
  "maxZoom": 4,
  "layers": "full"
}
```

**Response:** HTTP 200 OK
Returns a binary blob stream `Content-Type: application/octet-stream` representing a single-file `.pmtiles` archive of Mapbox Vector Tiles (plus `X-PMTiles-Sha256` / `X-PMTiles-Bytes` headers).

Instead of rendering rasters, the server repackages the upstream OpenFreeMap planet PBFs (the exact tiles the WebP renderer consumes) — geometry is byte-identical to the raster map, styled client-side for crisp rendering. Upstream tiles are disk-cached by planet `dataDate`, staged into MBTiles via `bun:sqlite`, then converted with the `go-pmtiles` CLI into a clustered archive (which dedups identical tiles, common for ocean/low-zoom).

Two-tier design (separate layer per file, small border-tile duplication accepted — no multi-country packs, no tile buffer):

- **Global base** (`country_code: "GLOBAL"`, the default): whole-world cover from z0, `maxZoom` capped at 6 (default 4). Used as the bundled `world-base` source (z0–6) in the app.
- **Country detail** (`country_code: "MW"` + `bbox`): cover from the posted bbox starting at z7, `maxZoom` 7–12 (default 8, matching the raster pack default). Downloaded on demand as the `country-detail` source (z7+).

`layers: "full"` (default) passes tiles through untouched; `"minimal"` strips `building`/`housenumber`/`poi`/`aeroway`/`aerodrome_label` — per the upstream TileJSON these only exist at z8+, so `minimal` is identical to `full` for global packs and only shrinks country z10–12 tiles.

> [!NOTE]
> Local dev needs the `go-pmtiles` binary: run `sh scripts/setup-pmtiles.sh` (or set `PMTILES_BIN`). The production Docker image downloads it at build time.

### 6. Preview Tiles (Liberty raster)

**Endpoint:** `GET /tiles/liberty/{z}/{x}/{y}.webp` (zooms 0–12)

Renders a single Liberty tile on demand (disk-cached, so repeat views are instant, with ETag revalidation). Useful for QA-ing `/export-tiles` output tile-by-tile. The web debug UI itself renders the live Liberty vector style via MapLibre GL (same style the packs bake), with a boundary overlay and live zoom readout. A Vector/Raster toggle on the map swaps the base between the live vector style and these server-rendered WebP tiles, so you can compare exactly what each export contains.

### 7. Prewarm Tiles (optimistic cache fill)

**Endpoint:** `POST /prewarm-tiles` (zooms 0–8, capped by design)

```json
{
  "country_code": "MW",
  "bbox": [32.668, -17.129, 35.92, -9.364]
}
```

Renders tiles into the same per-country cache dir the export reads, without building an archive. The web UI fires this automatically when a country is selected, so a later export only renders the delta:

```json
{ "status": "ok", "country_code": "MW", "tileCount": 44, "rendered": 12, "cached": 32, "failed": 0 }
```

To answer the obvious question: yes, packs are incremental — a z12 export never re-renders from scratch unless the cache was cleared or the renderer version bumped.
