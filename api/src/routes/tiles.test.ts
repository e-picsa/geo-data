import { expect, test } from 'bun:test';
import {
  parsePreviewTilePath,
  parseLocalTilePath,
  parseRangeHeader,
  isSafePmtilesFile,
  resolveLocalPacks,
  ExportTilesSchema,
  ExportPmtilesSchema,
  PrewarmTilesSchema,
  PrewarmPmtilesSchema,
} from './tiles.ts';
import { handleAdminRoutes } from './admin.ts';

test('parseLocalTilePath accepts vector tile paths and rejects junk', () => {
  expect(parseLocalTilePath('/tiles/local/8/152/137.pbf')).toEqual({
    tile: { x: 152, y: 137, z: 8 },
  });
  expect(parseLocalTilePath('/tiles/local/0/0/0.pbf')).toEqual({ tile: { x: 0, y: 0, z: 0 } });
  expect('error' in parseLocalTilePath('/tiles/local/13/1/1.pbf')).toBe(true);
  expect('error' in parseLocalTilePath('/tiles/local/2/4/0.pbf')).toBe(true);
  expect('error' in parseLocalTilePath('/tiles/liberty/8/152/137.webp')).toBe(true);
});

test('resolveLocalPacks prefers newest mobile pack per scope', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'localpacks-'));
  const tiles = nodePath.join(tmp, 'tiles');
  try {
    const writeManifest = async (file: string, m: Record<string, unknown>) => {
      await fs.writeFile(nodePath.join(tmp, file), JSON.stringify(m));
      await fs.mkdir(nodePath.join(tiles, file.replace(/\.manifest\.json$/, '')), {
        recursive: true,
      });
    };
    await writeManifest('GLOBAL_z0-3_minimal_old_v4_abc.manifest.json', {
      file: 'GLOBAL_z0-3_minimal_old_v4_abc.pmtiles',
      scope: 'global',
      country_code: 'GLOBAL',
      layers: 'minimal',
      minZoom: 0,
      maxZoom: 3,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    await writeManifest('GLOBAL_z0-3_mobile_new_v4_abc.manifest.json', {
      file: 'GLOBAL_z0-3_mobile_new_v4_abc.pmtiles',
      scope: 'global',
      country_code: 'GLOBAL',
      layers: 'mobile',
      minZoom: 0,
      maxZoom: 3,
      regions: [{ bbox: [21.5, -23.0, 36.5, -8.0], minZoom: 4, maxZoom: 6 }],
      generatedAt: '2026-02-01T00:00:00.000Z',
    });
    await writeManifest('MW_z7-11_mobile_new_v4_abc.manifest.json', {
      file: 'MW_z7-11_mobile_new_v4_abc.pmtiles',
      scope: 'country',
      country_code: 'MW',
      layers: 'mobile',
      minZoom: 7,
      maxZoom: 11,
      generatedAt: '2026-02-01T00:00:00.000Z',
    });
    // Pack entry without an unpacked dir must not resolve.
    await fs.writeFile(
      nodePath.join(tmp, 'ZM_z7-9_mobile_orphan_v4_abc.manifest.json'),
      JSON.stringify({
        file: 'ZM_z7-9_mobile_orphan_v4_abc.pmtiles',
        scope: 'country',
        country_code: 'ZM',
        layers: 'mobile',
        minZoom: 7,
        maxZoom: 9,
        generatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    const resolved = await resolveLocalPacks(tmp, tiles);
    expect(resolved.global?.base).toBe('GLOBAL_z0-3_mobile_new_v4_abc');
    // Composite regions extend the served range: world maxZoom is 3 but the
    // SA top-up owns z4–6.
    expect(resolved.global?.maxZoom).toBe(6);
    expect(resolved.countries['MW']?.base).toBe('MW_z7-11_mobile_new_v4_abc');
    expect(resolved.countries['ZM']).toBeUndefined();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('parseRangeHeader handles byte ranges, suffixes and rejects junk', () => {
  expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
  expect(parseRangeHeader('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
  expect(parseRangeHeader('bytes=0-0', 1000)).toEqual({ start: 0, end: 0 });
  expect(parseRangeHeader(null, 1000)).toBeNull();
  expect(parseRangeHeader('bytes=-', 1000)).toBeNull();
  expect(parseRangeHeader('items=0-99', 1000)).toBeNull();
  expect(parseRangeHeader('bytes=99-0', 1000)).toBeNull();
  expect(parseRangeHeader('bytes=1000-', 1000)).toBeNull(); // unsatisfiable
  expect(parseRangeHeader('bytes=0-2000', 1000)).toBeNull(); // past EOF
});

test('isSafePmtilesFile blocks traversal and non-pack files', () => {
  expect(isSafePmtilesFile('MW_z7-11_mobile_abc123_v4_20261115_080022_pt.pmtiles')).toBe(true);
  expect(isSafePmtilesFile('GLOBAL_z0-3_mobile_abc123_v4_20261115_080022_pt.manifest.json')).toBe(
    true,
  );
  expect(isSafePmtilesFile('../admin-boundaries.ts')).toBe(false);
  expect(isSafePmtilesFile('/etc/passwd')).toBe(false);
  expect(isSafePmtilesFile('pack.mbtiles')).toBe(false);
  expect(isSafePmtilesFile('pack.PMTILES')).toBe(false);
});

test('prewarm schema defaults to empty packs and validates posted packs', () => {
  const empty = PrewarmPmtilesSchema.safeParse({});
  expect(empty.success).toBe(true);
  const bbox = [32.6, -17.2, 36.0, -9.3] as const;
  expect(
    PrewarmPmtilesSchema.safeParse({
      packs: [{ country_code: 'MW', bbox, minZoom: 7, maxZoom: 11, layers: 'mobile' }],
    }).success,
  ).toBe(true);
  expect(
    PrewarmPmtilesSchema.safeParse({
      packs: [{ country_code: 'MW', maxZoom: 11 }],
    }).success,
  ).toBe(false);
  expect(PrewarmPmtilesSchema.safeParse({ packs: [] }).success).toBe(true);
});
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

test('pmtiles schema requires bbox for countries and zooms 4–12', () => {
  const bbox = [32.6, -17.2, 36.0, -9.3] as const;
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW' }).success).toBe(false);
  expect(ExportPmtilesSchema.safeParse({ country_code: 'mw', bbox }).success).toBe(true);
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 3 }).success).toBe(
    false,
  );
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 4 }).success).toBe(
    true,
  );
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 12 }).success).toBe(
    true,
  );
  expect(ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 13 }).success).toBe(
    false,
  );
});

test('pmtiles schema supports mobile layers and country minZoom', () => {
  const bbox = [32.6, -17.2, 36.0, -9.3] as const;
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 11, layers: 'mobile' })
      .success,
  ).toBe(true);
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, minZoom: 7, maxZoom: 11 }).success,
  ).toBe(true);
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, minZoom: 8, maxZoom: 7 }).success,
  ).toBe(false);
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, minZoom: 3, maxZoom: 11 }).success,
  ).toBe(false);
});

test('pmtiles schema supports GLOBAL regions but rejects them for countries', () => {
  const regions = [{ bbox: [21.5, -23.0, 36.5, -8.0] as const, minZoom: 4, maxZoom: 6 }];
  expect(ExportPmtilesSchema.safeParse({ maxZoom: 3, regions }).success).toBe(true);
  expect(
    ExportPmtilesSchema.safeParse({
      maxZoom: 3,
      regions: [{ bbox: [0, 0, 1, 1], minZoom: 5, maxZoom: 4 }],
    }).success,
  ).toBe(false);
  const bbox = [32.6, -17.2, 36.0, -9.3] as const;
  expect(
    ExportPmtilesSchema.safeParse({ country_code: 'MW', bbox, maxZoom: 8, regions }).success,
  ).toBe(false);
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
