# Refactor: Replace Overpass API with Geofabrik Data Pipeline

Replace the current synchronous Overpass API approach with a two-phase architecture:

1. **Processing pipeline** — downloads a country's `.osm.pbf` from Geofabrik, extracts admin boundaries (levels 2-5), converts to TopoJSON, and stores results in GCS.
2. **Retrieval endpoint** — serves pre-computed TopoJSON from GCS.

This eliminates Overpass rate-limits, timeouts, and per-request latency for end users.

## User Review Required

> [!IMPORTANT]
> This is a significant architectural shift. The processing pipeline is long-running (minutes per country for large PBFs) and should be invoked asynchronously (e.g. via Cloud Run Job, cron trigger, or a protected admin endpoint). It is **not** suitable for user-facing request/response latency.

> [!WARNING]
> Processing PBF files requires native CLI tools (`osmium`, `ogr2ogr`) which must be installed in the Docker image. This increases image size compared to the current pure-Deno setup.

### Decisions for you

1. **Processing trigger** — Should the processing pipeline be:
   - (a) An admin-only `POST /process` endpoint on the same Cloud Run service? _(simplest)_
   - (b) A separate Cloud Run Job triggered by Cloud Scheduler / manual dispatch? _(cleaner separation)_
   - (c) Something else?
2. **Storage layout** — Currently using a single GCS bucket (`OVERPASS_CACHE_BUCKET`). Rename to something like `GEO_BOUNDARIES_BUCKET`? Or keep the existing var?
3. **PBF retention** — Should downloaded PBF files be kept in GCS (for re-processing without re-downloading), or discarded after processing?
4. **Scope** — Generate all levels 2-5 in one processing run per country, or keep it one-level-at-a-time?

---

## Current Architecture

```
User POST / → Validate → GCS cache check → Overpass API → osmtogeojson → Mapshaper → TopoJSON response
```

Single request/response. Overpass is the bottleneck (rate-limits, timeouts, slow for large countries).

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Processing Pipeline (admin/batch)                      │
│  POST /process { country_code }                         │
│                                                         │
│  1. Resolve country → Geofabrik PBF URL (index-v1.json) │
│  2. Download .osm.pbf to temp                           │
│  3. osmium tags-filter → boundary=administrative only   │
│  4. ogr2ogr (or osmium export) → GeoJSON                │
│  5. For each admin_level 2-5:                           │
│     a. Filter features by admin_level tag               │
│     b. Mapshaper (clean, simplify, clip for lvl 5)      │
│     c. Store TopoJSON → GCS                             │
│  6. Cleanup temp files                                  │
└─────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Retrieval Endpoint (user-facing, fast)      │
│  GET /boundaries/:country_code/:admin_level  │
│                                              │
│  1. Read pre-computed TopoJSON from GCS      │
│  2. Return with metadata (size, bbox, etc.)  │
└──────────────────────────────────────────────┘
```

---

## Proposed Changes

### Geofabrik URL Resolver

#### [NEW] [geofabrik-index.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/geofabrik-index.ts)

- Fetches and caches `https://download.geofabrik.de/index-v1.json` (a ~200 KB GeoJSON FeatureCollection).
- Provides `getGeofabrikPbfUrl(countryCode: string): string` that looks up the `iso3166-1:alpha2` field and returns the `.osm.pbf` download URL.
- Cache the index in memory (refreshed on service start / once per day).

---

### Processing Pipeline

#### [NEW] [process-country.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/process-country.ts)

Core processing logic, separated from HTTP concerns:

1. **Download PBF** — Stream the `.osm.pbf` from Geofabrik into a temp file (`Deno.makeTempFile`). Optionally cache in GCS for re-use.
2. **Filter boundaries** — Shell out to `osmium tags-filter <input.pbf> r/boundary=administrative -o boundaries.pbf` to strip everything except admin boundary relations. This dramatically shrinks the data.
3. **Convert to GeoJSON** — Shell out to `osmium export boundaries.pbf -o boundaries.geojson` (or use `ogr2ogr`). This produces a GeoJSON FeatureCollection with all boundary features.
4. **Split by admin_level** — In-memory: group features by their `admin_level` tag (2, 3, 4, 5).
5. **Mapshaper per level** — Re-use existing Mapshaper logic (`clean`, `simplify`, `filter-islands`, `clip` for level 5 using level 2 as mask). Produce TopoJSON.
6. **Store to GCS** — Write each level's TopoJSON to `boundaries/v1/country={CC}/admin_level={N}/topojson.json`.
7. **Cleanup** — Remove temp PBF/GeoJSON files.

#### [NEW] [process-handler.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/process-handler.ts)

HTTP handler for the processing endpoint:

- Validates request (`{ country_code: string }`).
- Calls `processCountry()`.
- Returns a summary of what was generated (levels processed, sizes, feature counts).
- Should be behind auth or an API key for production.

---

### Retrieval Endpoint

#### [NEW] [retrieve-handler.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/retrieve-handler.ts)

- `GET /boundaries/:country_code/:admin_level`
- Reads the pre-computed TopoJSON from GCS.
- Returns the same response shape as today (`country_code`, `admin_level`, `source`, `size_kb`, `feature_count`, `bbox`, `topojson`), with `source: "geofabrik"`.
- Returns `404` if the country/level hasn't been processed yet.

---

### Router & Main

#### [MODIFY] [main.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/main.ts)

- Add routes:
  - `POST /process` → `processHandler` (admin pipeline)
  - `GET /boundaries/:country_code/:admin_level` → `retrieveHandler`
- Keep existing `POST /` endpoint for backwards compatibility (or deprecate).
- Keep health check as-is.

---

### Schema Updates

#### [MODIFY] [schema.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/schema.ts)

- Add `PROCESS_REQUEST_SCHEMA` (just `country_code`, no `admin_level` since pipeline does all levels).
- Add `RETRIEVE_REQUEST_SCHEMA` (parsed from URL params).

---

### Docker / Dependencies

#### [MODIFY] [Dockerfile](file:///c:/apps/picsa/geo-boundaries-topojson/Dockerfile)

- Switch to a base image with `osmium-tool` available, or add `apk add osmium-tool` (available in Alpine repos).
- Add `--allow-run` permission to the Deno CMD to allow shelling out to `osmium`.
- Add `--allow-write` for temp file creation.

---

### Cleanup / Deprecation

#### [DELETE] [overpass-mapping.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/overpass-mapping.ts)

No longer needed — Overpass queries are replaced by Geofabrik download + osmium filtering.

#### [MODIFY] [admin-boundaries.ts](file:///c:/apps/picsa/geo-boundaries-topojson/src/admin-boundaries.ts)

Either remove entirely or keep as a legacy fallback. The Mapshaper processing logic should be extracted into a shared utility for re-use by the new pipeline.

#### [MODIFY] [import_map.json](file:///c:/apps/picsa/geo-boundaries-topojson/import_map.json)

- Remove `osmtogeojson` (no longer needed — GeoJSON comes from `osmium export`).
- Keep `mapshaper`, `zod`.

---

## GCS Storage Layout

```
boundaries/
  v1/
    country=MW/
      admin_level=2/topojson.json
      admin_level=3/topojson.json
      admin_level=4/topojson.json
      admin_level=5/topojson.json
      metadata.json          ← processing timestamp, source PBF URL, sizes
    country=ZW/
      ...
    pbf/                     ← optional: cache raw PBFs for re-processing
      MW-latest.osm.pbf
```

---

## Verification Plan

### Automated Tests

- Update `admin-boundaries.test.ts` to test the new retrieval endpoint (mock GCS reads).
- Add a new `process-country.test.ts` that tests the processing pipeline with a small PBF fixture.
- Run tests with: `bun test --allow-net --allow-env --allow-read --allow-run --allow-write`

### Manual Verification

1. Build the Docker image and run locally.
2. Call `POST /process` with `{ "country_code": "MW" }` and verify it downloads, processes, and stores TopoJSON to GCS.
3. Call `GET /boundaries/MW/2` and verify it returns the same shape/quality of data as the current `POST /` endpoint.
4. Compare the TopoJSON output (feature count, size, bbox) between old Overpass-based and new Geofabrik-based pipeline for the same country to ensure data parity.
