import { expect, test } from 'bun:test';
import {
  lon2tile,
  lat2tile,
  tile2lon,
  tile2lat,
  tileCenterLon,
  tileCenterLat,
  getBufferedBboxForZoom,
  getTilesForBbox,
} from './tiles';

test('lon2tile calculates correct X tile', () => {
  // Test prime meridian at zoom 0
  expect(lon2tile(0, 0)).toBe(0);

  // Test prime meridian at zoom 1
  expect(lon2tile(0, 1)).toBe(1);

  // Test longitude 180 at zoom 1
  expect(lon2tile(180, 1)).toBe(2);
});

test('lat2tile calculates correct Y tile', () => {
  // Equator at zoom 0
  expect(lat2tile(0, 0)).toBe(0);

  // Equator at zoom 1
  expect(lat2tile(0, 1)).toBe(1);

  // High northern latitude at zoom 1 (top half)
  expect(lat2tile(80, 1)).toBe(0);
});

test('getTilesForBbox generates array of relevant tiles', () => {
  // Bounding box for a small area
  const minLon = 10;
  const minLat = 50;
  const maxLon = 11;
  const maxLat = 51;
  const zoom = 5;

  const tiles = getTilesForBbox(minLon, minLat, maxLon, maxLat, zoom);

  // With zoom 5, the entire world is a 32x32 grid
  // The small bbox should only span a few tiles
  expect(tiles.length).toBeGreaterThan(0);

  // Every tile should have the requested zoom
  for (const tile of tiles) {
    expect(tile.z).toBe(zoom);
  }
});

test('tile buffer expands the tile cover per zoom', () => {
  const base = getTilesForBbox(10, 50, 11, 51, 5);
  const buffered = getTilesForBbox(10, 50, 11, 51, 5, 1);
  expect(buffered.length).toBeGreaterThan(base.length);
  expect(getTilesForBbox(10, 50, 11, 51, 5, 0)).toEqual(base);
  // Buffer clamps at the grid edge instead of overflowing
  const z0 = getTilesForBbox(-180, -85, 180, 85, 0, 2);
  expect(z0).toHaveLength(1);
});

test('getBufferedBboxForZoom matches the buffered tile cover exactly', () => {
  const bbox: [number, number, number, number] = [10, 50, 11, 51];
  const z = 5;
  const snapped = getBufferedBboxForZoom(bbox, 1, z);
  // Snapped box contains the input bbox…
  expect(snapped[0]).toBeLessThanOrEqual(10);
  expect(snapped[1]).toBeLessThanOrEqual(50);
  expect(snapped[2]).toBeGreaterThanOrEqual(11);
  expect(snapped[3]).toBeGreaterThanOrEqual(51);
  // …and aligns with tile edges covering it
  const tiles = getTilesForBbox(bbox[0], bbox[1], bbox[2], bbox[3], z, 1);
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  expect(snapped[0]).toBeCloseTo(tile2lon(Math.min(...xs), z), 10);
  expect(snapped[2]).toBeCloseTo(tile2lon(Math.max(...xs) + 1, z), 10);
  expect(snapped[3]).toBeCloseTo(tile2lat(Math.min(...ys), z), 10);
  expect(snapped[1]).toBeCloseTo(tile2lat(Math.max(...ys) + 1, z), 10);
  // No buffer → still snaps outward to tile edges
  const plain = getBufferedBboxForZoom(bbox, 0, z);
  expect(plain[0]).toBeLessThanOrEqual(10);
  expect(plain[2]).toBeGreaterThanOrEqual(11);
});

test('tileCenterLon/Lat return the mercator center of a tile', () => {
  // z0 world tile is centered on 0,0 (mercator)
  expect(tileCenterLon(0, 0)).toBeCloseTo(0, 10);
  expect(tileCenterLat(0, 0)).toBeCloseTo(0, 10);

  // Center lies within the tile bounds
  const [x, y, z] = [152, 137, 8];
  const lon = tileCenterLon(x, z);
  const lat = tileCenterLat(y, z);
  expect(lon).toBeGreaterThan(tile2lon(x, z));
  expect(lon).toBeLessThan(tile2lon(x + 1, z));
  // latitude decreases as y increases
  expect(lat).toBeLessThan(tile2lat(y, z));
  expect(lat).toBeGreaterThan(tile2lat(y + 1, z));

  // Known value: z8 tile x152 center
  expect(lon).toBeCloseTo(34.453125, 10);
});
