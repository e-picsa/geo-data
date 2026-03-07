# Proposal: Replace Overpass API with Geofabrik Data Pipeline

> **Status:** Draft — not yet implemented. Decisions marked 🔲 are pending.

## Motivation

The current architecture queries the Overpass API on every request (with GCS caching). This introduces:

- **Rate-limiting / 429 errors** from the public Overpass endpoint.
- **Timeouts** for large countries (504s on complex queries).
- **Per-request latency** even on cache misses (Overpass can take 30-120s).

Geofabrik provides daily-updated, pre-built country extracts as `.osm.pbf` files. Downloading once and processing locally is faster, more reliable, and eliminates Overpass as a dependency entirely.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Processing Pipeline (admin/batch)                      │
│  POST /process { country_code }                         │
│                                                         │
│  1. Resolve country → Geofabrik PBF URL (index-v1.json) │
│  2. Download .osm.pbf to temp                           │
│  3. osmium tags-filter → boundary=administrative only   │
│  4. osmium export → GeoJSON                             │
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

### Current Architecture (for reference)

```
User POST / → Validate → GCS cache check → Overpass API → osmtogeojson → Mapshaper → TopoJSON response
```

---

## Pending Decisions

🔲 **Processing trigger** — Should the processing pipeline be:

- (a) An admin-only `POST /process` endpoint on the same Cloud Run service? _(simplest)_
- (b) A separate Cloud Run Job triggered by Cloud Scheduler / manual dispatch? _(cleaner separation)_
- (c) Something else?

🔲 **Environment variable naming** — Currently using `OVERPASS_CACHE_BUCKET`. Rename to `GEO_BOUNDARIES_BUCKET` or similar?

🔲 **PBF retention** — Should downloaded PBF files be kept in GCS (enables re-processing without re-downloading), or discarded after processing?

🔲 **Scope per run** — Generate all admin levels 2-5 in one processing run per country, or keep it one-level-at-a-time?

---

## New / Modified Files

### New Files

| File                      | Purpose                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/geofabrik-index.ts`  | Fetches & caches `https://download.geofabrik.de/index-v1.json`. Provides `getGeofabrikPbfUrl(countryCode)` to resolve an ISO alpha-2 code to a `.osm.pbf` download URL. |
| `src/process-country.ts`  | Core processing logic: download PBF → `osmium tags-filter` → `osmium export` → split by admin_level → Mapshaper → store TopoJSON to GCS.                                |
| `src/process-handler.ts`  | HTTP handler for `POST /process`. Validates request, calls `processCountry()`, returns summary.                                                                         |
| `src/retrieve-handler.ts` | HTTP handler for `GET /boundaries/:country_code/:admin_level`. Reads pre-computed TopoJSON from GCS. Returns 404 if not yet processed.                                  |

### Modified Files

| File              | Change                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`     | Add `POST /process` and `GET /boundaries/:country_code/:admin_level` routes. Optionally keep `POST /` for backwards compat. |
| `src/schema.ts`   | Add `PROCESS_REQUEST_SCHEMA` (just `country_code`) and `RETRIEVE_REQUEST_SCHEMA` (from URL params).                         |
| `Dockerfile`      | Add `apk add osmium-tool` (available in Alpine repos). Add `--allow-run` and `--allow-write` Deno permissions.              |
| `import_map.json` | Remove `osmtogeojson` (GeoJSON now comes from `osmium export`). Keep `mapshaper`, `zod`.                                    |

### Removed / Deprecated Files

| File                      | Reason                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `src/overpass-mapping.ts` | No longer needed — Overpass queries replaced by Geofabrik download + osmium filtering.   |
| `src/admin-boundaries.ts` | Either remove or keep as legacy fallback. Extract shared Mapshaper logic into a utility. |

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
      metadata.json              ← processing timestamp, source PBF URL, sizes
    country=ZW/
      ...
    pbf/                         ← optional: cached raw PBFs
      MW-latest.osm.pbf
```

---

## Key Technical Details

### Geofabrik Index Resolution

Geofabrik publishes a machine-readable index at `https://download.geofabrik.de/index-v1.json`. Each entry contains an `iso3166-1:alpha2` field (array of 2-letter ISO codes) and a `urls` object with the `.osm.pbf` download link. The resolver fetches this once (cached in-memory) and matches the requested country code.

### osmium Processing

Two shell commands replace both the Overpass query and `osmtogeojson`:

```bash
# 1. Filter to only boundary=administrative relations (shrinks file dramatically)
osmium tags-filter country.osm.pbf r/boundary=administrative -o boundaries.pbf

# 2. Export to GeoJSON
osmium export boundaries.pbf -o boundaries.geojson
```

### Mapshaper (largely unchanged)

The existing Mapshaper pipeline stays the same:

- `-clean`
- `-simplify weighting=0.5 10%`
- `-filter-islands min-area=10km2`
- `-each` (property extraction)
- `-clip mask.geojson` (for admin_level 5)
- `-o format=topojson quantization=1e3 bbox`

### Docker Impact

Adding `osmium-tool` to the Alpine image increases size by ~20-30 MB. The trade-off is eliminating all Overpass API dependencies and the `osmtogeojson` npm package.

---

## Verification Plan

1. **Data parity** — Process MW (Malawi) with both old Overpass pipeline and new Geofabrik pipeline. Compare feature counts, bbox values, and visual output.
2. **Unit tests** — Update `admin-boundaries.test.ts` for the new retrieval endpoint. Add `process-country.test.ts` with a small PBF fixture.
3. **Docker build** — Ensure `osmium-tool` installs cleanly in the Alpine Deno image and shell-out works with `--allow-run`.
4. **End-to-end** — Deploy to Cloud Run, trigger processing for a test country, then verify retrieval endpoint returns correct data.
