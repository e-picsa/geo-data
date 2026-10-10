import { expect, test } from 'bun:test';
import {
  parsePreviewTilePath,
  ExportTilesSchema,
  ExportPmtilesSchema,
  PrewarmTilesSchema,
} from './tiles.ts';
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

test('pmtiles schema defaults to GLOBAL z4 full with no buffer', () => {
  const parsed = ExportPmtilesSchema.safeParse({});
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.country_code).toBe('GLOBAL');
    expect(parsed.data.layers).toBe('full');
    expect(parsed.data.maxZoom).toBeUndefined();
    expect('buffer' in parsed.data).toBe(false);
  }
});

test('pmtiles schema caps global at z6', () => {
  expect(ExportPmtilesSchema.safeParse({ maxZoom: 6 }).success).toBe(true);
  expect(ExportPmtilesSchema.safeParse({ maxZoom: 7 }).success).toBe(false);
});

test('pmtiles schema requires bbox for countries and zooms 7–12', () => {
  const bbox = [32.6, -17.2, 36.0, -9.3] as const;
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW' }).success).toBe(false);
  expect(ExportPmtilesSchema.safeParse({ country_code: 'mw', bbox }).success).toBe(true);
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 6 }).success).toBe(
    false,
  );
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 12 }).success).toBe(
    true,
  );
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 13 }).success).toBe(
    false,
  );
});

test('pmtiles schema rejects invalid country bboxes', () => {
  const ok = [32.6, -17.2, 36.0, -9.3] as const;
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox: ok }).success).toBe(true);
  // swapped min/max
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox: [36.0, -17.2, 32.6, -9.3] }).success,
  ).toBe(false);
  // out of world bounds
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox: [-200, -17.2, 36.0, -9.3] }).success,
  ).toBe(false);
});

test('export/prewarm schemas accept a discrete tile buffer', () => {
  const base = { country_code: 'MW', bbox: [32.6, -17.2, 36.0, -9.3] as const };
  const parsed = ExportTilesSchema.safeParse({ ...base, buffer: 1 });
  expect(parsed.success && parsed.data.buffer).toBe(1);
  expect(ExportTilesSchema.safeParse({ ...base }).success).toBe(true);
  expect(ExportTilesSchema.safeParse({ ...base, buffer: 0.5 }).success).toBe(false);
  expect(ExportTilesSchema.safeParse({ ...base, buffer: -1 }).success).toBe(false);
  expect(ExportTilesSchema.safeParse({ ...base, buffer: 9 }).success).toBe(false);
  expect(PrewarmTilesSchema.safeParse({ ...base, buffer: 2 }).success).toBe(true);
});

test('export schema supports a zoom range for single-level buffer packs', () => {
  const base = { country_code: 'MW', bbox: [32.6, -17.2, 36.0, -9.3] as const };
  expect(ExportTilesSchema.safeParse({ ...base, minZoom: 6, maxZoom: 6 }).success).toBe(true);
  expect(ExportTilesSchema.safeParse({ ...base, minZoom: 2, maxZoom: 6 }).success).toBe(true);
  expect(ExportTilesSchema.safeParse({ ...base, minZoom: 7, maxZoom: 6 }).success).toBe(false);
});

test('prewarm schema defaults to z8 and rejects deeper zooms', () => {
  const base = { country_code: 'MW', bbox: [32.6, -17.2, 36.0, -9.3] as const };
  const parsed = PrewarmTilesSchema.safeParse(base);
  expect(parsed.success && parsed.data.maxZoom).toBe(8);
  expect(PrewarmTilesSchema.safeParse({ ...base, maxZoom: 6 }).success).toBe(true);
  expect(PrewarmTilesSchema.safeParse({ ...base, maxZoom: 9 }).success).toBe(false);
});
