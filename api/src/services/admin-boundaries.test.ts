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

  // Evaluate MW custom layers (EPAs)
  const epas = geometries.filter((g: any) => g.properties?.custom_layer === 'mw_epa');
  expect(epas.length).toBeGreaterThanOrEqual(180);

  const kameme = epas.find((e: any) => e.properties?.name === 'Kameme EPA');
  expect(kameme).toBeDefined();
  expect(kameme.properties.center).toBeDefined();
  expect(Array.isArray(kameme.properties.center)).toBe(true);
  expect(kameme.properties.district).toBe('Chitipa');
  expect(kameme.properties.citation).toContain('MASDAP');

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
