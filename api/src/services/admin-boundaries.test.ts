import { expect, test, beforeEach } from 'bun:test';
import { adminBoundaries, getCountryAdminLevels } from './admin-boundaries.ts';
import { getCache } from '../utils/cache/index.ts';
import { rawPbfPath } from './geofabrik/raw-pbf.ts';

beforeEach(async () => {
  // Clear derived cache between tests to ensure deterministic results, preserving raw PBF cache
  const cache = getCache();
  if (cache.clearPrefix) {
    await cache.clearPrefix('geofabrik/v6/extracted/');
    await cache.clearPrefix('geofabrik/v6/intermediates/');
    await cache.clearPrefix('derived/');
  }
});

test('getCountryAdminLevels - returns custom levels for ZW and default for others', () => {
  expect(getCountryAdminLevels('ZW')).toEqual([2, 4, 6]);
  expect(getCountryAdminLevels('zw')).toEqual([2, 4, 6]);
  expect(getCountryAdminLevels('ZM')).toEqual([2, 3, 4, 5, 6]);
  expect(getCountryAdminLevels('MW')).toEqual([2, 3, 4, 5, 6]);
  expect(getCountryAdminLevels('FR')).toEqual([2, 3, 4, 5, 6]);
});

test('adminBoundaries - Fails validation with invalid country code', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'INVALID' }),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);
});

test('adminBoundaries - Successfully generates TopoJSON with admin centers for MW', async () => {
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
  expect(data.source).toBe('generated');
  expect(data.topojson).toBeDefined();

  const topojson = JSON.parse(data.topojson);
  expect(topojson.type).toBe('Topology');
  expect(typeof data.size_kb).toBe('number');

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
    // MW districts in OSM lack admin_centre node relations, so fallback to point_on_surface / centroid
    expect(['point_on_surface', 'centroid', 'admin_centre', 'label']).toContain(
      district.properties.center_source,
    );
  }
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

  // Derived cache paths use derived/v6/...
  const cache = getCache();
  const derived = await cache.get('derived/v6/country=MW/topojson.json');
  expect(derived).not.toBeNull();

  // Second request - should hit cache
  const res2 = await adminBoundaries(req);
  expect(res2.status).toBe(200);
  const data2 = (await res2.json()) as any;
  expect(data2.source).toBe('cache');
  expect(data2.country_code).toBe('MW');
}, 120000);

test('adminBoundaries - Successfully generates TopoJSON with admin centers for ZW (admin_6)', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZW' }),
    signal: AbortSignal.timeout(180000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('ZW');
  expect(data.topojson).toBeDefined();

  const topo = JSON.parse(data.topojson);
  expect(topo.type).toBe('Topology');
  const objectKey = Object.keys(topo.objects)[0];
  const geometries = topo.objects[objectKey].geometries;

  // Evaluate ZW admin_6 (districts)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 6);
  expect(districts.length).toBeGreaterThanOrEqual(50);

  // Districts known to have admin_centre node relations in Zimbabwe OSM
  const harare = districts.find((d: any) => d.properties?.name === 'Harare');
  expect(harare).toBeDefined();
  expect(harare.properties.center_source).toBe('admin_centre');
  // Harare coordinates: lon ~ 31.04569, lat ~ -17.83177
  expect(harare.properties.center[0]).toBeCloseTo(31.04569, 1);
  expect(harare.properties.center[1]).toBeCloseTo(-17.83177, 1);

  const bulawayo = districts.find((d: any) => d.properties?.name === 'Bulawayo');
  expect(bulawayo).toBeDefined();
  expect(bulawayo.properties.center_source).toBe('admin_centre');
  expect(bulawayo.properties.center[0]).toBeCloseTo(28.58871, 1);
  expect(bulawayo.properties.center[1]).toBeCloseTo(-20.15606, 1);

  const mazowe = districts.find((d: any) => d.properties?.name === 'Mazowe');
  expect(mazowe).toBeDefined();
  expect(mazowe.properties.center_source).toBe('admin_centre');

  // Verify districts without explicit OSM admin_centre fall back to point_on_surface / centroid
  const otherDistricts = districts.filter(
    (d: any) => !['Harare', 'Bulawayo', 'Mazowe'].includes(d.properties?.name),
  );
  for (const d of otherDistricts) {
    expect(d.properties.center).toBeDefined();
    expect(d.properties.center.length).toBe(2);
    expect(['point_on_surface', 'centroid']).toContain(d.properties.center_source);
  }
}, 180000);

test('adminBoundaries - Successfully generates TopoJSON with admin centers for ZM (admin_5)', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'ZM' }),
    signal: AbortSignal.timeout(180000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('ZM');
  expect(data.topojson).toBeDefined();

  const topo = JSON.parse(data.topojson);
  expect(topo.type).toBe('Topology');
  const objectKey = Object.keys(topo.objects)[0];
  const geometries = topo.objects[objectKey].geometries;

  // Evaluate ZM admin_5 (districts)
  const districts = geometries.filter((g: any) => Number(g.properties?.admin_level) === 5);
  expect(districts.length).toBeGreaterThanOrEqual(100);

  // Districts known to have admin_centre node relations in Zambia OSM
  const choma = districts.find((d: any) => d.properties?.name?.includes('Choma'));
  expect(choma).toBeDefined();
  expect(choma.properties.center_source).toBe('admin_centre');
  // Choma coordinates: lon ~ 26.97786, lat ~ -16.81419
  expect(choma.properties.center[0]).toBeCloseTo(26.97786, 2);
  expect(choma.properties.center[1]).toBeCloseTo(-16.81419, 2);

  const lusaka = districts.find((d: any) => d.properties?.name?.includes('Lusaka'));
  expect(lusaka).toBeDefined();
  expect(lusaka.properties.center_source).toBe('admin_centre');
  expect(lusaka.properties.center[0]).toBeCloseTo(28.28184, 2);
  expect(lusaka.properties.center[1]).toBeCloseTo(-15.41634, 2);

  const livingstone = districts.find((d: any) => d.properties?.name?.includes('Livingstone'));
  expect(livingstone).toBeDefined();
  expect(livingstone.properties.center_source).toBe('admin_centre');

  const chipata = districts.find((d: any) => d.properties?.name?.includes('Chipata'));
  expect(chipata).toBeDefined();
  expect(chipata.properties.center_source).toBe('admin_centre');

  // Verify majority of Zambian districts have admin_centre (97 out of 118)
  const adminCentreCount = districts.filter(
    (d: any) => d.properties?.center_source === 'admin_centre',
  ).length;
  console.log(`Zambia admin_5 admin_centre count: ${adminCentreCount} / ${districts.length}`);
  expect(adminCentreCount).toBeGreaterThanOrEqual(90);

  // Remaining districts should have valid point_on_surface or centroid fallback
  for (const d of districts) {
    expect(d.properties.center).toBeDefined();
    expect(d.properties.center.length).toBe(2);
    expect(['admin_centre', 'label', 'point_on_surface', 'centroid']).toContain(
      d.properties.center_source,
    );
  }
}, 180000);
