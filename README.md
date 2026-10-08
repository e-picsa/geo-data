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

The Vite dev server proxies `/api` requests to the Bun API at [localhost:8080](http://localhost:8080), so the frontend works seamlessly in development without CORS issues.

Use a rest client like [Insomnia](https://insomnia.rest) to test requests

E.g. POST request for admin_4 boundaries

```shell
curl --request POST --url http://localhost:8080/ --data '{"country_code":"ZM","admin_level":2}'
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
| `PORT`         | The port the API server listens on (default: `8080`)                                            |
| `CACHE_BUCKET` | GCS bucket name for caching PBF extracts and derived TopoJSON. If not set, caching is disabled. |
| `VITE_API_URL` | (Frontend build-time) The production API URL. Defaults to `/api` for local dev.                 |

### Caching Configuration (GCS)

To speed up requests, raw Geofabrik PBF extracts and derived TopoJSON are cached in Google Cloud Storage.

**Setup Requirements:**

1. A GCS bucket.
2. Provide the bucket name via the `CACHE_BUCKET` environment variable.
3. Configure **Object Lifecycle Management** on the bucket to automatically delete objects older than 90 days.
4. The compute identity running this service (e.g., Cloud Run service account) needs `roles/storage.objectAdmin` on the target bucket.

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

### 5. Preview Tiles (Liberty raster)

**Endpoint:** `GET /tiles/liberty/{z}/{x}/{y}.webp` (zooms 0–12)

Renders a single Liberty tile on demand (disk-cached, so repeat views are instant, with ETag revalidation). Useful for QA-ing `/export-tiles` output tile-by-tile. The web debug UI itself renders the live Liberty vector style via MapLibre GL (same style the packs bake), with a boundary overlay and live zoom readout.

### 6. Prewarm Tiles (optimistic cache fill)

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
