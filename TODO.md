- [ ] Unify topojson across all admin levels to reduce arc duplication

_Implementation Plan_

```md
# Refactor Admin Boundaries TopoJSON Generation

Currently, the backend API generates TopoJSON independently for every `(country_code, admin_level)` pair requested. This is inefficient as many borders (arcs) are shared between different admin levels. The new approach will generate a single unified TopoJSON per country containing all targeted admin levels (2 through 5) so that shared arcs are naturally optimized by Mapshaper. The frontend will fetch this unified file and dynamically filter features by the selected admin level before rendering.

## User Review Required

No breaking user-facing changes, but please confirm the caching paths will change and old cached data will effectively be orphaned (or we can manually clean it). Map tiles will still be exported using the bounding box of the entire country. The downloaded TopoJSON will now contain all admin levels. Please let me know if the TopoJSON download specifically needs to be subsetted per admin level instead of downloading the unified country file.

## Open Questions

None.

## Proposed Changes

### Backend - API Schema

#### [MODIFY] `api/src/types/schema.ts`

- Remove `admin_level` from `BOUNDARY_REQUEST_SCHEMA`.

### Backend - Boundary Service

#### [MODIFY] `api/src/services/admin-boundaries.ts`

- Remove `admin_level` from cache key prefix.
- Update `fetchGeofabrikBoundaries` call to only pass `countryCode`.
- Modify `buildMapshaperInputsAndCommands` to preserve the `admin_level` tag in `this.properties` during Mapshaper optimization:
  `-each 'this.properties = { id: this.properties["@id"] || this.id, name: this.properties.name || "", admin_level: this.properties.admin_level }'`

### Backend - Geofabrik Extractor

#### [MODIFY] `api/src/services/geofabrik/fetch-geofabrik.ts`

- Remove `adminLevel` from `FetchGeofabrikOptions` and `fetchGeofabrikBoundaries` signature.
- Pass no `adminLevel` to `convertToGeoJSON`.

#### [MODIFY] `api/src/services/geofabrik/geojson-converter.ts`

- Remove `adminLevel` filtering parameter.
- Remove the `tags.admin_level === ${adminLevel}` check, so all extracted admin relations (which are already filtered to levels 2, 3, 4, 5 in `pbf-extractor.ts`) are converted to features.

### Frontend

#### [MODIFY] `web/src/App.tsx`

- Remove `admin_level` from the API fetch request body.
- Implement a `useEffect` that updates the `geoJsonData` whenever the raw `data.topojson` or the UI `adminLevel` state changes. This effect will parse the TopoJSON, convert it to GeoJSON, and filter the `geojson.features` to only those where `Number(f.properties.admin_level) === selectedAdminLevel`.
- Update the download TopoJSON logic to clarify that the downloaded file contains all admin levels, e.g., rename the download to `${data.country_code}_all_admin_levels.topo.json`.

## Verification Plan

### Automated Tests

- Run `bun test` in the `api` folder to ensure backend tests (if any for admin boundaries) still pass or update them accordingly to reflect the removed `admin_level` requirement.

### Manual Verification

- In the web UI, select a country and fetch boundaries.
- Observe that it successfully fetches the unified TopoJSON.
- Toggle between Admin Levels 2, 3, 4, 5 and observe the map dynamically updates instantly to reflect the correct boundaries.
- Verify `admin_level` properties are preserved on the drawn features.
- Download the TopoJSON and verify it contains features for all generated levels.
```

- [ ] Fix tests
- [ ] Move pbf file to global cache level, not processor cache level

- [ ] Consider dropping osmix in favour of native osmium (run via docker container)
      Placeholder methods created

- [ ] Provide link from frontend to https://wiki.openstreetmap.org/wiki/Tag:boundary%3Dadministrative

TODO - revisit to see if admin 5 useful at all (some lone features persist, but think mostly shared borders)

```ts
function hasAdminLevel(feature: any, level: number): boolean {
  return Number(feature?.properties?.admin_level) === level;
}

function buildMapshaperInputsAndCommands(geojson: any, adminLevel: number) {
  // ...

  if (adminLevel === 5) {
    const countryFeatures = geojson.features.filter((f: any) => hasAdminLevel(f, 2));
    const targetFeatures = geojson.features.filter((f: any) => hasAdminLevel(f, 5));

    input['input.geojson'] = {
      type: 'FeatureCollection',
      features: targetFeatures,
    };

    input['mask.geojson'] = {
      type: 'FeatureCollection',
      features: countryFeatures,
    };

    commands.push(`-clip mask.geojson`);
    // Filter out slivers along the border.
    // 5km2 is arbitrary but should drop the border overlaps while keeping real districts.
    commands.push(`-filter-islands min-area=5km2`);
  }
}
```
