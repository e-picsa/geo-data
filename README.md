# Admin Boundaries TopoJSON Generator

A standalone Deno web service that fetches country administrative boundaries from the Overpass API, optimizes the geometries via Mapshaper, and returns lightweight TopoJSON payloads.

Initially designed as a Supabase Edge Function, this service has been refactored for direct deployment to Google Cloud Run to better handle the heavy memory and processing requirements of processing large country geometries.

## Features

- Fetches OSM relation boundaries via Overpass API for `admin_level`s 2 through 5.
- Converts fetched GeoJSON natively into TopoJSON.
- Uses Mapshaper (`-clean`, `-simplify`, `-filter-islands`) to aggressively reduce file size and complexity.
- Validates requests via Zod.

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

## API Usage

### `POST /climate/admin-boundaries`

**Request Body:**

```json
{
  "country_code": "MW",
  "admin_level": 2
}
```

**Response:**
Returns a JSON object with boundary metadata and a parsed custom TopoJSON property.

```json
{
  "message": "Boundary data retrieved successfully",
  "country_code": "MW",
  "admin_level": 2,
  "size_kb": 128,
  "feature_count": 1,
  "bbox": [...],
  "topojson": {
    "type": "Topology",
    ...
  }
}
```
