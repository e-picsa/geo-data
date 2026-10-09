import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, LIBERTY_TILES_DIR, RENDER_VERSION } from './map-tiles.ts';
import { splitIntoChunks, workerCount } from './map-tiles.ts';

test('tile cache dir is versioned so renderer fixes invalidate stale tiles', () => {
  expect(path.basename(LIBERTY_TILES_DIR)).toBe(`liberty-v${RENDER_VERSION}`);
});

test('splitIntoChunks distributes tiles round-robin without loss', () => {
  const tiles = [1, 2, 3, 4, 5, 6, 7];
  const shards = splitIntoChunks(tiles, 3);
  expect(shards).toHaveLength(3);
  expect(shards.flat().sort((a, b) => a - b)).toEqual(tiles);
  expect(shards.map((s) => s.length)).toEqual([3, 2, 2]);

  // More workers than tiles → no empty shards
  expect(splitIntoChunks([1, 2], 4)).toHaveLength(2);
});

test('workerCount tiers by job size with env override', () => {
  const prev = process.env.RENDER_WORKERS;
  delete process.env.RENDER_WORKERS;
  try {
    expect(workerCount(44)).toBe(1);
    expect(workerCount(500)).toBe(2);
    expect(workerCount(4758)).toBe(4);
    process.env.RENDER_WORKERS = '1';
    expect(workerCount(4758)).toBe(1);
  } finally {
    if (prev === undefined) delete process.env.RENDER_WORKERS;
    else process.env.RENDER_WORKERS = prev;
  }
});

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
    const meta = {
      country_code: 'MW',
      minZoom: 0,
      maxZoom: 8,
      dataDate: '20261004_113936_pt',
      rendered: 2,
    };
    const first = await buildManifest(dir, meta);
    const second = await buildManifest(dir, meta);

    expect(first.style).toBe('liberty');
    expect(first.tileCount).toBe(2);
    expect(first.rendered).toBe(2);
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
    const meta = {
      country_code: 'MW',
      minZoom: 0,
      maxZoom: 8,
      dataDate: '20261004_113936_pt',
      rendered: 0,
    };
    const before = await buildManifest(dir, meta);
    await fs.writeFile(path.join(dir, '8', '152', '137.webp'), 'tile-a-modified');
    const after = await buildManifest(dir, meta);
    expect(after.sha256).not.toBe(before.sha256);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
