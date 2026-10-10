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

/**
 * Thrown when the HTTP client disconnects mid-render. Interactive map
 * clients (MapLibre) cancel stale tile requests on every pan/zoom, so this
 * is routine — not a renderer failure.
 */
export class RenderAbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'RenderAbortedError';
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof RenderAbortedError ||
    (err instanceof Error && (err.name === 'AbortError' || err.message === 'Aborted'))
  );
}

export async function renderLibertyTiles(
  outDir: string,
  tiles: { x: number; y: number; z: number }[],
  signal?: AbortSignal,
): Promise<{ rendered: number; failed: { x: number; y: number; z: number }[] }> {
  const run = renderQueue.then(() => {
    // A request aborted while queued must not burn a sidecar: skip it here
    // (an already-fired signal never re-fires the inner abort listener).
    if (signal?.aborted) {
      console.debug('Skipping Liberty render: request already aborted');
      throw new RenderAbortedError();
    }
    return renderLibertyTilesInner(outDir, tiles, signal);
  });
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
  } catch (err) {
    // Abort-kills (exit 143) are client disconnects, not renderer failures.
    if (signal?.aborted || isAbortError(err)) {
      console.debug(`Liberty render aborted (${missing.length} tiles outstanding)`);
      throw new RenderAbortedError();
    }
    throw err;
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

export interface LibertyTile {
  x: number;
  y: number;
  z: number;
}

export interface LibertyRenderResult {
  rendered: number;
  failed: LibertyTile[];
}

const PREVIEW_BATCH_WINDOW_MS = 250;
/** A screenful of 256px tiles — flush immediately instead of waiting out the window. */
const PREVIEW_BATCH_MAX_TILES = 16;

/**
 * Coalesce concurrent single-tile preview requests into one sidecar run.
 * Interactive panning fires a screenful of tiles near-simultaneously, and one
 * MapLibre instance rendering N tiles is far cheaper than N sequential
 * startups (style parse + remote fetches amortized once).
 *
 * Batch renders are intentionally unabortable (short-lived): per-request
 * disconnects settle when the batch completes, and already-aborted jobs never
 * trigger a run. Exports/prewarm keep calling renderLibertyTiles directly
 * with their abort signals intact.
 */
export function createPreviewBatcher(
  runBatch: (outDir: string, tiles: LibertyTile[]) => Promise<LibertyRenderResult>,
  opts?: { windowMs?: number; maxTiles?: number },
) {
  interface Pending {
    outDir: string;
    tile: LibertyTile;
    signal?: AbortSignal;
    resolve: (r: LibertyRenderResult) => void;
    reject: (e: unknown) => void;
  }
  const windowMs = opts?.windowMs ?? PREVIEW_BATCH_WINDOW_MS;
  const maxTiles = opts?.maxTiles ?? PREVIEW_BATCH_MAX_TILES;
  let pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const jobs = pending;
    pending = [];
    const byDir = new Map<string, Pending[]>();
    for (const j of jobs) {
      const group = byDir.get(j.outDir) ?? [];
      group.push(j);
      byDir.set(j.outDir, group);
    }
    for (const [outDir, group] of byDir) {
      const live = group.filter((j) => !j.signal?.aborted);
      for (const j of group) {
        if (j.signal?.aborted) j.resolve({ rendered: 0, failed: [j.tile] });
      }
      if (live.length === 0) continue;
      runBatch(
        outDir,
        live.map((j) => j.tile),
      ).then(
        (res) => {
          const failedSet = new Set(res.failed.map((t) => `${t.z}/${t.x}/${t.y}`));
          for (const j of live) {
            const key = `${j.tile.z}/${j.tile.x}/${j.tile.y}`;
            // Per-job render counts are meaningless for a shared batch; the
            // preview caller only needs to know its tile is on disk or not.
            j.resolve(
              failedSet.has(key) ? { rendered: 0, failed: [j.tile] } : { rendered: 0, failed: [] },
            );
          }
        },
        (err) => {
          for (const j of live) j.reject(err);
        },
      );
    }
  };

  return {
    render(outDir: string, tile: LibertyTile, signal?: AbortSignal): Promise<LibertyRenderResult> {
      return new Promise<LibertyRenderResult>((resolve, reject) => {
        pending.push({ outDir, tile, signal, resolve, reject });
        if (pending.length >= maxTiles) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          flush();
        } else if (!timer) {
          timer = setTimeout(flush, windowMs);
        }
      });
    },
    /** Drain pending jobs immediately (used in tests). */
    flush,
  };
}

export const previewBatcher = createPreviewBatcher((outDir, tiles) =>
  renderLibertyTiles(outDir, tiles),
);

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
