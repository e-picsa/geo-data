import { expect, test } from 'bun:test';
import {
  countTilesForBbox,
  estimateExport,
  formatBytes,
  formatDuration,
  rewriteOfflineTileUrl,
} from './tiles.ts';

const MALAWI: [number, number, number, number] = [32.668, -17.129, 35.92, -9.364];

test('countTilesForBbox matches known Malawi counts', () => {
  expect(countTilesForBbox(...MALAWI, 0, 8)).toBe(44);
  expect(countTilesForBbox(...MALAWI, 0, 12)).toBe(4758);
  expect(countTilesForBbox(...MALAWI, 9, 12)).toBe(4758 - 44);
});

test('estimateExport scales with zoom and formats sanely', () => {
  const small = estimateExport(MALAWI, 0, 8);
  const large = estimateExport(MALAWI, 0, 12);
  expect(small.tileCount).toBe(44);
  expect(large.tileCount).toBe(4758);
  expect(large.bytes).toBeGreaterThan(small.bytes);
  expect(large.seconds).toBeGreaterThan(small.seconds);

  expect(formatBytes(500)).toBe('500 B');
  expect(formatBytes(40 * 1024)).toBe('40 KB');
  expect(formatBytes(36 * 1024 * 1024)).toBe('36.0 MB');
  expect(formatDuration(30)).toMatch(/s$/);
  expect(formatDuration(480)).toBe('~8 min');
});

test('rewriteOfflineTileUrl maps planet tiles to the local server', () => {
  expect(
    rewriteOfflineTileUrl(
      'https://tiles.openfreemap.org/planet/20261115_080022_pt/8/151/135.pbf',
      '/api',
      'MW',
    ),
  ).toBe('/api/tiles/local/8/151/135.pbf?country=MW');
  // Empty country defaults to GLOBAL; trailing slashes are trimmed.
  expect(
    rewriteOfflineTileUrl(
      'https://tiles.openfreemap.org/planet/20261115_080022_pt/0/0/0.pbf',
      '/api/',
      '',
    ),
  ).toBe('/api/tiles/local/0/0/0.pbf?country=GLOBAL');
  // Absolute API bases pass through untouched.
  expect(
    rewriteOfflineTileUrl(
      'https://tiles.openfreemap.org/planet/20261115_080022_pt/3/4/4.pbf',
      'https://geo-data-api.picsa.app/api',
      'zm',
    ),
  ).toBe('https://geo-data-api.picsa.app/api/tiles/local/3/4/4.pbf?country=ZM');
});

test('rewriteOfflineTileUrl passes through non-tile URLs', () => {
  expect(rewriteOfflineTileUrl('https://tiles.openfreemap.org/planet', '/api', 'MW')).toBeNull();
  expect(
    rewriteOfflineTileUrl(
      'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf',
      '/api',
      'MW',
    ),
  ).toBeNull();
  expect(
    rewriteOfflineTileUrl('https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json', '/api', 'MW'),
  ).toBeNull();
  expect(rewriteOfflineTileUrl('https://example.com/tiles/8/1/2.pbf', '/api', 'MW')).toBeNull();
  expect(rewriteOfflineTileUrl('not a url', '/api', 'MW')).toBeNull();
});
