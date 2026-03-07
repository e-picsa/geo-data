# Admin Boundaries TopoJSON Generator

A standalone Deno web service that fetches country administrative boundaries from the Overpass API, optimizes the geometries via Mapshaper, and returns lightweight TopoJSON payloads.

Initially designed as a Supabase Edge Function, this service has been refactored for direct deployment to Google Cloud Run to better handle the heavy memory and processing requirements of processing large country geometries.

## Environment Variables

| Variable                | Description                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | The port the server listens on (default: `8080`)                                                                  |
| `OVERPASS_CACHE_BUCKET` | The GCS bucket name to cache raw Overpass API requests (e.g. `my-cache-bucket`). If not set, caching is disabled. |

### Caching Configuration (GCS)

To speed up requests and prevent rate-limiting against the Overpass API, raw OSM responses are cached in Google Cloud Storage before TopoJSON conversion.

**Setup Requirements:**

1. A GCS bucket.
2. Provide the bucket name via the `OVERPASS_CACHE_BUCKET` environment variable.
3. Configure **Object Lifecycle Management** on the bucket to automatically delete objects older than 30 days (or however long you wish to cache the raw OSM data).
4. The compute identity running this service (e.g., Cloud Run service account) needs the `roles/storage.objectAdmin` (or at minimum `storage.objects.create` and `storage.objects.get` permissions) on the target bucket.

## Features

- Fetches OSM relation boundaries via Overpass API for `admin_level`s 2 through 5.
- Converts fetched GeoJSON natively into TopoJSON.
- Uses Mapshaper (`-clean`, `-simplify`, `-filter-islands`) to aggressively reduce file size and complexity.
- Validates requests via Zod.

## Administrative Levels (OSM)

This service extracts boundary data from OpenStreetMap (OSM) using the `admin_level` tag. In OSM, the `admin_level` values (1-11) have different meanings depending on the specific country's geopolitical structure.

As a general guideline:

- **`admin_level=2`**: National borders (Country level).
- **`admin_level=4`**: State / Province / Region level.
- **`admin_level=6`**: County / District level.
- **`admin_level=8`**: Municipality / City / Town level.

**How to verify your exact level:**
Because `admin_level` definitions shift from country to country (e.g., level 4 is a State in the US, but a Region in France), the best way to verify what a specific admin level returns is to test queries interactively on **[Overpass Turbo](https://overpass-turbo.eu/)**.

You can run a query like this in Overpass Turbo to visualize the boundaries for a specific country before calling this API:

```overpass
[out:json];
area["ISO3166-1"="ZW"]->.searchArea;
(
  relation["admin_level"="4"]["boundary"="administrative"]["ISO3166-2"~"^ZW-"](area.searchArea);
);
out body;
>;
out skel qt;
```

**Further Reference:**
For a comprehensive table mapping `admin_level` values to their specific meanings in every country globally, consult the **[OSM Wiki for admin_level](https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries)**.

## Local Development

The project is structured as a standard Deno application using `deno.jsonc` and an `import_map.json`.

```bash
# Run the server locally on port 8080 (default)
deno run --allow-net --allow-env --allow-read src/main.ts

# Specify a custom port
PORT=3000 deno run --allow-net --allow-env --allow-read src/main.ts
```

## Cloud Run Deployment

The service is packaged using Docker for Google Cloud Run:

```bash
# Build the Docker image
docker build -t admin-boundaries-topojson .

# Run the Docker image locally
docker run -p 8080:8080 admin-boundaries-topojson
```

### Continuous Deployment (Recommended)

The easiest way to deploy this to production is directly through the Google Cloud Run Console using **Developer Connect**:

1. Go to the **Cloud Run** page in the Google Cloud Console.
2. Click **Create Service**.
3. Select **Continuously deploy from a repository**.
4. Choose **Developer Connect** (recommended for GitHub, GitLab, and Bitbucket integration).
5. Select your repository and branch.
6. Cloud Run will automatically detect the `Dockerfile` at the root of the project.
7. Set the authentication to **Allow unauthenticated invocations** (if this is a public API) or require authentication as needed.
8. Click **Create**.

Cloud Run will automatically build the image and deploy updates every time you push to your selected branch.

## API Usage

The service provides two main endpoints:

### 1. Healthcheck

Provides a lightweight readiness probe for Cloud Run container monitoring.

**Endpoint:** `GET /` or `GET /health`

**Response:** HTTP 200 OK

```json
{
  "status": "ok"
}
```

---

### 2. Generate Boundaries

Fetches OSM relations, converts them to TopoJSON, and optimizes the file size.

**Endpoint:** `POST /`

**Request Body:**

```json
{
  "country_code": "MW", // ISO 3166-1 alpha-2 code
  "admin_level": 2 // OSM boundary admin_level (usually 2 for country, 4 for state)
}
```

**Response:** HTTP 200 OK
Returns a JSON object with boundary metadata and a parsed custom TopoJSON property.

```json
{
  "message": "Boundary data retrieved successfully",
  "country_code": "MW",
  "admin_level": 2,
  "size_kb": 128,
  "feature_count": 1,
  "bbox": [ ... ],
  "topojson": {
    "type": "Topology",
    "objects": { ... },
    "arcs": [ ... ],
    "transform": { ... }
  }
}
```
