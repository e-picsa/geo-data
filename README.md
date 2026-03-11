# Admin Boundaries TopoJSON Generator

A Bun monorepo that fetches country administrative boundaries from the Overpass API, optimizes geometries via Mapshaper, and returns lightweight TopoJSON payloads. Includes a React frontend for interactive boundary exploration.

## Architecture

| Component        | Stack                       | Deployment                  |
| ---------------- | --------------------------- | --------------------------- |
| **API** (`api/`) | Bun + TypeScript            | Google Cloud Run via Docker |
| **Web** (`web/`) | React + Vite + Tailwind CSS | GitHub Pages                |

## Environment Variables

| Variable                | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `PORT`                  | The port the API server listens on (default: `8080`)                                 |
| `OVERPASS_CACHE_BUCKET` | GCS bucket name for caching raw Overpass responses. If not set, caching is disabled. |
| `VITE_API_URL`          | (Frontend build-time) The production API URL. Defaults to `/api` for local dev.      |

### Caching Configuration (GCS)

To speed up requests and prevent rate-limiting against the Overpass API, raw OSM responses are cached in Google Cloud Storage before TopoJSON conversion.

**Setup Requirements:**

1. A GCS bucket.
2. Provide the bucket name via the `OVERPASS_CACHE_BUCKET` environment variable.
3. Configure **Object Lifecycle Management** on the bucket to automatically delete objects older than 90 days.
4. The compute identity running this service (e.g., Cloud Run service account) needs `roles/storage.objectAdmin` on the target bucket.

## Features

- Fetches OSM relation boundaries via Overpass API for `admin_level`s 2 through 8.
- Converts fetched GeoJSON natively into TopoJSON.
- Uses Mapshaper (`-clean`, `-simplify`, `-filter-islands`) to aggressively reduce file size and complexity.
- Validates requests via Zod.
- Interactive React frontend with Leaflet map visualization and TopoJSON download.

## Administrative Levels (OSM)

This service extracts boundary data from OpenStreetMap (OSM) using the `admin_level` tag. In OSM, the `admin_level` values (1-11) have different meanings depending on the specific country's geopolitical structure.

As a general guideline:

- **`admin_level=2`**: National borders (Country level).
- **`admin_level=4`**: State / Province / Region level.
- **`admin_level=6`**: County / District level.
- **`admin_level=8`**: Municipality / City / Town level.

**How to verify your exact level:**
Because `admin_level` definitions shift from country to country, the best way to verify what a specific admin level returns is to test queries interactively on **[Overpass Turbo](https://overpass-turbo.eu/)**.

**Further Reference:**
[OSM Wiki for admin_level](https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries).

## Local Development

Prerequisites: [Bun](https://bun.sh/) installed.

```bash
# Install dependencies (both workspaces)
bun install

# Run both API and frontend concurrently
npm run start

# Or run individually
npm run start:api   # API on http://localhost:8080
npm run start:web   # Frontend on http://localhost:5173 (proxies /api → :8080)
```

The Vite dev server proxies `/api` requests to the Bun API at `localhost:8080`, so the frontend works seamlessly in development without CORS issues.

## Cloud Run Deployment (API)

The API is containerized via Docker for deployment to Google Cloud Run.

```bash
# Build the Docker image
docker build -t admin-boundaries-topojson .

# Run locally
docker run -p 8080:8080 admin-boundaries-topojson

# Test the health endpoint
curl http://localhost:8080/health
```

### Continuous Deployment

The easiest way to deploy is through the Google Cloud Run Console using **Developer Connect**:

1. Go to **Cloud Run** in the Google Cloud Console.
2. Click **Create Service** → **Continuously deploy from a repository**.
3. Select **Developer Connect** and link your repository.
4. Cloud Run will automatically detect the `Dockerfile` at the repo root.
5. Set environment variables (`OVERPASS_CACHE_BUCKET`, etc.) as needed.
6. Cloud Run will automatically build and deploy on every push to your selected branch.

The API is currently deployed at `https://geo-boundaries.picsa.app`.

## GitHub Pages Deployment (Frontend)

The frontend is deployed automatically to GitHub Pages via the `.github/workflows/deploy-frontend.yml` workflow.

**How it works:**

1. On push to `main` (when `web/` files change), the workflow builds the Vite app.
2. `VITE_API_URL` is set to the Cloud Run URL at build time, so API calls go directly to Cloud Run.
3. The built SPA is deployed to GitHub Pages.

**Custom Domain Setup:**

1. In your GitHub repo, go to **Settings → Pages**.
2. Under **Custom domain**, enter your subdomain (e.g., `geo.picsa.app`).
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
  "message": "Boundary data retrieved successfully",
  "country_code": "MW",
  "admin_level": 2,
  "size_kb": 128,
  "feature_count": 1,
  "bbox": [ ... ],
  "topojson": { ... }
}
```

### 3. Clear Cache

**Endpoint:** `POST /admin/clear-cache`

**Response:** HTTP 200 OK

```json
{ "status": "success", "message": "Cache cleared" }
```
