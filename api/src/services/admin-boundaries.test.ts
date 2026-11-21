import { expect, test, beforeEach, afterAll } from 'bun:test';
import {
  adminBoundaries,
  filterCrossBorderFeatures,
  filterTopojsonGeometries,
} from './admin-boundaries.ts';
import { getCache } from '../utils/cache/index.ts';
import { rawPbfPath } from './geofabrik/raw-pbf.ts';

// Clear derived cache before and after this test file to prevent state leakage
beforeEach(async () => {
  // Clear derived cache between tests to ensure deterministic results, preserving raw PBF cache
  const cache = getCache();
  if (cache.clearPrefix) {
    await cache.clearPrefix('geofabrik/v6/extracted/');
    await cache.clearPrefix('geofabrik/v6/intermediates/');
    await cache.clearPrefix('derived/');
  }
});

afterAll(async () => {
  // Clean up derived cache after all tests complete
  const cache = getCache();
  if (cache.clearPrefix) {
    await cache.clearPrefix('geofabrik/v6/extracted/');
    await cache.clearPrefix('geofabrik/v6/intermediates/');
    await cache.clearPrefix('derived/');
  }
});

test('adminBoundaries - Validates Malawi boundaries, district centers, and custom EPA layers', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW' }),
    signal: AbortSignal.timeout(120000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('MW');
  expect(data.feature_count).toBeGreaterThan(0);
  expect(data.size_kb).toBeGreaterThan(0);
  expect(data.topojson).toBeDefined();

  // Verify custom_layers metadata envelope
  expect(data.custom_layers).toBeDefined();
  expect(Array.isArray(data.custom_layers)).toBe(true);
  const epaLayerInfo = data.custom_layers.find((l: any) => l.id === 'mw_epa');
  expect(epaLayerInfo).toBeDefined();
  expect(epaLayerInfo.citation.sourceName).toContain('MASDAP');
  const planningUnitsInfo = data.custom_layers.find((l: any) => l.id === 'mw_planning_units');
  expect(planningUnitsInfo).toBeDefined();

  const topojson = JSON.parse(data.topojson);
  expect(topojson.type).toBe('Topology');
  expect(topojson.objects).toBeDefined();
  // Layer metadata lives once at the topology level (deduped, not per-feature)
  expect(topojson.custom_layers).toBeDefined();
  expect(topojson.custom_layers.find((l: any) => l.id === 'mw_epa')?.citation.sourceName).toContain(
    'MASDAP',
  );
  // Metadata serializes before the geometry so it doesn't get buried
  expect(data.topojson.indexOf('"custom_layers"')).toBeLessThan(data.topojson.indexOf('"objects"'));

  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

  // Cross-border regression: Mozambican districts (e.g. Angónia) must not leak in
  const allNames = geometries.map((g: any) => g.properties?.name);
  expect(allNames).not.toContain('Angónia');

  // Evaluate MW admin_4 (districts)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 4);
  expect(districts.length).toBeGreaterThanOrEqual(28);

  for (const district of districts) {
    expect(district.properties.center).toBeDefined();
    expect(Array.isArray(district.properties.center)).toBe(true);
    expect(district.properties.center.length).toBe(2);
    expect(typeof district.properties.center[0]).toBe('number');
    expect(typeof district.properties.center[1]).toBe('number');
    // MW districts in OSM lack admin_centre node relations, so fallback to centroid / point_on_surface
    expect(['centroid', 'point_on_surface', 'admin_centre', 'label']).toContain(
      district.properties.center_source,
    );
  }

  // Evaluate MW custom layers (EPAs + wall-to-wall planning units)
  const epas = geometries.filter((g: any) => g.properties?.custom_layer === 'mw_epa');
  expect(epas.length).toBe(186);

  const planningUnits = geometries.filter(
    (g: any) => g.properties?.custom_layer === 'mw_planning_units',
  );
  expect(planningUnits.length).toBe(318);
  expect(new Set(planningUnits.map((g: any) => g.properties?.unit_type))).toEqual(
    new Set(['epa', 'forest_reserve', 'national_park', 'other']),
  );

  const kameme = epas.find((e: any) => e.properties?.name === 'Kameme EPA');
  expect(kameme).toBeDefined();
  expect(kameme.properties.center).toBeDefined();
  expect(Array.isArray(kameme.properties.center)).toBe(true);
  expect(kameme.properties.district).toBe('Chitipa');
  // Duplicated per-feature metadata was removed: layer info now lives once in
  // custom_layers (envelope) / custom_layers (topology member)
  expect(kameme.properties.citation).toBeUndefined();
  expect(kameme.properties.layer_name).toBeUndefined();
  expect(kameme.properties.unit_type).toBeUndefined();

  // Dowa center should be near the geometric centroid [33.79, -13.59]
  const dowa = districts.find((d: any) => d.properties?.name === 'Dowa');
  expect(dowa).toBeDefined();
  expect(dowa.properties.center[0]).toBeGreaterThan(33.7);
  expect(dowa.properties.center[0]).toBeLessThan(33.9);
  expect(dowa.properties.center[1]).toBeLessThan(-13.5);
  expect(dowa.properties.center[1]).toBeGreaterThan(-13.7);

  // Mzimba center should be near the geometric centroid [33.64, -11.77]
  const mzimba = districts.find((d: any) => d.properties?.name === 'Mzimba');
  expect(mzimba).toBeDefined();
  expect(mzimba.properties.center[1]).toBeLessThan(-11.6);
  expect(mzimba.properties.center[1]).toBeGreaterThan(-12.0);

  // Chitipa is concave, so its geometric centroid falls outside the district in Karonga.
  // It must fall back to point_on_surface inside Chitipa bounds.
  const chitipa = districts.find((d: any) => d.properties?.name === 'Chitipa');
  expect(chitipa).toBeDefined();
  expect(chitipa.properties.center_source).toBe('point_on_surface');
  expect(chitipa.properties.center[0]).toBeGreaterThan(33.4);
  expect(chitipa.properties.center[0]).toBeLessThan(33.6);
  expect(chitipa.properties.center[1]).toBeGreaterThan(-9.9);
  expect(chitipa.properties.center[1]).toBeLessThan(-9.7);
}, 120000);

test('adminBoundaries - Caches raw PBF and derived JSON after successful request', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW' }),
    signal: AbortSignal.timeout(120000),
  });

  // First request - should generate and populate cache
  const res1 = await adminBoundaries(req);
  expect(res1.status).toBe(200);
  const data1 = (await res1.json()) as any;
  expect(data1.source).toBe('generated');

  // Verify raw PBF exists on disk
  const pbfPath = rawPbfPath('MW', 6);
  expect(await Bun.file(pbfPath).exists()).toBe(true);

  // Second request - should hit cache
  const req2 = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW' }),
    signal: AbortSignal.timeout(10000),
  });

  const res2 = await adminBoundaries(req2);
  expect(res2.status).toBe(200);
  const data2 = (await res2.json()) as any;
  expect(data2.source).toBe('cache');
  expect(data2.topojson).toBe(data1.topojson);
}, 120000);

test('adminBoundaries - Invalid country code returns 400', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'INVALID' }),
    signal: AbortSignal.timeout(5000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);

  const data = (await res.json()) as any;
  expect(data.error).toBeDefined();
  expect(data.error).toContain('country_code');
});

test('adminBoundaries - Unsupported country code returns 404 with a non-retryable code', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZZ' }),
    signal: AbortSignal.timeout(5000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(404);

  const data = (await res.json()) as any;
  expect(data.error).toBeDefined();
  expect(data.code).toBe('COUNTRY_NOT_SUPPORTED');
  expect(data.retryable).toBe(false);
});

test('adminBoundaries - Missing country_code parameter returns 400', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(5000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);

  const data = (await res.json()) as any;
  expect(data.error).toBeDefined();
  expect(data.error).toContain('country_code');
});

test('adminBoundaries - Zimbabwe boundaries include districts and provinces with admin_centre', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZW' }),
    signal: AbortSignal.timeout(120000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('ZW');
  expect(data.feature_count).toBeGreaterThan(0);
  expect(data.topojson).toBeDefined();

  const topojson = JSON.parse(data.topojson);
  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

  // Provinces (admin_level 4)
  const provinces = geometries.filter((g: any) => Number(g.properties?.admin_level) === 4);
  expect(provinces.length).toBeGreaterThanOrEqual(10);

  // Districts (admin_level 6)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 6);
  expect(districts.length).toBeGreaterThanOrEqual(50);

  // Validate admin_centre centers on districts
  const harare = districts.find(
    (d: any) => d.properties?.name === 'Harare' || d.properties?.name === 'Harare Urban',
  );
  expect(harare).toBeDefined();
  expect(harare.properties.center).toBeDefined();
  expect(harare.properties.center_source).toBe('admin_centre');
  // Harare center coordinates should be near [-17.82, 31.05]
  expect(harare.properties.center[0]).toBeGreaterThan(31.0);
  expect(harare.properties.center[0]).toBeLessThan(31.1);
  expect(harare.properties.center[1]).toBeLessThan(-17.7);
  expect(harare.properties.center[1]).toBeGreaterThan(-17.9);

  // Bulawayo
  const bulawayo = districts.find(
    (d: any) => d.properties?.name === 'Bulawayo' || d.properties?.name === 'Bulawayo Urban',
  );
  expect(bulawayo).toBeDefined();
  expect(bulawayo.properties.center).toBeDefined();
  expect(bulawayo.properties.center_source).toBe('admin_centre');
  expect(bulawayo.properties.center[0]).toBeGreaterThan(28.5);
  expect(bulawayo.properties.center[0]).toBeLessThan(28.7);
  expect(bulawayo.properties.center[1]).toBeLessThan(-20.1);
  expect(bulawayo.properties.center[1]).toBeGreaterThan(-20.25);
}, 120000);

test('adminBoundaries - Zambia boundaries evaluate admin_centre vs fallbacks', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZM' }),
    signal: AbortSignal.timeout(120000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('ZM');
  expect(data.feature_count).toBeGreaterThan(0);
  expect(data.topojson).toBeDefined();

  const topojson = JSON.parse(data.topojson);
  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

  // Provinces (admin_level 4)
  const provinces = geometries.filter((g: any) => Number(g.properties?.admin_level) === 4);
  expect(provinces.length).toBeGreaterThanOrEqual(9);

  // Districts (admin_level 5)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 5);
  expect(districts.length).toBeGreaterThanOrEqual(100);

  for (const district of districts) {
    expect(district.properties.center).toBeDefined();
    expect(Array.isArray(district.properties.center)).toBe(true);
    expect(district.properties.center.length).toBe(2);
    expect(['admin_centre', 'label', 'centroid', 'point_on_surface']).toContain(
      district.properties.center_source,
    );
  }

  // Lusaka district uses admin_centre
  const lusaka = districts.find((d: any) => d.properties?.name === 'Lusaka District');
  expect(lusaka).toBeDefined();
  expect(lusaka.properties.center_source).toBe('admin_centre');
  expect(lusaka.properties.center[0]).toBeGreaterThan(28.2);
  expect(lusaka.properties.center[0]).toBeLessThan(28.4);
  expect(lusaka.properties.center[1]).toBeLessThan(-15.3);
  expect(lusaka.properties.center[1]).toBeGreaterThan(-15.5);
}, 120000);

// Synthetic unit tests for the cross-border filter (no network needed).
// Country square [0,0]-[10,10]; neighbour district fully outside it.
const square = (x1: number, y1: number, x2: number, y2: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
      [x1, y1],
    ],
  ],
});

function fakeCollection() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2, 'ISO3166-1': 'TL' },
        geometry: square(0, 0, 10, 10),
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Central District', admin_level: 4 },
        geometry: square(1, 1, 4, 4),
      },
      {
        type: 'Feature',
        // Neighbour relation without ISO tags (the Angónia case)
        properties: { id: '3', name: 'Angónia', admin_level: 5 },
        geometry: square(20, 20, 25, 25),
      },
      {
        type: 'Feature',
        properties: { id: 'e1', name: 'Border EPA', custom_layer: 'tl_epa', district: 'Central' },
        geometry: square(5, 5, 6, 6),
      },
      {
        type: 'Feature',
        properties: { id: 'e2', name: 'Foreign EPA', custom_layer: 'tl_epa', district: 'East' },
        geometry: square(30, 30, 31, 31),
      },
    ],
  };
}

test('filterCrossBorderFeatures - drops foreign features, keeps country + insiders', () => {
  const out = filterCrossBorderFeatures(fakeCollection(), 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Testland');
  expect(names).toContain('Central District');
  expect(names).toContain('Border EPA');
  expect(names).not.toContain('Angónia');
  expect(names).not.toContain('Foreign EPA');
});

test('filterCrossBorderFeatures - drops foreign level-2 via ISO tag, fails open without level-2', () => {
  const fc: any = fakeCollection();
  fc.features.push({
    type: 'Feature',
    properties: { id: '9', name: 'Neighbourland', admin_level: 2, 'ISO3166-1': 'NB' },
    geometry: square(20, 20, 30, 30),
  });
  const out = filterCrossBorderFeatures(fc, 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Testland');
  expect(names).not.toContain('Neighbourland');

  const noCountry: any = { type: 'FeatureCollection', features: [fc.features[2]] };
  expect(filterCrossBorderFeatures(noCountry, 'TL').features.length).toBe(1);
});

test('filterCrossBorderFeatures - prefers admin_centre over geometric centroid', () => {
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: square(0, 0, 10, 10),
      },
      {
        // Geometry is outside, but its admin centre is inside (shared-border sliver)
        type: 'Feature',
        properties: { id: '2', name: 'Border Sliver', admin_level: 4, admin_centre: [5, 5] },
        geometry: square(20, 20, 25, 25),
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  expect(out.features.map((f: any) => f.properties.name)).toContain('Border Sliver');
});

test('filterCrossBorderFeatures - concave feature kept via inland vertices', () => {
  // L-shaped polygon: area centroid falls in the missing quadrant (outside
  // its own ring), but its vertices are on land.
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: square(0, 0, 10, 10),
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Concave EPA', custom_layer: 'tl_epa' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [1, 1],
              [7, 1],
              [7, 3],
              [3, 3],
              [3, 7],
              [1, 7],
              [1, 1],
            ],
          ],
        },
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  expect(out.features.map((f: any) => f.properties.name)).toContain('Concave EPA');
});

test('filterCrossBorderFeatures - neighbour sharing a border is dropped (Angónia case)', () => {
  // Shares the x=10 edge with the country: shared vertices sit at distance 0
  // and must not count as inside; interior vertices are across the border.
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: square(0, 0, 10, 10),
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Angónia', admin_level: 5 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 0],
              [15, 0],
              [15, 5],
              [10, 5],
              [10, 0],
            ],
          ],
        },
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Testland');
  expect(names).not.toContain('Angónia');
});

test('filterCrossBorderFeatures - untagged neighbour level-2 never joins the union', () => {
  // Enclave fully surrounded by the country (Lesotho-in-South-Africa shape):
  // the neighbour polygon is complete but untagged, so it must neither join
  // the union nor ship in the export. The country polygon models the enclave
  // as a hole, so the enclave's districts fail containment too.
  const countryRing: number[][] = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
    [0, 0],
  ];
  const enclaveRing: number[][] = [
    [5, 5],
    [9, 5],
    [9, 9],
    [5, 9],
    [5, 5],
  ];
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2, 'ISO3166-1': 'TL' },
        geometry: { type: 'Polygon', coordinates: [countryRing, enclaveRing] },
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Enclave', admin_level: 2 },
        geometry: square(5, 5, 9, 9),
      },
      {
        type: 'Feature',
        properties: { id: '3', name: 'Enclave District', admin_level: 4 },
        geometry: square(6, 6, 8, 8),
      },
      {
        type: 'Feature',
        properties: { id: '4', name: 'Own District', admin_level: 4 },
        geometry: square(12, 12, 14, 14),
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Testland');
  expect(names).toContain('Own District');
  expect(names).not.toContain('Enclave');
  expect(names).not.toContain('Enclave District');
});

test('filterCrossBorderFeatures - falls back to largest untagged level-2', () => {
  // Own country polygon simply lacks ISO tags: the single untagged level-2
  // is trusted so filtering still works.
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: square(0, 0, 10, 10),
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Central District', admin_level: 4 },
        geometry: square(1, 1, 4, 4),
      },
      {
        type: 'Feature',
        properties: { id: '3', name: 'Angónia', admin_level: 5 },
        geometry: square(20, 20, 25, 25),
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Testland');
  expect(names).toContain('Central District');
  expect(names).not.toContain('Angónia');
});

test('filterCrossBorderFeatures - island district kept via per-part centroids (Likoma case)', () => {
  // Country covers two land masses with open water between; the district's
  // combined centroid lands in the water, but each island part is on land.
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [4, 0],
                [4, 4],
                [0, 4],
                [0, 0],
              ],
            ],
            [
              [
                [6, 6],
                [10, 6],
                [10, 10],
                [6, 10],
                [6, 6],
              ],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { id: '2', name: 'Island District', admin_level: 4 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [1, 1],
                [2, 1],
                [2, 2],
                [1, 2],
                [1, 1],
              ],
            ],
            [
              [
                [7, 7],
                [8, 7],
                [8, 8],
                [7, 8],
                [7, 7],
              ],
            ],
          ],
        },
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  expect(out.features.map((f: any) => f.properties.name)).toContain('Island District');
});

test('filterCrossBorderFeatures - ISO3166-2 tag keeps exclaves, holed part contributes nothing', () => {
  const fc: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '1', name: 'Testland', admin_level: 2 },
        geometry: square(0, 0, 10, 10),
      },
      {
        // Affirmatively tagged ours despite lying fully outside (data quirk) — keep
        type: 'Feature',
        properties: { id: '2', name: 'Tagged Exclave', admin_level: 4, 'ISO3166-2': 'TL-EX' },
        geometry: square(20, 20, 25, 25),
      },
      {
        // Big part's centroid falls in its own hole; small part is on land — keep
        type: 'Feature',
        properties: { id: '3', name: 'Holed EPA', custom_layer: 'tl_epa' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
              [
                [4, 4],
                [6, 4],
                [6, 6],
                [4, 6],
                [4, 4],
              ],
            ],
            [
              [
                [1, 1],
                [2, 1],
                [2, 2],
                [1, 2],
                [1, 1],
              ],
            ],
          ],
        },
      },
    ],
  };
  const out = filterCrossBorderFeatures(fc, 'TL');
  const names = out.features.map((f: any) => f.properties.name);
  expect(names).toContain('Tagged Exclave');
  expect(names).toContain('Holed EPA');
});

test('filterTopojsonGeometries - keeps requested level and everything above it', () => {
  const topo: any = {
    type: 'Topology',
    objects: {
      input: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', properties: { name: 'Testland', admin_level: 2 }, arcs: [] },
          { type: 'MultiPolygon', properties: { name: 'Region', admin_level: 3 }, arcs: [] },
          { type: 'MultiPolygon', properties: { name: 'District', admin_level: 4 }, arcs: [] },
          { type: 'MultiPolygon', properties: { name: 'Ward', admin_level: 6 }, arcs: [] },
          {
            type: 'MultiPolygon',
            properties: { name: 'EPA', custom_layer: 'tl_epa', district: 'Central' },
            arcs: [],
          },
        ],
      },
    },
    arcs: [],
  };

  // admin_level=4 keeps 2, 3 and 4 (levels below the selection are dropped)
  const filtered = filterTopojsonGeometries(topo, { adminLevels: [4], customLayers: ['tl_epa'] });
  const names = (filtered.objects as any).input.geometries.map((g: any) => g.properties.name);
  expect(names.sort()).toEqual(['District', 'EPA', 'Region', 'Testland']);

  // No filters → all admin kept, custom layers excluded (opt-in)
  const full = filterTopojsonGeometries(topo, {});
  expect((full.objects as any).input.geometries.map((g: any) => g.properties.name).sort()).toEqual([
    'District',
    'Region',
    'Testland',
    'Ward',
  ]);

  // Unknown custom layer id matches nothing for custom features
  const adminOnly = filterTopojsonGeometries(topo, { adminLevels: [4], customLayers: ['other'] });
  expect((adminOnly.objects as any).input.geometries.map((g: any) => g.properties.name)).toEqual([
    'Testland',
    'Region',
    'District',
  ]);
});

test('filterTopojsonGeometries - custom layers are opt-in, admin levels opt-out', () => {
  const topo: any = {
    type: 'Topology',
    custom_layers: [
      { id: 'tl_epa', name: 'EPAs' },
      { id: 'tl_other', name: 'Other' },
    ],
    objects: {
      input: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', properties: { name: 'Testland', admin_level: 2 }, arcs: [] },
          { type: 'MultiPolygon', properties: { name: 'District', admin_level: 4 }, arcs: [] },
          {
            type: 'MultiPolygon',
            properties: { name: 'EPA', custom_layer: 'tl_epa' },
            arcs: [],
          },
          {
            type: 'MultiPolygon',
            properties: { name: 'Other', custom_layer: 'tl_other' },
            arcs: [],
          },
        ],
      },
    },
    arcs: [],
  };

  // Default (no params): all admin, no custom, metadata removed
  const def = filterTopojsonGeometries(topo, {}) as any;
  expect(def.objects.input.geometries.map((g: any) => g.properties.name).sort()).toEqual([
    'District',
    'Testland',
  ]);
  expect(def.custom_layers).toBeUndefined();

  // admin_level alone narrows admin but still excludes custom
  const adminOnly = filterTopojsonGeometries(topo, { adminLevels: [2] }) as any;
  expect(adminOnly.objects.input.geometries.map((g: any) => g.properties.name)).toEqual([
    'Testland',
  ]);
  expect(adminOnly.custom_layers).toBeUndefined();

  // custom_layer alone keeps all admin plus the requested custom layer
  const withCustom = filterTopojsonGeometries(topo, { customLayers: ['tl_epa'] }) as any;
  expect(withCustom.objects.input.geometries.map((g: any) => g.properties.name).sort()).toEqual([
    'District',
    'EPA',
    'Testland',
  ]);
  expect(withCustom.custom_layers.map((l: any) => l.id)).toEqual(['tl_epa']);
});
