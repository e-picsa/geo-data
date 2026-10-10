import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import vtPbf from 'vt-pbf';
import { getTilesForBbox, getTileRangeForBbox } from '../utils/tiles.ts';
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

export const PMTILES_VERSION = 1;
export const PMTILES_GLOBAL_MAX_ZOOM = 6;
export const PMTILES_GLOBAL_DEFAULT_ZOOM = 4;
export const PMTILES_COUNTRY_MIN_ZOOM = 7;
export const PMTILES_COUNTRY_MAX_ZOOM = 12;
export const PMTILES_COUNTRY_DEFAULT_ZOOM = 8;

/**
 * Hard cap on tiles per export. A world-sized bbox at z7–12 would otherwise
 * resolve to ~22M tiles (enormous fetch/memory/SQLite work); real countries
 * stay far below this (Malawi z7–12 ≈ 5k, DRC ≈ 60k).
 */
export const MAX_PMTILES_TILES = 100_000;

export const PMTILES_DIR = path.join(process.cwd(), '.cache', 'pmtiles');
/** Raw upstream PBFs, cached by planet vintage so exports survive data updates. */
export const PMTILES_SOURCE_DIR = path.join(process.cwd(), '.cache', 'pmtiles-source');

export const WORLD_BBOX: [number, number, number, number] = [-180, -85.0511, 180, 85.0511];

export type PmtilesLayersPreset = 'full' | 'minimal';

/**
 * Layers dropped by the `minimal` preset. Per the upstream TileJSON these
 * first appear at: aerodrome_label z8, aeroway z10, poi z11, building z13,
 * housenumber z14 — so `minimal` is byte-identical to `full` for the global
 * z0–6 pack and only shrinks country z10–12 tiles (where POIs/aeroways join).
 */
export const MINIMAL_DROPPED_LAYERS = [
  'building',
  'housenumber',
  'poi',
  'aeroway',
  'aerodrome_label',
];

/** Layers that must always survive filtering (guards preset regressions). */
const CORE_LAYERS = ['boundary', 'place', 'water', 'transportation'];

export interface ExportPmtilesParams {
  country_code: string;
  /** Required for countries; ignored for GLOBAL (world cover). */
  bbox?: [number, number, number, number];
  maxZoom: number;
  layers: PmtilesLayersPreset;
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

/**
 * Resolve the zoom range + tile cover for an export (pure — unit tested).
 * Global always starts at z0; country packs start at z7 (the app layers them
 * over the bundled global base, which owns z0–6).
 */
export function resolvePmtilesCover(params: ExportPmtilesParams): {
  minZoom: number;
  maxZoom: number;
  tiles: TileCoord[];
} {
  const global = isGlobalCode(params.country_code);
  const minZoom = global ? 0 : PMTILES_COUNTRY_MIN_ZOOM;
  const maxZoom = params.maxZoom;
  const bbox = global ? WORLD_BBOX : params.bbox!;
  // Count before materializing: a planet-scale cover must throw instead of
  // exploding the call stack / heap via array spread.
  const count = countPmtilesTiles(bbox, minZoom, maxZoom);
  if (count > MAX_PMTILES_TILES) throw new CoverTooLargeError(count);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const tiles: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    tiles.push(...getTilesForBbox(minLon, minLat, maxLon, maxLat, z, 0));
  }
  return { minZoom, maxZoom, tiles };
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
 * Strip denied layers from a raw MVT buffer. Returns the original bytes when
 * nothing was dropped (passthrough, no recompression drift), gzip-compressed
 * re-encoded bytes when layers were removed, or null when no layers remain.
 */
export function filterTileLayers(raw: Uint8Array, dropped: string[]): Uint8Array | null {
  if (dropped.length === 0) return raw;
  const tile = decodeTile(raw);
  const kept: Record<string, any> = {};
  let droppedAny = false;
  for (const name of Object.keys(tile.layers)) {
    if (dropped.includes(name)) {
      droppedAny = true;
      continue;
    }
    kept[name] = tile.layers[name];
  }
  if (!droppedAny) return raw;
  if (Object.keys(kept).length === 0) return null;
  return gzipSync(vtPbf({ layers: kept }));
}

/** Guard: presets must never drop the core rendering layers. */
export function droppedLayersFor(preset: PmtilesLayersPreset): string[] {
  const dropped = preset === 'minimal' ? [...MINIMAL_DROPPED_LAYERS] : [];
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
  // must not serve a stale cached artifact.
  const bboxHash = crypto
    .createHash('sha256')
    .update(bbox.map((n) => n.toFixed(4)).join(','))
    .digest('hex')
    .slice(0, 8);
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

export async function exportPmtiles(
  params: ExportPmtilesParams,
  signal?: AbortSignal,
): Promise<{ filePath: string; manifest: PmtilesManifest }> {
  const global = isGlobalCode(params.country_code);
  const dataDate = await getPlanetDataDate();
  const { minZoom, maxZoom, tiles } = resolvePmtilesCover(params);
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
      return { filePath, manifest: JSON.parse(cached) as PmtilesManifest };
    } catch {
      /* manifest without artifact — rebuild */
    }
  } catch {
    /* cache miss — build */
  }

  const { fetched } = await fetchMissingTiles(tiles, dataDate, 'full', signal);

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
    const out = filterTileLayers(raw, dropped);
    if (out === null) {
      skipped++;
      continue;
    }
    if (out !== raw) filtered++;
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
    `PMTiles ${manifest.country_code} z${minZoom}–${maxZoom} (${params.layers}): ${entries.length} tiles, ${(fileBuf.length / 1024 / 1024).toFixed(1)} MB`,
  );
  return { filePath, manifest };
}
