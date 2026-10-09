import { expect, test } from 'bun:test';
import { countTilesForBbox, estimateExport, formatBytes, formatDuration } from './tiles.ts';

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
