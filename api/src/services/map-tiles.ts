import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { getTilesForBbox } from '../utils/tiles.ts';

export const LIBERTY_STYLE_ID = 'liberty';
export const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const PLANET_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Bump when renderer output changes so stale (mis-rendered) tiles are never served. */
export const RENDER_VERSION = 2;

/** Disk cache is namespaced per style + renderer version. */
export const LIBERTY_TILES_DIR = path.join(
  process.cwd(),
  '.cache',
  'tiles',
  `${LIBERTY_STYLE_ID}-v${RENDER_VERSION}`,
);

/** Preview tiles share the style cache but live outside per-country export dirs. */
export const PREVIEW_DIR_NAME = '__preview__';

/** Hard limit — exports above this zoom level are rejected (bundle size). */
export const MAX_ZOOM = 12;

const RENDERER_SCRIPT = path.join(import.meta.dir, 'render-liberty-tiles.mjs');

interface ExportTilesParams {
  country_code: string;
  bbox: [number, number, number, number];
  /** Extra tiles in every direction at each zoom (discrete tile buffer). */
  buffer?: number;
  minZoom: number;
  maxZoom: number;
}

export interface TileManifest {
  style: string;
  styleUrl: string;
  /** planet data vintage, parsed from the OpenFreeMap TileJSON (e.g. 20261004_113936_pt) */
  dataDate: string;
  generatedAt: string;
  country_code: string;
  /** Requested export bbox [minLon, minLat, maxLon, maxLat] (unbuffered). */
  bbox: [number, number, number, number];
  /** Extra tiles exported in every direction at each zoom. */
  buffer: number;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  /** Tiles rendered during this export — 0 means fully served from cache. */
  rendered: number;
  tiles: string[];
  /** sha256 over sorted `path:filehash` lines — app and tiles cannot silently drift */
  sha256: string;
}

/** Fetch the planet vintage tag (cached per process). Falls back to 'unknown'. */
let cachedDataDate: string | null = null;
export async function getPlanetDataDate(): Promise<string> {
  if (cachedDataDate) return cachedDataDate;
  try {
    const res = await fetch(PLANET_TILEJSON_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const tilejson = (await res.json()) as { tiles?: string[] };
    const match = tilejson.tiles?.[0]?.match(/\/planet\/([^/]+)\//);
    cachedDataDate = match?.[1] ?? 'unknown';
  } catch (err) {
    console.warn(`Could not determine planet data date: ${err}, using 'unknown'`);
    cachedDataDate = 'unknown';
  }
  return cachedDataDate;
}

/** Build a manifest for the rendered country dir (pure — safe to unit test). */
export async function buildManifest(
  countryDir: string,
  meta: Pick<TileManifest, 'country_code' | 'minZoom' | 'maxZoom' | 'dataDate' | 'rendered'> &
    Partial<Pick<TileManifest, 'bbox' | 'buffer'>>,
): Promise<TileManifest> {
  const entries: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const names = await fs.readdir(dir);
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(full, rel);
      } else if (name.endsWith('.webp')) {
        const hash = crypto
          .createHash('sha256')
          .update(await fs.readFile(full))
          .digest('hex');
        entries.push(`${rel}:${hash}`);
      }
    }
  };
  await walk(countryDir, '');
  const tiles = entries.map((e) => e.split(':')[0]).sort();
  const sha256 = crypto
    .createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex');
  return {
    style: LIBERTY_STYLE_ID,
    styleUrl: LIBERTY_STYLE_URL,
    dataDate: meta.dataDate,
    generatedAt: new Date().toISOString(),
    country_code: meta.country_code,
    bbox: meta.bbox ?? ([0, 0, 0, 0] as [number, number, number, number]),
    buffer: meta.buffer ?? 0,
    minZoom: meta.minZoom,
    maxZoom: meta.maxZoom,
    tileCount: tiles.length,
    rendered: meta.rendered,
    tiles,
    sha256,
  };
}

/**
 * Render missing tiles via the Node sidecar (see render-liberty-tiles.mjs).
 * The sidecar reuses a single MapLibre Native instance, so rendering is
 * sequential; missing-file skips keep repeat exports fast.
 * Returns counts for logging/telemetry.
 *
 * Calls are serialized through a process-wide queue: each sidecar holds a full
 * MapLibre instance, so concurrent exports + preview tiles would otherwise
 * multiply memory (a real risk on small Cloud Run instances).
 */
let renderQueue: Promise<unknown> = Promise.resolve();
export async function renderLibertyTiles(
  outDir: string,
  tiles: { x: number; y: number; z: number }[],
  signal?: AbortSignal,
): Promise<{ rendered: number; failed: { x: number; y: number; z: number }[] }> {
  const run = renderQueue.then(() => renderLibertyTilesInner(outDir, tiles, signal));
  // Keep the queue alive across failures; callers still see their own error.
  renderQueue = run.catch(() => {});
  return run;
}

async function renderLibertyTilesInner(
  outDir: string,
  tiles: { x: number; y: number; z: number }[],
  signal?: AbortSignal,
): Promise<{ rendered: number; failed: { x: number; y: number; z: number }[] }> {
  const missing: { x: number; y: number; z: number }[] = [];
  for (const t of tiles) {
    try {
      await fs.access(path.join(outDir, String(t.z), String(t.x), `${t.y}.webp`));
    } catch {
      missing.push(t);
    }
  }
  if (missing.length === 0) {
    return { rendered: 0, failed: [] };
  }

  // Shard across worker sidecars: one MapLibre instance runs ~200MB, so tier
  // workers by job size (override with RENDER_WORKERS for small instances).
  const workers = workerCount(missing.length);
  const shards = splitIntoChunks(missing, workers);
  console.log(`Rendering ${missing.length} Liberty tiles with ${shards.length} worker(s)...`);
  await fs.mkdir(outDir, { recursive: true });

  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const abortListener = () => {
    for (const p of procs) {
      try {
        p.kill();
      } catch {
        /* already exited */
      }
    }
  };
  signal?.addEventListener('abort', abortListener);
  try {
    const results = await Promise.all(
      shards.map((shard, i) => renderShard(outDir, shard, i, procs)),
    );
    const rendered = results.reduce((sum, r) => sum + r.rendered, 0);
    const failed = results.flatMap((r) => r.failed);
    console.log(`Rendered ${rendered} tiles (${failed.length} failed).`);
    return { rendered, failed };
  } finally {
    signal?.removeEventListener('abort', abortListener);
    await Promise.all(
      shards.map((_, i) => fs.rm(path.join(outDir, `.render-job-${i}.json`), { force: true })),
    );
  }
}

/** Tier sidecar workers by job size; RENDER_WORKERS env overrides (e.g. '1' on 512MB instances). */
export function workerCount(tileCount: number): number {
  const override = parseInt(process.env.RENDER_WORKERS ?? '', 10);
  if (Number.isInteger(override) && override > 0) return Math.min(override, 8);
  if (tileCount < 150) return 1;
  if (tileCount < 1000) return 2;
  return 4;
}

/** Split tiles into at most n non-empty round-robin shards (pure — unit tested). */
export function splitIntoChunks<T>(tiles: T[], n: number): T[][] {
  const shards: T[][] = Array.from({ length: Math.max(1, Math.min(n, tiles.length)) }, () => []);
  tiles.forEach((t, i) => shards[i % shards.length].push(t));
  return shards;
}

async function renderShard(
  outDir: string,
  shard: { x: number; y: number; z: number }[],
  index: number,
  procs: ReturnType<typeof Bun.spawn>[],
): Promise<{ rendered: number; failed: { x: number; y: number; z: number }[] }> {
  const jobFile = path.join(outDir, `.render-job-${index}.json`);
  await fs.writeFile(jobFile, JSON.stringify({ styleUrl: LIBERTY_STYLE_URL, tiles: shard }));

  // MapLibre Native needs an X display on Linux even for offscreen rendering —
  // the production image provides it via xvfb (macOS needs no wrapper).
  const command =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', 'node', RENDERER_SCRIPT, '--tiles', jobFile, '--out-dir', outDir]
      : ['node', RENDERER_SCRIPT, '--tiles', jobFile, '--out-dir', outDir];
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr.trim()) console.error(`[renderer:${index}] ${stderr.trim()}`);
  if (exitCode !== 0) {
    throw new Error(
      `Tile renderer ${index} exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  try {
    const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
      rendered?: number;
      failed?: { x: number; y: number; z: number }[];
    };
    return { rendered: summary.rendered ?? 0, failed: summary.failed ?? [] };
  } catch {
    console.log(`Renderer ${index} output: ${stdout.trim()}`);
    return { rendered: shard.length, failed: [] };
  }
}

export async function exportTiles(
  params: ExportTilesParams,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const { country_code, minZoom } = params;
  const buffer = Math.max(0, Math.floor(params.buffer ?? 0));

  const maxZoom = Math.min(params.maxZoom, MAX_ZOOM);

  const [minLon, minLat, maxLon, maxLat] = params.bbox;
  console.log(
    `Bounding box for ${country_code}: [${minLon}, ${minLat}, ${maxLon}, ${maxLat}] (buffer ${buffer} tiles)`,
  );

  // Generate all required tiles (buffer expands the tile cover per zoom)
  const requiredTiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    requiredTiles.push(...getTilesForBbox(minLon, minLat, maxLon, maxLat, z, buffer));
  }

  console.log(
    `Need to render ${requiredTiles.length} Liberty tiles for ${country_code} (z${minZoom}–${maxZoom})...`,
  );

  await fs.mkdir(LIBERTY_TILES_DIR, { recursive: true });
  const countryDir = path.join(LIBERTY_TILES_DIR, country_code);

  const { rendered, failed } = await renderLibertyTiles(countryDir, requiredTiles, signal);
  if (requiredTiles.length > 0 && rendered === 0 && failed.length === 0) {
    console.log('All tiles already cached, skipping render.');
  }

  // Manifest keeps app and tiles from silently drifting out of sync
  const manifest = await buildManifest(countryDir, {
    country_code,
    bbox: params.bbox,
    buffer,
    minZoom,
    maxZoom,
    dataDate: await getPlanetDataDate(),
    rendered,
  });
  await fs.writeFile(path.join(countryDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Manifest: ${manifest.tileCount} tiles, data date ${manifest.dataDate}`);

  // Now tar the directory
  return new ReadableStream({
    start(controller) {
      console.log(`Creating tar.gz archive for ${country_code}...`);

      const tarStream = tar.c(
        {
          gzip: true,
          cwd: countryDir,
        },
        ['.'],
      );

      tarStream.on('data', (data) => {
        controller.enqueue(new Uint8Array(data));
      });

      tarStream.on('end', () => {
        console.log(`Tar archive created successfully for ${country_code}`);
        controller.close();
      });

      tarStream.on('error', (err) => {
        controller.error(err);
      });
    },
  });
}
