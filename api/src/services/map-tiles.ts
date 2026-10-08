import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { getTilesForBbox } from '../utils/tiles.ts';

export const LIBERTY_STYLE_ID = 'liberty';
export const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const PLANET_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Disk cache is namespaced per style (replaces the legacy OSM-carto cache). */
const TILES_DIR = path.join(process.cwd(), '.cache', 'tiles', LIBERTY_STYLE_ID);

/** Hard limit — never generate tiles above this zoom level (bundle size). */
const MAX_ZOOM = 8;

const RENDERER_SCRIPT = path.join(import.meta.dir, 'render-liberty-tiles.mjs');

interface ExportTilesParams {
  country_code: string;
  bbox: [number, number, number, number];
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
  minZoom: number;
  maxZoom: number;
  tileCount: number;
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
  meta: Pick<TileManifest, 'country_code' | 'minZoom' | 'maxZoom' | 'dataDate'>,
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
    minZoom: meta.minZoom,
    maxZoom: meta.maxZoom,
    tileCount: tiles.length,
    tiles,
    sha256,
  };
}

/**
 * Render missing tiles via the Node sidecar (see render-liberty-tiles.mjs).
 * The sidecar reuses a single MapLibre Native instance, so rendering is
 * sequential; missing-file skips keep repeat exports fast.
 */
async function renderMissingTiles(
  countryDir: string,
  tiles: { x: number; y: number; z: number }[],
  signal?: AbortSignal,
): Promise<void> {
  const missing: { x: number; y: number; z: number }[] = [];
  for (const t of tiles) {
    try {
      await fs.access(path.join(countryDir, String(t.z), String(t.x), `${t.y}.webp`));
    } catch {
      missing.push(t);
    }
  }
  if (missing.length === 0) {
    console.log('All tiles already cached, skipping render.');
    return;
  }
  console.log(`Rendering ${missing.length} Liberty tiles...`);

  const jobFile = path.join(countryDir, '.render-job.json');
  await fs.mkdir(countryDir, { recursive: true });
  await fs.writeFile(jobFile, JSON.stringify({ styleUrl: LIBERTY_STYLE_URL, tiles: missing }));

  // MapLibre Native needs an X display on Linux even for offscreen rendering —
  // the production image provides it via xvfb (macOS needs no wrapper).
  const command =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', 'node', RENDERER_SCRIPT, '--tiles', jobFile, '--out-dir', countryDir]
      : ['node', RENDERER_SCRIPT, '--tiles', jobFile, '--out-dir', countryDir];
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const abortListener = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  signal?.addEventListener('abort', abortListener);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  signal?.removeEventListener('abort', abortListener);
  await fs.rm(jobFile, { force: true });

  if (stderr.trim()) console.error(`[renderer] ${stderr.trim()}`);
  if (exitCode !== 0) {
    throw new Error(
      `Tile renderer exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  try {
    const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
      rendered?: number;
      failed?: unknown[];
    };
    console.log(
      `Rendered ${summary.rendered ?? '?'} tiles (${summary.failed?.length ?? '?'} failed).`,
    );
  } catch {
    console.log(`Renderer output: ${stdout.trim()}`);
  }
}

export async function exportTiles(
  params: ExportTilesParams,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const { country_code, bbox, minZoom } = params;

  const maxZoom = Math.min(params.maxZoom, MAX_ZOOM);

  const [minLon, minLat, maxLon, maxLat] = bbox;
  console.log(`Bounding box for ${country_code}: [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`);

  // Generate all required tiles
  const requiredTiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    requiredTiles.push(...getTilesForBbox(minLon, minLat, maxLon, maxLat, z));
  }

  console.log(
    `Need to render ${requiredTiles.length} Liberty tiles for ${country_code} (z${minZoom}–${maxZoom})...`,
  );

  await fs.mkdir(TILES_DIR, { recursive: true });
  const countryDir = path.join(TILES_DIR, country_code);

  await renderMissingTiles(countryDir, requiredTiles, signal);

  // Manifest keeps app and tiles from silently drifting out of sync
  const manifest = await buildManifest(countryDir, {
    country_code,
    minZoom,
    maxZoom,
    dataDate: await getPlanetDataDate(),
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
