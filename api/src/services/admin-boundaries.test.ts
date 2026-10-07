import process from 'node:process';
if (!process.env) {
  process.env = {};
}
process.env.ENABLE_INTERMEDIATES_CACHE = 'false';
import { test, expect, beforeAll } from 'bun:test';
import { adminBoundaries } from './admin-boundaries.ts';
import { getCache } from '../utils/cache/index.ts';
import { getCountryAdminLevels, DEFAULT_ADMIN_LEVELS } from './geofabrik/url-mapping.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const GEOFABRIK_CACHE_VERSION = 5;
const DERIVED_CACHE_VERSION = 4;

async function clearJsonCache() {
  const cache = getCache();
  if (cache.clearPrefix) {
    await cache.clearPrefix(`geofabrik/v${GEOFABRIK_CACHE_VERSION}/extracted/`);
    await cache.clearPrefix(`geofabrik/v${GEOFABRIK_CACHE_VERSION}/intermediates/`);
    await cache.clearPrefix('derived/');
  }
}

beforeAll(async () => {
  await clearJsonCache();
});

test('getCountryAdminLevels - returns custom levels for ZW and default for others', () => {
  expect(getCountryAdminLevels('ZW')).toEqual([2, 4, 6]);
  expect(getCountryAdminLevels('MW')).toEqual(DEFAULT_ADMIN_LEVELS);
  expect(DEFAULT_ADMIN_LEVELS).toContain(6);
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

test('adminBoundaries - Successfully generates TopoJSON for MW', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW' }),
    signal: AbortSignal.timeout(60000),
  });

  const res = await adminBoundaries(req);

  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  console.log('Returned payload keys:', Object.keys(data));

  expect(data.topojson).toBeDefined();
  expect(data.country_code).toBe('MW');

  const topojson = JSON.parse(data.topojson);
  expect(topojson.type).toBe('Topology');

  expect(typeof data.size_kb).toBe('number');
}, 60000);

test('adminBoundaries - Caches raw PBF and derived JSON after successful request', async () => {
  const cache = getCache();
  const cacheDir = (cache as any).getBaseDir?.();

  await clearJsonCache();

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

  if (cacheDir) {
    const pbfPath = path.join(cacheDir, `geofabrik/v${GEOFABRIK_CACHE_VERSION}/raw/MW.pbf`);
    const pbfExists = await fs
      .access(pbfPath)
      .then(() => true)
      .catch(() => false);
    console.log('Raw PBF cache exists:', pbfExists);
    expect(pbfExists).toBe(true);

    await new Promise((r) => setTimeout(r, 500));

    const derivedPath = path.join(
      cacheDir,
      'derived',
      `v${DERIVED_CACHE_VERSION}`,
      'country=MW',
      'topojson.json',
    );
    const derivedExists = await fs
      .access(derivedPath)
      .then(() => true)
      .catch(() => false);
    console.log('Derived JSON cache exists:', derivedExists);
    expect(derivedExists).toBe(true);
  }
}, 120000);

test('adminBoundaries - Successfully generates TopoJSON with admin_6 for ZW', async () => {
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
  const adminLevels = new Set(geometries.map((g: any) => Number(g.properties?.admin_level)));

  console.log('Extracted admin levels for Zimbabwe:', Array.from(adminLevels));
  expect(adminLevels.has(2)).toBe(true);
  expect(adminLevels.has(4)).toBe(true);
  expect(adminLevels.has(6)).toBe(true);
}, 180000);
