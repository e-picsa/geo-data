import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import vtPbf from 'vt-pbf';
import { getTilesForBbox, getTileRangeForBbox, tile2lon, tile2lat } from '../utils/tiles.ts';
import { PREWARM_COUNTRIES } from './geofabrik/url-mapping.ts';
import { getPlanetDataDate, LIBERTY_STYLE_URL } from './map-tiles.ts';

/**
 * Offline vector (PMTiles) packager.
 *
 * Unlike the raster packs in map-tiles.ts (which RENDER upstream vector tiles
 * into WebP), this module repackages the upstream OpenFreeMap planet vector
 * tiles (the exact same PBFs the renderer consumes) into a single-file
 * `.pmtiles` archive. Fidelity with the WebP map is therefore byte-level for
 * geometry — the client just styles the vectors directly for crisp rendering.
 *
 * No tile `buffer` concept exists here (unlike raster): vector tiles carry
 * their own internal extent buffer, and the tile cover is derived from the
 * country bbox (or the whole world for GLOBAL).
 */

export const PMTILES_VERSION = 6;
export const PMTILES_GLOBAL_MAX_ZOOM = 6;
export const PMTILES_GLOBAL_DEFAULT_ZOOM = 4;
export const PMTILES_COUNTRY_MIN_ZOOM = 4;
export const PMTILES_COUNTRY_MAX_ZOOM = 12;
export const PMTILES_COUNTRY_DEFAULT_ZOOM = 8;

/** Shared Southern Africa deployment bbox (MW + ZM + ZW, zero-duplication base). */
export const SOUTHERN_AFRICA_BBOX: [number, number, number, number] = [21.5, -23.0, 36.5, -8.0];

/**
 * Hard cap on tiles per export. A world-sized bbox at z4–12 would otherwise
 * resolve to ~22M tiles (enormous fetch/memory/SQLite work); real countries
 * stay far below this (Malawi z4–12 ≈ 5k unmasked, DRC ≈ 60k).
 */
export const MAX_PMTILES_TILES = 100_000;

export const PMTILES_DIR = path.join(process.cwd(), '.cache', 'pmtiles');
/** Raw upstream PBFs, cached by planet vintage so exports survive data updates. */
export const PMTILES_SOURCE_DIR = path.join(process.cwd(), '.cache', 'pmtiles-source');
/**
 * Unpacked per-pack vector tiles (`<base>/<z>/<x>/<y>.pbf`), written alongside
 * every export so the offline map mode can serve local XYZ tiles through this
 * server with zero conversion. Disposable preview cache — GCS keeps packs only.
 */
export const PMTILES_TILES_DIR = path.join(process.cwd(), '.cache', 'pmtiles-tiles');

export const WORLD_BBOX: [number, number, number, number] = [-180, -85.0511, 180, 85.0511];

export type PmtilesLayersPreset = 'full' | 'minimal' | 'mobile';

/**
 * Layers dropped by the `minimal` preset. Per the upstream TileJSON these
 * first appear at: aerodrome_label z8, aeroway z10, poi z11, building z13,
 * housenumber z14 — so layer-dropping alone only shrinks country z8–12 tiles.
 * Low-zoom savings come from localized `name:*` stripping (see KEPT_NAME_PROPS),
 * which applies at every zoom for `minimal` and is what brings global z0–3
 * under ~1 MB.
 */
export const MINIMAL_DROPPED_LAYERS = [
  'building',
  'housenumber',
  'poi',
  'aeroway',
  'aerodrome_label',
];

/**
 * Layers additionally dropped by the `mobile` preset: landuse polygons
 * and mountain peaks are orientation noise for a rural offline basemap —
 * major roads, water, terrain (`landcover`), parks and place labels carry
 * the context farmers need. Style-threshold feature filtering and per-layer
 * property allowlists (see shouldKeepMobileFeature/shouldKeepMobileProperty)
 * trim the survivors per zoom to match `pmtiles-style.ts` (`z7–9`).
 */
export const MOBILE_DROPPED_LAYERS = [...MINIMAL_DROPPED_LAYERS, 'landuse', 'mountain_peak'];

/** Layers that must always survive filtering (guards preset regressions). */
const CORE_LAYERS = ['boundary', 'place', 'water', 'transportation'];

/**
 * Localized name bloat dominates low-zoom size: every place/water label carries
 * dozens of `name:xx` translations. `minimal` keeps only the base + English +
 * Latin fallback so MapLibre labels still render, stripping the rest.
 */
export const KEPT_NAME_PROPS = new Set(['name', 'name:en', 'name:latin']);

export function shouldKeepProperty(key: string): boolean {
  if (key === 'name') return true;
  if (key.startsWith('name:') || key.startsWith('name_')) return KEPT_NAME_PROPS.has(key);
  return true;
}

/** `minimal` and `mobile` strip localized names; `full` stays byte-identical. */
export function shouldStripNamesFor(preset: PmtilesLayersPreset): boolean {
  return preset === 'minimal' || preset === 'mobile';
}

/** Only `mobile` applies threshold-aligned style filtering (see below). */
export function shouldApplyMobileFilters(preset: PmtilesLayersPreset): boolean {
  return preset === 'mobile';
}

/** Road classes the `mobile` (`z7–9`) country style renders (see `pmtiles-style.ts`).
 * Minor/unclassified streets, ferries and construction variants are skipped to
 * keep APK size minimal — the style only renders the majors + rail below z10. */
export const MOBILE_KEPT_ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'rail',
]);

/** Road-label classes kept at `z8–9` (ref + fallback name shields for majors only). */
export const MOBILE_KEPT_ROAD_LABEL_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);

/** Landcover classes the country style fills at `z7–9`. */
export const MOBILE_KEPT_LANDCOVER_CLASSES = new Set([
  'wood',
  'grass',
  'wetland',
  'farmland',
  'rock',
  'sand',
]);

/** Place classes the country style renders at `z7–9` (`village` only at `z9`). */
export const MOBILE_COUNTRY_PLACE_CLASSES = new Set(['country', 'state', 'city', 'town']);

/** Place classes the offline style can render below z9. */
export const MOBILE_LOW_ZOOM_PLACE_CLASSES = new Set(['country', 'state', 'city', 'town']);

/**
 * Per-layer allowlists for the `mobile` preset: every other property is
 * dropped so geometry stays compact and APK size stays minimal. Only
 * `name:latin` (+ fallback `name`) plus the filter/style fields the
 * `pmtiles-style.ts` country layers read are kept:
 * `class`, `admin_level`, `capital`, `ref` (`brunnel`/`maritime`/`disputed`
 * are filter-only — features carrying them are dropped at generation, so the
 * flags themselves need no bytes). `capital` survives only when `2` and
 * `name:latin` only when it differs from `name` (see below).
 */
export const MOBILE_KEPT_PROPS: Record<string, Set<string>> = {
  place: new Set(['class', 'name', 'name:latin', 'capital']),
  landcover: new Set(['class']),
  park: new Set([]),
  water: new Set([]),
  waterway: new Set(['class', 'name', 'name:latin']),
  water_name: new Set(['name', 'name:latin']),
  transportation: new Set(['class']),
  transportation_name: new Set(['ref', 'name', 'name:latin']),
  boundary: new Set(['admin_level']),
};

export function shouldKeepMobileProperty(
  layer: string,
  key: string,
  value: unknown,
  props: Record<string, unknown>,
): boolean {
  const allowed = MOBILE_KEPT_PROPS[layer];
  if (allowed ? !allowed.has(key) : key !== 'class') return false;
  // `name:latin` survives only when it adds information beyond `name`.
  if (key === 'name:latin') {
    return value !== undefined && value !== null && value !== '' && value !== props?.name;
  }
  // Capitals are only worth bytes when set (drives the capital-city style).
  if (key === 'capital') return value === 2;
  return true;
}

/**
 * Threshold-aligned feature filter for the `mobile` preset, matching
 * `pmtiles-style.ts` country-detail layers (`z7–9`, APK-minimal):
 * - `place`: `country`/`state`/`city`/`town` at `z7–9`, `village` only at `z9`
 * - `transportation`: majors + `tertiary` at `z7–9`, `rail` only at `z9+`
 * - `transportation_name`: majors (`motorway`/`trunk`/`primary`/`secondary`)
 *   with `ref` or `name`, only at `z8+` (style `minzoom: 8`)
 * - `water_name`: named lake/reservoir/dam labels (upstream lines at z7–9)
 * - `waterway`: rivers only below `z10` (other waterways render at `z10+`),
 *   never tunnels
 * - `boundary`: `admin_level` 2–6, excluding `maritime=1` and `disputed=1`
 * - `landcover`: only the six styled classes
 * - `park`: kept here — tiny pocket parks are dropped by geometry area in
 *   `filterTileLayers` (needs `loadGeometry`, unavailable here).
 * `geomType` is the MVT type (1 point, 2 line, 3 polygon). Returns true for
 * presets/layers without mobile rules.
 */
export function shouldKeepMobileFeature(
  layer: string,
  props: Record<string, unknown>,
  geomType: number,
  z: number,
): boolean {
  const cls = props.class;
  switch (layer) {
    case 'place':
      if (cls === 'village') return z >= 9;
      if (typeof cls === 'string' && MOBILE_COUNTRY_PLACE_CLASSES.has(cls)) return true;
      return false;
    case 'transportation':
      if (cls === 'rail') return z >= 9;
      if (typeof cls === 'string' && MOBILE_KEPT_ROAD_CLASSES.has(cls)) return cls !== 'rail';
      return false;
    case 'transportation_name': {
      // Style minzoom is 8 — the whole layer is dead weight below it.
      if (z < 8) return false;
      if (typeof cls !== 'string' || !MOBILE_KEPT_ROAD_LABEL_CLASSES.has(cls)) return false;
      const ref = props.ref;
      const name = props.name ?? props['name:latin'];
      return (typeof ref === 'string' && ref !== '') || (typeof name === 'string' && name !== '');
    }
    case 'water_name': {
      // Upstream OpenFreeMap encodes lake/reservoir labels at z7–9 as lines
      // (e.g. Malawi, Kariba); keep all named features so lake bearing survives
      // (style renders points, lines are harmless extra bearing + glyph proof).
      const name = props.name ?? props['name:latin'];
      return typeof name === 'string' && name !== '';
    }
    case 'waterway':
      if (props.brunnel === 'tunnel') return false;
      // Below z10 the style only renders rivers (other waterways are z10+).
      if (z < 10 && cls !== 'river') return false;
      return true;
    case 'boundary': {
      if (props.maritime === 1 || props.disputed === 1) return false;
      const al = props.admin_level;
      return typeof al === 'number' && al >= 2 && al <= 6;
    }
    case 'landcover':
      return typeof cls === 'string' && MOBILE_KEPT_LANDCOVER_CLASSES.has(cls);
    case 'water':
      return props.brunnel !== 'tunnel';
    default:
      return true;
  }
}

/** Minimum park bbox area (MVT extent units², extent 4096) to survive at `z7–9`.
 * Drops tiny urban pocket parks (Harare `Mukuvisi`/`Haka` ≈ 3–40k) while keeping
 * national parks/conservancies/game reserves (typically 100k+, Victoria Falls
 * ≈ 73k+). Features with ≤1 geometry point (tile-edge clips) are always kept. */
export const MOBILE_PARK_MIN_AREA = 50_000;

/**
 * Low-zoom place thinning (`minimal`/`mobile`, z<=3): keep
 * continents, countries and rank<=3 states/cities — the labels a z0–3 map
 * actually renders. Rank 4–6 hamlets/provinces only appear at higher zooms,
 * which the country packs (z4+) provide in full.
 */
export function shouldKeepFeature(
  layer: string,
  props: Record<string, unknown>,
  z: number,
  stripNames: boolean,
): boolean {
  if (!stripNames) return true;
  if (layer === 'place' && z <= 3) {
    const cls = props.class;
    if (cls === 'continent' || cls === 'country') return true;
    const rank = props.rank;
    if (typeof rank === 'number') return rank <= 3;
  }
  return true;
}

/** Extra tile regions for composite exports (e.g. Southern Africa on GLOBAL). */
export interface PmtilesRegion {
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}

export interface ExportPmtilesParams {
  country_code: string;
  /** Required for countries; ignored for GLOBAL (world cover). */
  bbox?: [number, number, number, number];
  /** Country packs may start above z4 when a composite base owns low zooms. */
  minZoom?: number;
  maxZoom: number;
  layers: PmtilesLayersPreset;
  /** GLOBAL-only: extra regional zoom ranges unioned into the cover. */
  regions?: PmtilesRegion[];
}

export interface PmtilesManifest {
  style: string;
  styleUrl: string;
  dataDate: string;
  generatedAt: string;
  scope: 'global' | 'country';
  country_code: string;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  layers: PmtilesLayersPreset;
  droppedLayers: string[];
  /** True when localized `name:*` properties were stripped (minimal/mobile). */
  strippedNames: boolean;
  /** True when the cover was intersected with the in-repo country mask. */
  masked: boolean;
  /** Extra regional zoom ranges (composite global base), if any. */
  regions?: PmtilesRegion[];
  /**
   * Per-zoom, per-layer feature counts for the QA panel: what the pack kept
   * vs what the preset dropped (`zoom -> layer -> {kept, dropped}`). Only
   * present when filtering ran (minimal/mobile); `full` stays byte-identical
   * and reports nothing.
   */
  featureStats?: Record<string, Record<string, { kept: number; dropped: number }>>;
  tileCount: number;
  /** Tiles fetched from upstream during this export (0 = fully cached). */
  fetched: number;
  /** Tiles whose layers were stripped (minimal preset). */
  filtered: number;
  /** Tiles skipped (missing upstream / empty after filtering). */
  skipped: number;
  fileSizeBytes: number;
  file: string;
  sha256: string;
}

/**
 * Tile-cache warming mirrors the WebP prewarm ceiling (z8): the shared raw
 * source cache is filled for the world base, the Southern Africa top-up and
 * every `PREWARM_COUNTRIES` entry, so any consumer-defined export (any
 * country, any min/max zoom, any preset) builds fast from local disk.
 * Deeper zooms always fetch on demand. No finished packs, no fixed recipes.
 */
export const PMTILES_WARM_WORLD_MAX_ZOOM = 3;
export const PMTILES_WARM_COUNTRY_MIN_ZOOM = 4;
export const PMTILES_WARM_COUNTRY_MAX_ZOOM = 8;

/** Pure cover builder for tile-cache warming (unit tested): deduped union of
 * world z0–3, Southern Africa z4–6 and each given country bbox at z4–8. */
export function pmtilesWarmCover(
  bboxes: Record<string, [number, number, number, number]>,
): TileCoord[] {
  const seen = new Set<string>();
  const tiles: TileCoord[] = [];
  const push = (t: TileCoord) => {
    const k = `${t.z}/${t.x}/${t.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      tiles.push(t);
    }
  };
  const [wLon1, wLat1, wLon2, wLat2] = WORLD_BBOX;
  for (let z = 0; z <= PMTILES_WARM_WORLD_MAX_ZOOM; z++) {
    for (const t of getTilesForBbox(wLon1, wLat1, wLon2, wLat2, z, 0)) push(t);
  }
  const [sLon1, sLat1, sLon2, sLat2] = SOUTHERN_AFRICA_BBOX;
  for (let z = 4; z <= 6; z++) {
    for (const t of getTilesForBbox(sLon1, sLat1, sLon2, sLat2, z, 0)) push(t);
  }
  for (const bbox of Object.values(bboxes)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    for (let z = PMTILES_WARM_COUNTRY_MIN_ZOOM; z <= PMTILES_WARM_COUNTRY_MAX_ZOOM; z++) {
      for (const t of getTilesForBbox(minLon, minLat, maxLon, maxLat, z, 0)) push(t);
    }
  }
  return tiles;
}

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export function isGlobalCode(country_code: string): boolean {
  return country_code.toUpperCase() === 'GLOBAL';
}

export class CoverTooLargeError extends Error {
  readonly tileCount: number;
  constructor(tileCount: number) {
    super(
      `Tile cover (~${tileCount.toLocaleString()} tiles) exceeds the limit of ${MAX_PMTILES_TILES.toLocaleString()}`,
    );
    this.name = 'CoverTooLargeError';
    this.tileCount = tileCount;
  }
}

/**
 * Count cover tiles from ranges only — safe for planet-scale inputs that
 * must never be materialized (pure — unit tested).
 */
export function countPmtilesTiles(
  bbox: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = getTileRangeForBbox(minLon, minLat, maxLon, maxLat, z);
    total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return total;
}

/** Single mask polygon: outer ring + holes, in lon/lat. */
export interface MaskPolygon {
  outer: number[][];
  holes: number[][][];
}

/** Tolerance (~2km) so simplified borders never punch gaps in the cover. */
export const MASK_EPSILON_DEG = 0.02;

let maskCache: Record<string, MaskPolygon[]> | null = null;

/**
 * In-repo country tile masks (`src/data/country-masks/*.geojson`), derived
 * from the same `/boundaries` geometry the app overlays — so masked packs
 * and boundary lines can never disagree. Missing file = no masking.
 */
export function loadCountryMasks(): Record<string, MaskPolygon[]> {
  if (maskCache) return maskCache;
  maskCache = {};
  for (const cc of ['MW', 'ZM', 'ZW']) {
    try {
      const p = path.join(
        import.meta.dir,
        '..',
        'data',
        'country-masks',
        `${cc.toLowerCase()}.geojson`,
      );
      if (!existsSync(p)) continue;
      const fc = JSON.parse(readFileSync(p, 'utf8')) as {
        features: { geometry: { type: string; coordinates: number[][][][] | number[][][] } }[];
      };
      const polys: MaskPolygon[] = [];
      for (const f of fc.features ?? []) {
        const g = f.geometry;
        if (!g) continue;
        const list: number[][][][] =
          g.type === 'Polygon'
            ? [g.coordinates as number[][][]]
            : (g.coordinates as number[][][][]);
        for (const poly of list) {
          if (poly.length > 0 && poly[0].length >= 4) {
            polys.push({ outer: poly[0], holes: poly.slice(1) });
          }
        }
      }
      if (polys.length > 0) maskCache[cc] = polys;
    } catch {
      /* corrupt mask must never break exports — fall through unmasked */
    }
  }
  return maskCache;
}

function ringContains(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function maskPolygonContains(lon: number, lat: number, poly: MaskPolygon): boolean {
  return ringContains(lon, lat, poly.outer) && !poly.holes.some((h) => ringContains(lon, lat, h));
}

/**
 * Keep a tile when it plausibly touches the country: any of a 3×3 sample grid
 * inside the polygon, or any polygon vertex inside the epsilon-expanded tile
 * (covers countries smaller than a tile at low zooms). Conservative by design
 * — border tiles are kept, so packs never have gaps.
 */
export function tileIntersectsMask(x: number, y: number, z: number, polys: MaskPolygon[]): boolean {
  const lonW = tile2lon(x, z) - MASK_EPSILON_DEG;
  const lonE = tile2lon(x + 1, z) + MASK_EPSILON_DEG;
  const latN = tile2lat(y, z) + MASK_EPSILON_DEG;
  const latS = tile2lat(y + 1, z) - MASK_EPSILON_DEG;
  for (const fx of [0.1, 0.5, 0.9]) {
    for (const fy of [0.1, 0.5, 0.9]) {
      const lon = lonW + (lonE - lonW) * fx;
      const lat = latN + (latS - latN) * fy;
      for (const poly of polys) {
        if (maskPolygonContains(lon, lat, poly)) return true;
      }
    }
  }
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      const stride = Math.max(1, Math.floor(ring.length / 400));
      for (let i = 0; i < ring.length; i += stride) {
        const [vx, vy] = ring[i];
        if (vx >= lonW && vx <= lonE && vy <= latN && vy >= latS) return true;
      }
    }
  }
  return false;
}

/**
 * Intersect a tile cover with the country's mask polygon (pure — unit tested).
 * Returns the original array untouched when no mask exists for the code.
 */
export function maskCoverTiles(tiles: TileCoord[], countryCode: string): TileCoord[] {
  const polys = loadCountryMasks()[countryCode.toUpperCase()];
  if (!polys) return tiles;
  return tiles.filter((t) => tileIntersectsMask(t.x, t.y, t.z, polys));
}

/**
 * Resolve the zoom range + tile cover for an export (pure — unit tested).
 * Global always starts at z0; country packs start at `minZoom` (default z4,
 * or z7+ when layered over a composite base that owns the low zooms).
 * GLOBAL-only `regions` union extra zoom ranges (e.g. Southern Africa z4–6)
 * into the cover for zero-duplication composite bases. Country covers are
 * intersected with the in-repo mask polygon when one exists (MW/ZM/ZW).
 */
export function resolvePmtilesCover(params: ExportPmtilesParams): {
  minZoom: number;
  maxZoom: number;
  tiles: TileCoord[];
  masked: boolean;
} {
  const global = isGlobalCode(params.country_code);
  const minZoom = global ? 0 : (params.minZoom ?? PMTILES_COUNTRY_MIN_ZOOM);
  const maxZoom = params.maxZoom;
  const bbox = global ? WORLD_BBOX : params.bbox!;
  // Count before materializing: a planet-scale cover must throw instead of
  // exploding the call stack / heap via array spread.
  let count = countPmtilesTiles(bbox, minZoom, maxZoom);
  const regions = global ? (params.regions ?? []) : [];
  for (const r of regions) count += countPmtilesTiles(r.bbox, r.minZoom, r.maxZoom);
  if (count > MAX_PMTILES_TILES) throw new CoverTooLargeError(count);
  const seen = new Set<string>();
  const tiles: TileCoord[] = [];
  const push = (t: TileCoord) => {
    const k = `${t.z}/${t.x}/${t.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      tiles.push(t);
    }
  };
  const [minLon, minLat, maxLon, maxLat] = bbox;
  for (let z = minZoom; z <= maxZoom; z++) {
    for (const t of getTilesForBbox(minLon, minLat, maxLon, maxLat, z, 0)) push(t);
  }
  for (const r of regions) {
    const [rlon1, rlat1, rlon2, rlat2] = r.bbox;
    for (let z = r.minZoom; z <= r.maxZoom; z++) {
      for (const t of getTilesForBbox(rlon1, rlat1, rlon2, rlat2, z, 0)) push(t);
    }
  }
  let masked = false;
  if (!global) {
    const kept = maskCoverTiles(tiles, params.country_code);
    if (kept !== tiles) {
      tiles.length = 0;
      tiles.push(...kept);
      masked = true;
    }
  }
  return { minZoom, maxZoom, tiles, masked };
}

/** MBTiles uses TMS-flipped rows: row = (2^z - 1) - y (pure — unit tested). */
export function mbtileRow(z: number, y: number): number {
  return Math.pow(2, z) - 1 - y;
}

function upstreamPbfUrl(dataDate: string, t: TileCoord): string {
  return `https://tiles.openfreemap.org/planet/${dataDate}/${t.z}/${t.x}/${t.y}.pbf`;
}

function sourceCachePath(dataDate: string, layers: PmtilesLayersPreset, t: TileCoord): string {
  return path.join(PMTILES_SOURCE_DIR, dataDate, layers, String(t.z), String(t.x), `${t.y}.pbf`);
}

/**
 * Upstream PBFs are served gzip-compressed; decode transparently either way.
 */
function decodeTile(raw: Uint8Array): VectorTile {
  try {
    return new VectorTile(new PbfReader(raw));
  } catch {
    return new VectorTile(new PbfReader(gunzipSync(Buffer.from(raw))));
  }
}

/**
 * Strip denied layers + (optionally) localized name properties from a raw MVT
 * buffer. `mobileFilters` applies the threshold-aligned style trim (feature
 * thresholds per zoom + per-layer property allowlists). Returns the original
 * bytes when nothing was dropped/stripped (passthrough, no recompression
 * drift), gzip-compressed re-encoded bytes when layers/properties were
 * removed, or null when no layers remain.
 */
export interface PmtilesTileStats {
  kept: Record<string, number>;
  dropped: Record<string, number>;
}

/** Fold one tile's kept/dropped counts into the per-zoom manifest table (pure). */
export function mergeFeatureStats(
  acc: Record<string, Record<string, { kept: number; dropped: number }>>,
  zKey: string,
  collect: PmtilesTileStats,
): void {
  const layers = new Set([...Object.keys(collect.kept), ...Object.keys(collect.dropped)]);
  for (const layer of layers) {
    acc[zKey] ??= {};
    acc[zKey][layer] ??= { kept: 0, dropped: 0 };
    acc[zKey][layer].kept += collect.kept[layer] ?? 0;
    acc[zKey][layer].dropped += collect.dropped[layer] ?? 0;
  }
}

export function filterTileLayers(
  raw: Uint8Array,
  dropped: string[],
  stripNames = false,
  z = 0,
  mobileFilters = false,
  collect?: PmtilesTileStats,
): Uint8Array | null {
  if (dropped.length === 0 && !stripNames) return raw;
  const tile = decodeTile(raw);
  const kept: Record<string, any> = {};
  let droppedAny = false;
  for (const name of Object.keys(tile.layers)) {
    if (dropped.includes(name)) {
      droppedAny = true;
      if (collect) {
        try {
          collect.dropped[name] = (collect.dropped[name] ?? 0) + tile.layers[name].length;
        } catch {
          /* length unreadable — skip stats, not the export */
        }
      }
      continue;
    }
    const orig = tile.layers[name] as {
      version?: number;
      name?: string;
      extent?: number;
      length: number;
      feature: (i: number) => {
        id?: number;
        type: number;
        properties: Record<string, unknown>;
        loadGeometry: () => unknown;
      };
    };
    if (!stripNames) {
      kept[name] = tile.layers[name];
      continue;
    }
    // Collect kept feature indices first so thinning actually shrinks
    // the layer (vt-pbf encodes length + feature(i), so the wrapper must be
    // dense over survivors, not a sparse view over the original).
    const keptIdx: number[] = [];
    for (let i = 0; i < orig.length; i++) {
      try {
        const f = orig.feature(i);
        const props = (f.properties ?? {}) as Record<string, unknown>;
        if (!shouldKeepFeature(name, props, z, stripNames)) continue;
        if (mobileFilters && !shouldKeepMobileFeature(name, props, f.type, z)) continue;
        // Tiny urban pocket parks carry no bearing value at z7–9 but cost real
        // bytes — drop polygons whose MVT bbox is smaller than
        // MOBILE_PARK_MIN_AREA (tile-edge clips with ≤1 point always survive).
        if (mobileFilters && name === 'park') {
          try {
            const geom = f.loadGeometry() as Array<Array<{ x: number; y: number }>>;
            let minX = 4096;
            let maxX = 0;
            let minY = 4096;
            let maxY = 0;
            let pts = 0;
            for (const ring of geom) {
              for (const pt of ring) {
                pts++;
                if (pt.x < minX) minX = pt.x;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.y > maxY) maxY = pt.y;
              }
            }
            if (pts > 1 && (maxX - minX) * (maxY - minY) < MOBILE_PARK_MIN_AREA) continue;
          } catch {
            /* geometry unreadable — keep, not the export */
          }
        }
        keptIdx.push(i);
      } catch {
        keptIdx.push(i);
      }
    }
    if (collect) {
      collect.kept[name] = (collect.kept[name] ?? 0) + keptIdx.length;
      const droppedHere = orig.length - keptIdx.length;
      if (droppedHere > 0) collect.dropped[name] = (collect.dropped[name] ?? 0) + droppedHere;
    }
    if (keptIdx.length === 0) {
      droppedAny = true;
      continue;
    }
    // Wrap the layer so vt-pbf re-encodes with filtered properties while
    // delegating geometry loading to the original feature.
    const wrapped = {
      version: orig.version,
      name: (orig.name ?? name) as string,
      extent: orig.extent,
      length: keptIdx.length,
      feature: (i: number) => {
        const f = orig.feature(keptIdx[i]);
        const src = (f.properties ?? {}) as Record<string, unknown>;
        const props: Record<string, unknown> = {};
        for (const k of Object.keys(src)) {
          const keep = mobileFilters
            ? shouldKeepMobileProperty(name, k, src[k], src)
            : shouldKeepProperty(k);
          if (keep) props[k] = src[k];
        }
        return {
          id: f.id,
          type: f.type,
          properties: props,
          loadGeometry: () => f.loadGeometry(),
        };
      },
    };
    kept[name] = wrapped;
  }
  if (!droppedAny && !stripNames) return raw;
  if (Object.keys(kept).length === 0) return null;
  // When stripping names we always re-encode (even if a given tile carries no
  // localized names) for schema consistency; `full` keeps passthrough above.
  return gzipSync(vtPbf({ layers: kept }));
}

/** Guard: presets must never drop the core rendering layers. */
export function droppedLayersFor(preset: PmtilesLayersPreset): string[] {
  const dropped =
    preset === 'mobile'
      ? [...MOBILE_DROPPED_LAYERS]
      : preset === 'minimal'
        ? [...MINIMAL_DROPPED_LAYERS]
        : [];
  for (const core of CORE_LAYERS) {
    if (dropped.includes(core)) throw new Error(`Preset ${preset} must not drop ${core}`);
  }
  return dropped;
}

function resolvePmtilesBin(): string {
  if (process.env.PMTILES_BIN) return process.env.PMTILES_BIN;
  return path.join(import.meta.dir, '..', '..', 'bin', 'pmtiles');
}

function artifactBase(
  params: ExportPmtilesParams,
  minZoom: number,
  dataDate: string,
  bbox: [number, number, number, number],
): string {
  // Bbox hash: same country + zooms + preset but a different boundary extent
  // (or different composite regions) must not serve a stale cached artifact.
  const hashInput = [
    bbox.map((n) => n.toFixed(4)).join(','),
    (params.regions ?? [])
      .map((r) => `${r.bbox.map((n) => n.toFixed(4)).join(',')}:${r.minZoom}-${r.maxZoom}`)
      .join(';'),
  ].join('|');
  const bboxHash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  return `${params.country_code.toUpperCase()}_z${minZoom}-${params.maxZoom}_${params.layers}_${bboxHash}_v${PMTILES_VERSION}_${dataDate}`;
}

async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { signal });
      // Empty ocean tiles may 204/404 upstream — not fatal, just skippable.
      if (res.status === 404 || res.status === 204 || res.status === 400) return res;
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === 2) throw err;
    }
  }
  throw lastErr;
}

/** Fetch missing upstream PBFs into the disk cache with a small worker pool. */
async function fetchMissingTiles(
  tiles: TileCoord[],
  dataDate: string,
  layers: PmtilesLayersPreset,
  signal?: AbortSignal,
): Promise<{ fetched: number }> {
  const missing: TileCoord[] = [];
  for (const t of tiles) {
    try {
      await fs.access(sourceCachePath(dataDate, layers, t));
    } catch {
      missing.push(t);
    }
  }
  if (missing.length === 0) return { fetched: 0 };

  const workers = Math.min(8, missing.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      if (signal?.aborted) throw new Error('Aborted');
      const i = cursor++;
      if (i >= missing.length) return;
      const t = missing[i];
      const res = await fetchWithRetry(upstreamPbfUrl(dataDate, t), signal);
      const dest = sourceCachePath(dataDate, layers, t);
      if (!res.ok) continue; // 404/204/400 — skipped later, counted in manifest
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return { fetched: missing.length };
}

function writeMbtiles(
  dbPath: string,
  entries: { t: TileCoord; data: Uint8Array }[],
  meta: { name: string; bbox: [number, number, number, number]; minZoom: number; maxZoom: number },
): void {
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE metadata (name TEXT, value TEXT);
       CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
       CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);`,
    );
    const [minLon, minLat, maxLon, maxLat] = meta.bbox;
    const rows: [string, string][] = [
      ['name', meta.name],
      ['format', 'pbf'],
      ['version', '1.3.0'],
      ['type', 'baselayer'],
      ['minzoom', String(meta.minZoom)],
      ['maxzoom', String(meta.maxZoom)],
      ['bounds', `${minLon},${minLat},${maxLon},${maxLat}`],
      ['center', `${(minLon + maxLon) / 2},${(minLat + maxLat) / 2},${meta.minZoom}`],
      ['attribution', '© OpenMapTiles © OpenStreetMap contributors'],
      ['description', `OpenFreeMap Liberty vector extract (${meta.name})`],
    ];
    const insertMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    const insertTile = db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
    );
    const txn = db.transaction(() => {
      for (const [k, v] of rows) insertMeta.run(k, v);
      for (const { t, data } of entries) {
        insertTile.run(t.z, t.x, mbtileRow(t.z, t.y), Buffer.from(data));
      }
    });
    txn();
  } finally {
    db.close();
  }
}

async function runPmtilesConvert(mbtilesPath: string, pmtilesPath: string): Promise<void> {
  const bin = resolvePmtilesBin();
  const proc = Bun.spawn([bin, 'convert', mbtilesPath, pmtilesPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pmtiles convert failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
}

/** Unpacked per-pack tiles for local XYZ serving (pure file layout, testable). */
export async function writeUnpackedTiles(
  base: string,
  entries: { t: TileCoord; data: Uint8Array }[],
  tilesDir: string = PMTILES_TILES_DIR,
): Promise<string> {
  const dir = path.join(tilesDir, base);
  await fs.mkdir(dir, { recursive: true });
  for (const { t, data } of entries) {
    const file = path.join(dir, String(t.z), String(t.x), `${t.y}.pbf`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  return dir;
}

export async function exportPmtiles(
  params: ExportPmtilesParams,
  signal?: AbortSignal,
): Promise<{ filePath: string; manifest: PmtilesManifest }> {
  const global = isGlobalCode(params.country_code);
  const dataDate = await getPlanetDataDate();
  const { minZoom, maxZoom, tiles, masked } = resolvePmtilesCover(params);
  const bbox = global ? WORLD_BBOX : params.bbox!;
  const dropped = droppedLayersFor(params.layers);

  await fs.mkdir(PMTILES_DIR, { recursive: true });
  const base = artifactBase(params, minZoom, dataDate, bbox);
  const filePath = path.join(PMTILES_DIR, `${base}.pmtiles`);
  const manifestPath = path.join(PMTILES_DIR, `${base}.manifest.json`);

  try {
    const cached = await fs.readFile(manifestPath, 'utf8');
    try {
      await fs.access(filePath);
      // A pack without its unpacked tile dir can't serve offline mode —
      // treat it as a miss so this build regenerates everything.
      const unpacked = await fs.readdir(path.join(PMTILES_TILES_DIR, base)).catch(() => []);
      if (unpacked.length > 0) {
        return { filePath, manifest: JSON.parse(cached) as PmtilesManifest };
      }
    } catch {
      /* manifest without artifact — rebuild */
    }
  } catch {
    /* cache miss — build */
  }

  const { fetched } = await fetchMissingTiles(tiles, dataDate, 'full', signal);
  const stripNames = shouldStripNamesFor(params.layers);
  const mobileFilters = shouldApplyMobileFilters(params.layers);
  // Only filtered presets produce stats; `full` stays byte-identical.
  const collectStats = stripNames;
  const featureStats: Record<string, Record<string, { kept: number; dropped: number }>> = {};

  const entries: { t: TileCoord; data: Uint8Array }[] = [];
  let filtered = 0;
  let skipped = 0;
  for (const t of tiles) {
    if (signal?.aborted) throw new Error('Aborted');
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await fs.readFile(sourceCachePath(dataDate, 'full', t)));
    } catch {
      skipped++;
      continue;
    }
    const collect: PmtilesTileStats | undefined = collectStats
      ? { kept: {}, dropped: {} }
      : undefined;
    const out = filterTileLayers(raw, dropped, stripNames, t.z, mobileFilters, collect);
    if (out === null) {
      skipped++;
      continue;
    }
    if (out !== raw) filtered++;
    if (collect) mergeFeatureStats(featureStats, String(t.z), collect);
    entries.push({ t, data: out });
  }

  const mbtilesPath = path.join(PMTILES_DIR, `${base}.mbtiles.tmp`);
  writeMbtiles(mbtilesPath, entries, {
    name: base,
    bbox,
    minZoom,
    maxZoom,
  });
  try {
    await runPmtilesConvert(mbtilesPath, filePath);
  } finally {
    await fs.rm(mbtilesPath, { force: true });
  }
  // Unpacked tiles for the offline map mode (local XYZ serving). Best-effort:
  // a pack without an unpacked dir simply 404s tile requests until rebuilt.
  try {
    await writeUnpackedTiles(base, entries);
  } catch (err) {
    console.error('PMTiles unpacked-tile write failed:', err);
  }

  const fileBuf = await fs.readFile(filePath);
  const manifest: PmtilesManifest = {
    style: 'liberty',
    styleUrl: LIBERTY_STYLE_URL,
    dataDate,
    generatedAt: new Date().toISOString(),
    scope: global ? 'global' : 'country',
    country_code: params.country_code.toUpperCase(),
    bbox,
    minZoom,
    maxZoom,
    layers: params.layers,
    droppedLayers: dropped,
    strippedNames: stripNames,
    masked,
    ...(params.regions && params.regions.length > 0 ? { regions: params.regions } : {}),
    ...(collectStats ? { featureStats } : {}),
    tileCount: entries.length,
    fetched,
    filtered,
    skipped,
    fileSizeBytes: fileBuf.length,
    file: path.basename(filePath),
    sha256: crypto.createHash('sha256').update(fileBuf).digest('hex'),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `PMTiles ${manifest.country_code} z${minZoom}–${maxZoom} (${params.layers}${stripNames ? '+names' : ''}${mobileFilters ? '+mobile' : ''}${masked ? '+mask' : ''}): ${entries.length} tiles, ${(fileBuf.length / 1024 / 1024).toFixed(1)} MB`,
  );
  // Write-through to GCS so cold instances (and GET range serving) survive
  // scale-to-zero. Never fails the export — local disk stays authoritative.
  try {
    const { uploadPmtilesToGcs } = await import('./pmtiles-gcs.ts');
    await uploadPmtilesToGcs(manifest.file);
  } catch (err) {
    console.error('PMTiles GCS write-through failed:', err);
  }
  return { filePath, manifest };
}

/**
 * Build consumer-defined finished packs sequentially — pack by pack, so small
 * Cloud Run instances never hold two conversions in memory. Packs are fully
 * described by the caller (country, bbox, zooms, layers); the server holds
 * no fixed pack list.
 */
export async function prewarmPmtilesPacks(
  packs: ExportPmtilesParams[],
  signal?: AbortSignal,
): Promise<
  { file: string; fileSizeBytes: number; tileCount: number; cached: boolean; ms: number }[]
> {
  const results = [];
  const dataDate = await getPlanetDataDate();
  for (const params of packs) {
    if (signal?.aborted) throw new Error('Aborted');
    const start = Date.now();
    const { minZoom } = resolvePmtilesCover(params);
    const packBbox = isGlobalCode(params.country_code) ? WORLD_BBOX : params.bbox!;
    const before = await fs
      .readFile(
        path.join(
          PMTILES_DIR,
          `${artifactBase(params, minZoom, dataDate, packBbox)}.manifest.json`,
        ),
        'utf8',
      )
      .catch(() => null);
    const { manifest } = await exportPmtiles(params, signal);
    results.push({
      file: manifest.file,
      fileSizeBytes: manifest.fileSizeBytes,
      tileCount: manifest.tileCount,
      cached: before !== null,
      ms: Date.now() - start,
    });
  }
  return results;
}

/**
 * Resolve live boundary bboxes for the prewarm countries via the boundary
 * service itself — one source of truth (`PREWARM_COUNTRIES`), no bbox table
 * to drift. Slow on a cold boundary cache (Geofabrik extract), instant once
 * the boundary Warm step has run, which is why cloudbuild warms boundaries
 * before vectors.
 */
export async function resolveWarmBboxes(
  signal?: AbortSignal,
): Promise<Record<string, [number, number, number, number]>> {
  const { adminBoundaries } = await import('./admin-boundaries.ts');
  const out: Record<string, [number, number, number, number]> = {};
  for (const cc of PREWARM_COUNTRIES) {
    if (signal?.aborted) throw new Error('Aborted');
    const req = new Request('http://localhost/prewarm-bbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country_code: cc }),
      signal,
    });
    const res = (await adminBoundaries(req, cc)) as Response;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Warm bbox failed for ${cc}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const envelope = (await res.json()) as { bbox?: unknown };
    const bbox = envelope?.bbox;
    if (
      !Array.isArray(bbox) ||
      bbox.length < 4 ||
      !bbox.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new Error(`Warm bbox failed for ${cc}: malformed envelope bbox`);
    }
    const [minLon, minLat, maxLon, maxLat] = bbox as number[];
    if (minLon >= maxLon || minLat >= maxLat) {
      throw new Error(`Warm bbox failed for ${cc}: inverted bbox`);
    }
    out[cc] = [minLon, minLat, maxLon, maxLat];
  }
  return out;
}

/**
 * Fill the shared raw source-tile cache for the world base, the Southern
 * Africa top-up and every prewarm country (z4–8, WebP parity). Finished
 * packs are NOT built here — any consumer export afterwards encodes straight
 * from warm disk. Returns what was already cached vs fetched upstream.
 */
export async function prewarmPmtilesCache(signal?: AbortSignal): Promise<{
  tiles: number;
  fetched: number;
  ms: number;
  dataDate: string;
  countries: string[];
}> {
  const start = Date.now();
  const dataDate = await getPlanetDataDate();
  const bboxes = await resolveWarmBboxes(signal);
  const tiles = pmtilesWarmCover(bboxes);
  const { fetched } = await fetchMissingTiles(tiles, dataDate, 'full', signal);
  console.log(
    `PMTiles tile warm: ${tiles.length} tiles (${fetched} fetched), ${(Date.now() - start) / 1000}s`,
  );
  return {
    tiles: tiles.length,
    fetched,
    ms: Date.now() - start,
    dataDate,
    countries: Object.keys(bboxes),
  };
}
