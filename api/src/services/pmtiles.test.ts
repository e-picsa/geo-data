import { expect, test } from 'bun:test';
import {
  resolvePmtilesCover,
  mbtileRow,
  droppedLayersFor,
  filterTileLayers,
  MINIMAL_DROPPED_LAYERS,
} from './pmtiles.ts';

const MALAWI_BBOX: [number, number, number, number] = [32.6, -17.2, 36.0, -9.3];

test('global cover starts at z0 with no buffer or bbox', () => {
  const { minZoom, maxZoom, tiles } = resolvePmtilesCover({
    country_code: 'GLOBAL',
    maxZoom: 1,
    layers: 'full',
  });
  expect(minZoom).toBe(0);
  expect(maxZoom).toBe(1);
  // z0 (1 tile) + z1 (4 tiles)
  expect(tiles).toHaveLength(5);
});

test('global z0–4 cover is 341 tiles', () => {
  const { tiles } = resolvePmtilesCover({ country_code: 'global', maxZoom: 4, layers: 'full' });
  expect(tiles).toHaveLength(341);
});

test('country cover starts at z7 from the posted bbox', () => {
  const { minZoom, maxZoom, tiles } = resolvePmtilesCover({
    country_code: 'MW',
    bbox: MALAWI_BBOX,
    maxZoom: 7,
    layers: 'full',
  });
  expect(minZoom).toBe(7);
  expect(maxZoom).toBe(7);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => t.z === 7)).toBe(true);
});

test('mbtileRow flips y to TMS orientation', () => {
  expect(mbtileRow(0, 0)).toBe(0);
  expect(mbtileRow(1, 0)).toBe(1);
  expect(mbtileRow(1, 1)).toBe(0);
  expect(mbtileRow(2, 3)).toBe(0);
  expect(mbtileRow(2, 0)).toBe(3);
});

test('minimal preset drops bulk layers but never core layers', () => {
  expect(droppedLayersFor('full')).toEqual([]);
  const dropped = droppedLayersFor('minimal');
  expect(dropped).toEqual(expect.arrayContaining(MINIMAL_DROPPED_LAYERS));
  for (const core of ['boundary', 'place', 'water', 'transportation']) {
    expect(dropped).not.toContain(core);
  }
});

test('filterTileLayers passes bytes through when nothing is dropped', () => {
  const raw = new Uint8Array([1, 2, 3]);
  expect(filterTileLayers(raw, [])).toBe(raw);
});
