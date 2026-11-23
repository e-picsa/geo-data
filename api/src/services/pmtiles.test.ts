import { expect, test } from 'bun:test';
import {
  resolvePmtilesCover,
  countPmtilesTiles,
  mbtileRow,
  droppedLayersFor,
  filterTileLayers,
  shouldKeepProperty,
  shouldStripNamesFor,
  shouldApplyMobileFilters,
  shouldKeepMobileProperty,
  shouldKeepMobileFeature,
  shouldKeepFeature,
  maskCoverTiles,
  loadCountryMasks,
  mergeFeatureStats,
  pmtilesWarmCover,
  writeUnpackedTiles,
  MOBILE_DROPPED_LAYERS,
  MINIMAL_DROPPED_LAYERS,
  CoverTooLargeError,
  MAX_PMTILES_TILES,
  PMTILES_COUNTRY_MIN_ZOOM,
  SOUTHERN_AFRICA_BBOX,
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

test('country cover starts at z4 from the posted bbox', () => {
  const { minZoom, maxZoom, tiles } = resolvePmtilesCover({
    country_code: 'MW',
    bbox: MALAWI_BBOX,
    maxZoom: 7,
    layers: 'full',
  });
  expect(minZoom).toBe(4);
  expect(maxZoom).toBe(7);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => t.z >= 4 && t.z <= 7)).toBe(true);
});

test('country cover honors minZoom for composite-base layering', () => {
  const { minZoom, maxZoom, tiles } = resolvePmtilesCover({
    country_code: 'MW',
    bbox: MALAWI_BBOX,
    minZoom: 7,
    maxZoom: 8,
    layers: 'mobile',
  });
  expect(minZoom).toBe(7);
  expect(maxZoom).toBe(8);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => t.z >= 7 && t.z <= 8)).toBe(true);
});

test('global cover unions regions without duplicating tiles', () => {
  const { minZoom, tiles, masked } = resolvePmtilesCover({
    country_code: 'GLOBAL',
    maxZoom: 3,
    layers: 'mobile',
    regions: [{ bbox: SOUTHERN_AFRICA_BBOX, minZoom: 4, maxZoom: 6 }],
  });
  expect(minZoom).toBe(0);
  expect(masked).toBe(false);
  const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
  expect(new Set(keys).size).toBe(keys.length);
  // 85 world tiles z0–3 plus the Southern Africa z4–6 top-up.
  expect(tiles.length).toBeGreaterThan(85);
  expect(tiles.some((t) => t.z >= 4)).toBe(true);
});

test('country masks load for MW/ZM/ZW and trim bbox covers', () => {
  const masks = loadCountryMasks();
  for (const cc of ['MW', 'ZM', 'ZW']) {
    expect(masks[cc].length).toBeGreaterThan(0);
  }
  const { tiles, masked } = resolvePmtilesCover({
    country_code: 'MW',
    bbox: MALAWI_BBOX,
    maxZoom: 8,
    layers: 'mobile',
  });
  expect(masked).toBe(true);
  expect(tiles.length).toBeLessThan(countPmtilesTiles(MALAWI_BBOX, PMTILES_COUNTRY_MIN_ZOOM, 8));
  expect(maskCoverTiles([{ x: 15, y: 8, z: 4 }], 'MW')).toHaveLength(0);
  // Unknown codes pass through unmasked.
  const passthrough = [
    { x: 1, y: 1, z: 4 },
    { x: 2, y: 2, z: 4 },
  ];
  expect(maskCoverTiles(passthrough, 'XX')).toBe(passthrough);
});
test('mergeFeatureStats folds per-tile counts into the zoom table', () => {
  const acc: Record<string, Record<string, { kept: number; dropped: number }>> = {};
  mergeFeatureStats(acc, '8', { kept: { place: 50 }, dropped: { place: 78, park: 12 } });
  mergeFeatureStats(acc, '8', { kept: { place: 40 }, dropped: { place: 60 } });
  mergeFeatureStats(acc, '9', { kept: { water: 3 }, dropped: {} });
  expect(acc['8']['place']).toEqual({ kept: 90, dropped: 138 });
  expect(acc['8']['park']).toEqual({ kept: 0, dropped: 12 });
  expect(acc['9']['water']).toEqual({ kept: 3, dropped: 0 });
});

test('writeUnpackedTiles lays out z/x/y.pbf files for local serving', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'unpack-test-'));
  try {
    const dir = await writeUnpackedTiles(
      'MW_z7-8_mobile_test',
      [
        { t: { x: 1, y: 2, z: 7 }, data: new Uint8Array([1, 2, 3]) },
        { t: { x: 4, y: 5, z: 8 }, data: new Uint8Array([9]) },
      ],
      tmp,
    );
    expect(dir).toBe(nodePath.join(tmp, 'MW_z7-8_mobile_test'));
    expect(new Uint8Array(await fs.readFile(nodePath.join(dir, '7', '1', '2.pbf')))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(new Uint8Array(await fs.readFile(nodePath.join(dir, '8', '4', '5.pbf')))).toEqual(
      new Uint8Array([9]),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('mbtileRow flips y to TMS orientation', () => {
  expect(mbtileRow(0, 0)).toBe(0);
  expect(mbtileRow(1, 0)).toBe(1);
  expect(mbtileRow(1, 1)).toBe(0);
  expect(mbtileRow(2, 3)).toBe(0);
  expect(mbtileRow(2, 0)).toBe(3);
});

test('warm cover unions world, SA top-up and country ranges without duplication', () => {
  const tiles = pmtilesWarmCover({ MW: [32.6, -17.2, 36.0, -9.3] });
  const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
  expect(new Set(keys).size).toBe(keys.length);
  // World z0–3 alone is 85 tiles; the SA top-up and MW z4–8 add more.
  expect(tiles.length).toBeGreaterThan(85);
  expect(Math.min(...tiles.map((t) => t.z))).toBe(0);
  expect(Math.max(...tiles.map((t) => t.z))).toBe(8);
  // A point-size bbox still resolves (single tile column per zoom).
  const tiny = pmtilesWarmCover({ XX: [33.0, -13.0, 33.1, -12.9] });
  expect(tiny.length).toBeGreaterThan(85);
});

test('minimal preset drops bulk layers but never core layers', () => {
  expect(droppedLayersFor('full')).toEqual([]);
  const dropped = droppedLayersFor('minimal');
  expect(dropped).toEqual(expect.arrayContaining(MINIMAL_DROPPED_LAYERS));
  for (const core of ['boundary', 'place', 'water', 'transportation']) {
    expect(dropped).not.toContain(core);
  }
});

test('mobile preset additionally drops landuse, park and mountain peaks', () => {
  const dropped = droppedLayersFor('mobile');
  expect(dropped).toEqual(expect.arrayContaining(MOBILE_DROPPED_LAYERS));
  for (const extra of ['landuse', 'park', 'mountain_peak']) {
    expect(dropped).toContain(extra);
  }
  for (const core of ['boundary', 'place', 'water', 'transportation', 'landcover']) {
    expect(dropped).not.toContain(core);
  }
  expect(shouldApplyMobileFilters('mobile')).toBe(true);
  expect(shouldApplyMobileFilters('minimal')).toBe(false);
  expect(shouldStripNamesFor('mobile')).toBe(true);
});

test('mobile road thresholds keep majors, named links, and z10+ minors', () => {
  expect(shouldKeepMobileFeature('transportation', { class: 'primary' }, 2, 8)).toBe(true);
  expect(shouldKeepMobileFeature('transportation', { class: 'minor' }, 2, 9)).toBe(false);
  expect(shouldKeepMobileFeature('transportation', { class: 'unclassified' }, 2, 9)).toBe(false);
  expect(shouldKeepMobileFeature('transportation', { class: 'minor' }, 2, 10)).toBe(true);
  expect(shouldKeepMobileFeature('transportation', { class: 'rail' }, 2, 8)).toBe(false);
  expect(shouldKeepMobileFeature('transportation', { class: 'rail' }, 2, 9)).toBe(true);
  expect(
    shouldKeepMobileFeature('transportation', { class: 'track', name: 'Village Path' }, 2, 9),
  ).toBe(true);
  expect(shouldKeepMobileFeature('transportation', { class: 'track' }, 2, 9)).toBe(false);
  expect(shouldKeepMobileFeature('transportation', { class: 'footway' }, 2, 10)).toBe(false);
});

test('mobile place thresholds drop unrendered classes per zoom', () => {
  expect(shouldKeepMobileFeature('place', { class: 'village' }, 1, 8)).toBe(false);
  expect(shouldKeepMobileFeature('place', { class: 'village' }, 1, 9)).toBe(true);
  expect(shouldKeepMobileFeature('place', { class: 'suburb' }, 1, 8)).toBe(false);
  expect(shouldKeepMobileFeature('place', { class: 'town' }, 1, 8)).toBe(true);
  expect(shouldKeepMobileFeature('place', { class: 'country' }, 1, 8)).toBe(true);
  expect(shouldKeepMobileFeature('place', { class: 'country' }, 1, 9)).toBe(false);
  expect(shouldKeepMobileFeature('place', { class: 'state' }, 1, 9)).toBe(true);
  expect(shouldKeepMobileFeature('place', { class: 'state' }, 1, 10)).toBe(false);
  expect(shouldKeepMobileFeature('place', { class: 'city' }, 1, 11)).toBe(true);
});

test('mobile drops sub-z10 road labels, line water labels, maritime and tunnels', () => {
  expect(shouldKeepMobileFeature('transportation_name', { class: 'motorway' }, 2, 9)).toBe(false);
  expect(shouldKeepMobileFeature('transportation_name', { class: 'motorway' }, 2, 10)).toBe(true);
  expect(shouldKeepMobileFeature('water_name', { name: 'Lake' }, 1, 8)).toBe(true);
  expect(shouldKeepMobileFeature('water_name', { name: 'River' }, 2, 8)).toBe(false);
  expect(shouldKeepMobileFeature('boundary', { admin_level: 2, maritime: 1 }, 3, 6)).toBe(false);
  expect(shouldKeepMobileFeature('boundary', { admin_level: 2, maritime: 0 }, 3, 6)).toBe(true);
  expect(shouldKeepMobileFeature('water', { class: 'lake', brunnel: 'tunnel' }, 3, 8)).toBe(false);
  expect(shouldKeepMobileFeature('waterway', { class: 'river' }, 2, 8)).toBe(true);
  expect(shouldKeepMobileFeature('landcover', { class: 'wood' }, 3, 8)).toBe(true);
});

test('mobile property allowlists keep only style-read tags', () => {
  // place: class/name/latin + capital==2 only (rank stripped except countries).
  expect(shouldKeepMobileProperty('place', 'class', 'city', { class: 'city' })).toBe(true);
  expect(shouldKeepMobileProperty('place', 'rank', 1, { class: 'city', rank: 1 })).toBe(false);
  expect(shouldKeepMobileProperty('place', 'rank', 1, { class: 'country', rank: 1 })).toBe(true);
  expect(shouldKeepMobileProperty('place', 'rank', 3, { class: 'state', rank: 3 })).toBe(false);
  expect(shouldKeepMobileProperty('place', 'capital', 2, { class: 'city', capital: 2 })).toBe(true);
  expect(shouldKeepMobileProperty('place', 'capital', 4, { class: 'city', capital: 4 })).toBe(
    false,
  );
  expect(shouldKeepMobileProperty('place', 'name:latin', 'Lilongwe', { name: 'Lilongwe' })).toBe(
    false,
  );
  expect(shouldKeepMobileProperty('place', 'name:latin', 'Mumbai', { name: 'Mumbai' })).toBe(false);
  expect(shouldKeepMobileProperty('place', 'name:latin', 'Rhodesia', { name: 'Zimbabwe' })).toBe(
    true,
  );
  // name:en is never kept (drops colonial aliases at source).
  expect(
    shouldKeepMobileProperty('place', 'name:en', 'Chipata (Fort Jameson)', {
      name: 'Chipata',
    }),
  ).toBe(false);
  // water carries no properties; waterway/water_name keep name + class refs.
  expect(shouldKeepMobileProperty('water', 'class', 'lake', { class: 'lake' })).toBe(false);
  expect(shouldKeepMobileProperty('waterway', 'class', 'river', { class: 'river' })).toBe(true);
  expect(shouldKeepMobileProperty('water_name', 'name', 'Malawi', { name: 'Malawi' })).toBe(true);
  expect(
    shouldKeepMobileProperty('water_name', 'class', 'lake', { name: 'Malawi', class: 'lake' }),
  ).toBe(false);
  // transportation keeps class only; _name keeps ref + names + class for labels.
  expect(
    shouldKeepMobileProperty('transportation', 'surface', 'asphalt', { class: 'primary' }),
  ).toBe(false);
  expect(shouldKeepMobileProperty('transportation_name', 'ref', 'M1', { ref: 'M1' })).toBe(true);
  expect(
    shouldKeepMobileProperty('transportation_name', 'class', 'primary', { class: 'primary' }),
  ).toBe(true);
  expect(
    shouldKeepMobileProperty('transportation_name', 'network', 'mw-national', { ref: 'M1' }),
  ).toBe(false);
  // boundary keeps admin_level + disputed==1 only.
  expect(shouldKeepMobileProperty('boundary', 'admin_level', 2, { admin_level: 2 })).toBe(true);
  expect(shouldKeepMobileProperty('boundary', 'disputed', 1, { disputed: 1 })).toBe(true);
  expect(shouldKeepMobileProperty('boundary', 'disputed', 0, { disputed: 0 })).toBe(false);
  expect(shouldKeepMobileProperty('boundary', 'name', 'Malawi', { admin_level: 2 })).toBe(false);
  expect(shouldKeepMobileProperty('landcover', 'class', 'wood', { class: 'wood' })).toBe(true);
  expect(shouldKeepMobileProperty('landcover', 'subclass', 'forest', { class: 'wood' })).toBe(
    false,
  );
});

test('filterTileLayers passes bytes through when nothing is dropped', () => {
  const raw = new Uint8Array([1, 2, 3]);
  expect(filterTileLayers(raw, [])).toBe(raw);
});

test('name stripping keeps base + en/latin and drops other translations', () => {
  expect(shouldKeepProperty('name')).toBe(true);
  expect(shouldKeepProperty('name:en')).toBe(true);
  expect(shouldKeepProperty('name:latin')).toBe(true);
  expect(shouldKeepProperty('name:fr')).toBe(false);
  expect(shouldKeepProperty('name_de')).toBe(false);
  expect(shouldKeepProperty('class')).toBe(true);
  expect(shouldStripNamesFor('minimal')).toBe(true);
  expect(shouldStripNamesFor('full')).toBe(false);
});

test('global place thinning keeps continents/countries/rank<=3 at z<=3 only', () => {
  expect(shouldKeepFeature('place', { class: 'continent', rank: 1 }, 2, true)).toBe(true);
  expect(shouldKeepFeature('place', { class: 'country', rank: 5 }, 3, true)).toBe(true);
  expect(shouldKeepFeature('place', { class: 'city', rank: 1 }, 3, true)).toBe(true);
  expect(shouldKeepFeature('place', { class: 'state', rank: 6 }, 3, true)).toBe(false);
  expect(shouldKeepFeature('place', { class: 'state', rank: 6 }, 4, true)).toBe(true);
  expect(shouldKeepFeature('place', { class: 'state', rank: 6 }, 3, false)).toBe(true);
  expect(shouldKeepFeature('water', { class: 'lake' }, 2, true)).toBe(true);
});

test('real country covers fit the export cap; world-sized covers throw', () => {
  const malawi = resolvePmtilesCover({
    country_code: 'MW',
    bbox: MALAWI_BBOX,
    maxZoom: 12,
    layers: 'full',
  });
  expect(malawi.tiles.length).toBeLessThan(MAX_PMTILES_TILES);
  // Masking only removes tiles, so the masked cover is a subset of the bbox cover.
  expect(malawi.tiles.length).toBeLessThanOrEqual(
    countPmtilesTiles(MALAWI_BBOX, PMTILES_COUNTRY_MIN_ZOOM, 12),
  );
  expect(malawi.masked).toBe(true);
  expect(() =>
    resolvePmtilesCover({
      country_code: 'MW',
      bbox: [-180, -85.0511, 180, 85.0511],
      maxZoom: 12,
      layers: 'full',
    }),
  ).toThrow(CoverTooLargeError);
});
