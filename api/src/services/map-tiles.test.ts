import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildManifest } from './map-tiles.ts';

async function seedCountryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  await fs.mkdir(path.join(dir, '8', '152'), { recursive: true });
  await fs.mkdir(path.join(dir, '4', '9'), { recursive: true });
  await fs.writeFile(path.join(dir, '8', '152', '137.webp'), 'tile-a');
  await fs.writeFile(path.join(dir, '4', '9', '8.webp'), 'tile-b');
  return dir;
}

test('buildManifest lists tiles and produces a stable content hash', async () => {
  const dir = await seedCountryDir();
  try {
    const meta = { country_code: 'MW', minZoom: 0, maxZoom: 8, dataDate: '20261004_113936_pt' };
    const first = await buildManifest(dir, meta);
    const second = await buildManifest(dir, meta);

    expect(first.style).toBe('liberty');
    expect(first.tileCount).toBe(2);
    expect(first.tiles).toEqual(['4/9/8.webp', '8/152/137.webp']);
    // deterministic across runs
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('buildManifest hash changes when tile content changes', async () => {
  const dir = await seedCountryDir();
  try {
    const meta = { country_code: 'MW', minZoom: 0, maxZoom: 8, dataDate: '20261004_113936_pt' };
    const before = await buildManifest(dir, meta);
    await fs.writeFile(path.join(dir, '8', '152', '137.webp'), 'tile-a-modified');
    const after = await buildManifest(dir, meta);
    expect(after.sha256).not.toBe(before.sha256);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
