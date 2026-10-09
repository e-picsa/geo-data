import { expect, test } from 'bun:test';
import {
  lon2tile,
  lat2tile,
  tile2lon,
  tile2lat,
  tileCenterLon,
  tileCenterLat,
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
