import { expect, test } from 'bun:test';
import { parsePreviewTilePath, ExportTilesSchema, PrewarmTilesSchema } from './tiles.ts';
import { handleAdminRoutes } from './admin.ts';

test('parsePreviewTilePath accepts valid liberty tile paths', () => {
  expect(parsePreviewTilePath('/tiles/liberty/8/152/137.webp')).toEqual({
    tile: { x: 152, y: 137, z: 8 },
  });
  expect(parsePreviewTilePath('/tiles/liberty/0/0/0.webp')).toEqual({
    tile: { x: 0, y: 0, z: 0 },
  });
});

test('parsePreviewTilePath rejects out-of-range tiles and zooms', () => {
  const overZoom = parsePreviewTilePath('/tiles/liberty/13/152/137.webp');
  expect('error' in overZoom && overZoom.error).toMatch(/restricted to 12/);

  const outOfRange = parsePreviewTilePath('/tiles/liberty/2/4/0.webp');
  expect('error' in outOfRange && outOfRange.error).toMatch(/out of range/);

  const wrongStyle = parsePreviewTilePath('/tiles/osm/8/152/137.webp');
  expect('error' in wrongStyle && wrongStyle.error).toBe('Not Found');
});

test('admin routes are disabled when NODE_ENV=production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await handleAdminRoutes(
      new Request('http://localhost/admin/clear-cache', { method: 'POST' }),
      '/admin/clear-cache',
    );
    expect(res.status).toBe(404);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test('export schema allows maxZoom up to 12', () => {
  const base = { country_code: 'MW', bbox: [32.6, -17.2, 36.0, -9.3] as const };
  expect(ExportTilesSchema.safeParse({ ...base, maxZoom: 8 }).success).toBe(true);
  expect(ExportTilesSchema.safeParse({ ...base, maxZoom: 12 }).success).toBe(true);
  expect(ExportTilesSchema.safeParse({ ...base, maxZoom: 13 }).success).toBe(false);
});

test('prewarm schema defaults to z8 and rejects deeper zooms', () => {
  const base = { country_code: 'MW', bbox: [32.6, -17.2, 36.0, -9.3] as const };
  const parsed = PrewarmTilesSchema.safeParse(base);
  expect(parsed.success && parsed.data.maxZoom).toBe(8);
  expect(PrewarmTilesSchema.safeParse({ ...base, maxZoom: 6 }).success).toBe(true);
  expect(PrewarmTilesSchema.safeParse({ ...base, maxZoom: 9 }).success).toBe(false);
});
