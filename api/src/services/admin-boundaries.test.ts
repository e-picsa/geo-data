import process from 'node:process';
if (!process.env) {
  process.env = {};
}
process.env.ENABLE_INTERMEDIATES_CACHE = 'false';
import { test, expect, beforeAll } from 'bun:test';
import { adminBoundaries } from './admin-boundaries.ts';
import { getCache } from '../utils/cache.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 4;

async function clearJsonCache() {
  const cache = getCache();
  if (cache.clearPrefix) {
    await cache.clearPrefix(`geofabrik/v${CACHE_VERSION}/extracted/`);
    await cache.clearPrefix(`geofabrik/v${CACHE_VERSION}/intermediates/`);
    await cache.clearPrefix('derived/');
  }
}

beforeAll(async () => {
  await clearJsonCache();
});

test('adminBoundaries - Successfully generates TopoJSON for MW Admin Layer 2', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW', admin_level: 2 }),
    signal: AbortSignal.timeout(60000),
  });

  const res = await adminBoundaries(req);

  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  console.log('Returned payload keys:', Object.keys(data));

  expect(data.topojson).toBeDefined();
  expect(data.country_code).toBe('MW');
  expect(data.admin_level).toBe(2);

  const topojson = data.topojson;
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
    body: JSON.stringify({ country_code: 'MW', admin_level: 2 }),
    signal: AbortSignal.timeout(120000),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(200);

  if (cacheDir) {
    const pbfPath = path.join(cacheDir, `geofabrik/v${CACHE_VERSION}/raw/MW.pbf`);
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
      'v1',
      'country=MW',
      'admin_level=2',
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

test('adminBoundaries - Fails validation with invalid country code', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'INVALID', admin_level: 2 }),
  });

  const res = await adminBoundaries(req);

  expect(res.status).toBe(400);
});

test('adminBoundaries - Fails validation with invalid admin_level', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ country_code: 'MW', admin_level: 10 }),
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);
});
