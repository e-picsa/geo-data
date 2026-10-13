import { expect, test, beforeEach, afterAll } from 'bun:test';
import { adminBoundaries } from './admin-boundaries.ts';
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

test('adminBoundaries - Validates Malawi boundaries and district centers', async () => {
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

  const topojson = JSON.parse(data.topojson);
  expect(topojson.type).toBe('Topology');
  expect(topojson.objects).toBeDefined();

  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

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
  const pbfExists = await Bun.file(rawPbfPath('MW', 6)).exists();
  expect(pbfExists).toBe(true);

  await new Promise((r) => setTimeout(r, 200));

  // Derived cache paths use derived/v8/...
  const cache = getCache();
  const derived = await cache.get('derived/v8/country=MW/topojson.json');
  expect(derived).not.toBeNull();

  // Second request - should hit cache
  const req2 = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country_code: 'MW' }),
  });
  const res2 = await adminBoundaries(req2);
  expect(res2.status).toBe(200);
  const data2 = (await res2.json()) as any;
  expect(data2.source).toBe('cache');
  expect(data2.country_code).toBe('MW');
}, 120000);

test('adminBoundaries - Invalid country code returns 400', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'INVALID' }),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);

  const data = (await res.json()) as any;
  expect(data.error).toBeDefined();
});

test('adminBoundaries - Unsupported country code returns 400', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZZ' }),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);

  const data = (await res.json()) as any;
  expect(data.error).toContain('ZZ');
});

test('adminBoundaries - Missing country_code parameter returns 400', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);

  const data = (await res.json()) as any;
  expect(data.error).toBeDefined();
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
  const topojson = JSON.parse(data.topojson);
  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

  // Verify ZW admin_6 (districts)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 6);
  expect(districts.length).toBeGreaterThanOrEqual(50);

  // Verify districts without explicit OSM admin_centre fall back to point_on_surface / centroid
  const fallbackDistricts = districts.filter(
    (d: any) => d.properties.center_source !== 'admin_centre',
  );
  expect(fallbackDistricts.length).toBeGreaterThan(0);
  for (const d of fallbackDistricts) {
    expect(d.properties.center).toBeDefined();
    expect(Array.isArray(d.properties.center)).toBe(true);
    expect(['point_on_surface', 'centroid']).toContain(d.properties.center_source);
  }

  // Verify districts with explicit OSM admin_centre use admin_centre
  const adminCentreDistricts = districts.filter(
    (d: any) => d.properties.center_source === 'admin_centre',
  );
  expect(adminCentreDistricts.length).toBeGreaterThan(0);
  for (const d of adminCentreDistricts) {
    expect(d.properties.center).toBeDefined();
    expect(Array.isArray(d.properties.center)).toBe(true);
  }

  // Beitbridge district should have center near Beitbridge town [-22.21, 30.0]
  const beitbridge = districts.find((d: any) => d.properties?.name === 'Beitbridge');
  expect(beitbridge).toBeDefined();
  expect(beitbridge.properties.center[0]).toBeGreaterThan(29.8);
  expect(beitbridge.properties.center[0]).toBeLessThan(30.2);
  expect(beitbridge.properties.center[1]).toBeLessThan(-22.0);
  expect(beitbridge.properties.center[1]).toBeGreaterThan(-22.4);
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
  const topojson = JSON.parse(data.topojson);
  const objectKey = Object.keys(topojson.objects)[0];
  const geometries = topojson.objects[objectKey].geometries;

  // ZM admin_5 (districts)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 5);
  expect(districts.length).toBeGreaterThanOrEqual(100);

  const lusaka = districts.find((d: any) => d.properties?.name === 'Lusaka');
  expect(lusaka).toBeDefined();
  expect(lusaka.properties.center_source).toBe('admin_centre');
  expect(lusaka.properties.center[0]).toBeGreaterThan(28.2);
  expect(lusaka.properties.center[0]).toBeLessThan(28.4);

  // Remaining districts should have valid point_on_surface or centroid fallback
  for (const d of districts) {
    expect(d.properties.center).toBeDefined();
    expect(Array.isArray(d.properties.center)).toBe(true);
    expect(['admin_centre', 'label', 'point_on_surface', 'centroid']).toContain(
      d.properties.center_source,
    );
  }
}, 120000);
