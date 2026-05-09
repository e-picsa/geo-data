- [ ] Render admin centre nodes on map
- [ ] Wipe server cache
- [ ] Consider dropping osmix in favour of native osmium (run via docker container)
      Placeholder methods created
- [ ] Update readme
- [ ] Fix tests
- [ ] Move pbf file to global cache level, not processor cache level
- [ ] Forward errors from parser

- [ ] Check whether mapshaper still required now using geofabrik
- [ ] Consider 1-pass to extract all admin levels (?)
- [ ] Improve frontend communication (webhook messages/webrtc)
- [ ] Consider dropping Overpass integration entirely
- [ ] Mount GCS volume and refactor to just use local cache system
- [ ] Ensure map tile export works on prod (currently broken due to mkdir)
- [ ] Provide link from frontend to https://wiki.openstreetmap.org/wiki/Tag:boundary%3Dadministrative

TODO - revisit to see if admin 5 clip actually necessary still

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
