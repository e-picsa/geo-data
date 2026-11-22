import fs from 'node:fs/promises';
import path from 'node:path';
import { corsHeaders } from '../utils/cors.ts';
import {
  exportTiles,
  renderLibertyTiles,
  previewBatcher,
  isAbortError,
  LIBERTY_TILES_DIR,
  PREVIEW_DIR_NAME,
  RENDER_VERSION,
  MAX_ZOOM,
} from '../services/map-tiles.ts';
import {
  exportPmtiles,
  isGlobalCode,
  resolvePmtilesCover,
  prewarmPmtilesPacks,
  prewarmPmtilesCache,
  PMTILES_DIR,
  CoverTooLargeError,
  PMTILES_GLOBAL_MAX_ZOOM,
  PMTILES_GLOBAL_DEFAULT_ZOOM,
  PMTILES_COUNTRY_MIN_ZOOM,
  PMTILES_COUNTRY_MAX_ZOOM,
  PMTILES_COUNTRY_DEFAULT_ZOOM,
} from '../services/pmtiles.ts';
import {
  downloadPmtilesFromGcs,
  isGcsPmtilesEnabled,
  listGcsPmtiles,
} from '../services/pmtiles-gcs.ts';
import { getTilesForBbox } from '../utils/tiles.ts';

import { z } from 'zod';

/**
 * Discrete tile buffer — N extra tiles in every direction at each zoom.
 * A tile is much larger in degrees at low zooms, so the geographic padding
 * this yields varies by zoom (see getBufferedBboxForZoom for the preview).
 */
const BufferTilesSchema = z.number().int().min(0).max(8).optional().default(0);

const ZoomSchema = z.number().int().min(0).max(MAX_ZOOM);

export const ExportTilesSchema = z
  .object({
    country_code: z.string().regex(/^[a-zA-Z0-9-_]+$/, 'Invalid country_code format'),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    buffer: BufferTilesSchema,
    minZoom: ZoomSchema.optional().default(0),
    maxZoom: ZoomSchema.optional().default(8),
  })
  .refine((v) => v.minZoom <= v.maxZoom, {
    message: 'minZoom must be <= maxZoom',
    path: ['minZoom'],
  });

/**
 * Vector export (PMTiles). Global packs cover the whole world starting at z0
 * (capped at z6, default z4; use maxZoom 3 for the ~1 MB base) with no
 * bbox/buffer inputs; an optional `regions` array unions extra zoom ranges
 * (e.g. Southern Africa z4–6) into a zero-duplication composite base.
 * Country packs cover the posted bbox starting at `minZoom` (default z4,
 * or z7+ when layered over a composite base) with `maxZoom` capped at z12.
 * Covers are intersected with the in-repo mask (MW/ZM/ZW) when one exists.
 * Deliberately no multi-country packs and no tile buffer — small border-tile
 * duplication across files is accepted.
 */
const PmtilesRegionSchema = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  minZoom: z.number().int().min(0).max(PMTILES_COUNTRY_MAX_ZOOM),
  maxZoom: z.number().int().min(0).max(PMTILES_COUNTRY_MAX_ZOOM),
});

export const ExportPmtilesSchema = z
  .object({
    country_code: z
      .string()
      .regex(/^(GLOBAL|[a-zA-Z]{2})$/, 'Must be GLOBAL or a 2-letter country code')
      .transform((v: string) => v.toUpperCase())
      .optional()
      .default('GLOBAL'),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    minZoom: z
      .number()
      .int()
      .min(PMTILES_COUNTRY_MIN_ZOOM)
      .max(PMTILES_COUNTRY_MAX_ZOOM)
      .optional(),
    maxZoom: z.number().int().min(0).max(PMTILES_COUNTRY_MAX_ZOOM).optional(),
    layers: z.enum(['full', 'minimal', 'mobile']).optional().default('full'),
    regions: z.array(PmtilesRegionSchema).max(8).optional(),
  })
  .superRefine((v, ctx) => {
    if (isGlobalCode(v.country_code)) {
      if (v.maxZoom !== undefined && v.maxZoom > PMTILES_GLOBAL_MAX_ZOOM) {
        ctx.addIssue({
          code: 'custom',
          path: ['maxZoom'],
          message: `Global exports are capped at zoom ${PMTILES_GLOBAL_MAX_ZOOM}`,
        });
      }
      if (v.regions) {
        v.regions.forEach((r, i) => {
          const [minLon, minLat, maxLon, maxLat] = r.bbox;
          const sane =
            [minLon, minLat, maxLon, maxLat].every(
              (n) => Number.isFinite(n) && Math.abs(n) <= 180,
            ) &&
            Math.abs(minLat) <= 90 &&
            Math.abs(maxLat) <= 90;
          if (!sane || minLon >= maxLon || minLat >= maxLat) {
            ctx.addIssue({
              code: 'custom',
              path: ['regions', i, 'bbox'],
              message: 'region bbox must be [minLon, minLat, maxLon, maxLat] within world bounds',
            });
          }
          if (r.minZoom > r.maxZoom) {
            ctx.addIssue({
              code: 'custom',
              path: ['regions', i, 'minZoom'],
              message: 'region minZoom must be <= maxZoom',
            });
          }
        });
      }
    } else {
      if (!v.bbox) {
        ctx.addIssue({
          code: 'custom',
          path: ['bbox'],
          message: 'bbox is required for country exports',
        });
      } else {
        const [minLon, minLat, maxLon, maxLat] = v.bbox;
        const sane =
          [minLon, minLat, maxLon, maxLat].every((n) => Number.isFinite(n) && Math.abs(n) <= 180) &&
          Math.abs(minLat) <= 90 &&
          Math.abs(maxLat) <= 90;
        if (!sane) {
          ctx.addIssue({
            code: 'custom',
            path: ['bbox'],
            message: 'bbox must be [minLon, minLat, maxLon, maxLat] within world bounds',
          });
        } else if (minLon >= maxLon || minLat >= maxLat) {
          ctx.addIssue({
            code: 'custom',
            path: ['bbox'],
            message: 'bbox min values must be less than max values',
          });
        }
      }
      if (
        v.maxZoom !== undefined &&
        (v.maxZoom < PMTILES_COUNTRY_MIN_ZOOM || v.maxZoom > PMTILES_COUNTRY_MAX_ZOOM)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['maxZoom'],
          message: `Country exports support zoom ${PMTILES_COUNTRY_MIN_ZOOM}–${PMTILES_COUNTRY_MAX_ZOOM}`,
        });
      }
      if (v.minZoom !== undefined && v.maxZoom !== undefined && v.minZoom > v.maxZoom) {
        ctx.addIssue({
          code: 'custom',
          path: ['minZoom'],
          message: 'minZoom must be <= maxZoom',
        });
      }
      if (v.regions && v.regions.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['regions'],
          message: 'regions are only supported for GLOBAL exports',
        });
      }
    }
  });
/**
 * Fire-and-forget cache warming, kept cheap by design: renders leak into the
 * same per-country dir the export reads, so a later export only renders the
 * delta. Capped at z8 — deeper zooms are explicitly requested via export.
 */
export const PREWARM_MAX_ZOOM = 8;

export const PrewarmTilesSchema = z.object({
  country_code: z.string().regex(/^[a-zA-Z0-9-_]+$/, 'Invalid country_code format'),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  buffer: BufferTilesSchema,
  maxZoom: z
    .number()
    .int()
    .max(PREWARM_MAX_ZOOM, `Prewarm is capped at zoom ${PREWARM_MAX_ZOOM}`)
    .optional()
    .default(PREWARM_MAX_ZOOM),
});

/**
 * Vector prewarm, two modes. With posted `packs`: builds those consumer-defined
 * finished artifacts (each reuses the export schema, so prewarm and export can
 * never disagree). With no packs (default): fills the shared raw source-tile
 * cache for the world base, the Southern Africa top-up and every
 * `PREWARM_COUNTRIES` entry at z4–8, so any later export builds fast from disk.
 */
export const PrewarmPmtilesSchema = z.object({
  packs: z.array(ExportPmtilesSchema).max(8).optional(),
});

export interface PreviewTile {
  x: number;
  y: number;
  z: number;
}

/**
 * Parse an HTTP `Range: bytes=start-end` header against a known size (pure —
 * safe to unit test). Supports `start-`, `start-end` and suffix `-n` forms;
 * returns null when unsatisfiable or malformed (caller replies 416).
 */
export function parseRangeHeader(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end >= size) {
    return null;
  }
  if (start > end) return null;
  return { start, end };
}

/** Pack filenames are hash-derived, never user paths: strict allowlist. */
export function isSafePmtilesFile(file: string): boolean {
  if (file !== path.basename(file)) return false;
  return /^[A-Za-z0-9_.-]+\.(pmtiles|manifest\.json)$/.test(file);
}

/**
 * Parse + validate a `/tiles/liberty/{z}/{x}/{y}.webp` path.
 * Returns the tile or an error message (pure — safe to unit test).
 */
export function parsePreviewTilePath(pathname: string): { tile: PreviewTile } | { error: string } {
  const match = pathname.match(/^\/tiles\/liberty\/(\d+)\/(\d+)\/(\d+)\.webp$/);
  if (!match) return { error: 'Not Found' };
  const z = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  if (z > MAX_ZOOM) return { error: `Zoom level restricted to ${MAX_ZOOM} (mirrors export cap)` };
  const limit = Math.pow(2, z);
  if (x >= limit || y >= limit) return { error: `Tile out of range for zoom ${z}` };
  return { tile: { x, y, z } };
}

const previewTileResponseHeaders = {
  ...corsHeaders,
  'Content-Type': 'image/webp',
  'Cache-Control': 'public, max-age=86400',
};

async function handlePreviewTile(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const parsed = parsePreviewTilePath(pathname);
  if (!('tile' in parsed)) {
    // Only claim paths under our namespace; otherwise fall through to 404.
    if (pathname.startsWith('/tiles/')) {
      const status = parsed.error === 'Not Found' ? 404 : 400;
      return new Response(JSON.stringify({ error: parsed.error }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return null;
  }
  const { x, y, z } = parsed.tile;
  try {
    const previewDir = path.join(LIBERTY_TILES_DIR, PREVIEW_DIR_NAME);
    // Screenfuls of tiles coalesce into one sidecar run (see previewBatcher).
    const { failed } = await previewBatcher.render(previewDir, { x, y, z }, req.signal);
    // MapLibre cancels stale tiles on every pan — a disconnect, not an error.
    if (req.signal.aborted) {
      console.debug(`Preview tile ${z}/${x}/${y}: client disconnected`);
      return new Response(null, { status: 499, headers: corsHeaders });
    }
    if (failed.length > 0) {
      return new Response(JSON.stringify({ error: `Failed to render tile ${z}/${x}/${y}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const filePath = path.join(previewDir, String(z), String(x), `${y}.webp`);
    // Weak ETag covers renderer version + file identity, so re-rendered tiles
    // (after cache clears or renderer fixes) always invalidate browser caches.
    const stat = await fs.stat(filePath);
    const etag = `W/"v${RENDER_VERSION}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: corsHeaders });
    }
    const data = await fs.readFile(filePath);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { ...previewTileResponseHeaders, ETag: etag },
    });
  } catch (err: unknown) {
    if (isAbortError(err) || req.signal.aborted) {
      console.debug(`Preview tile request aborted: ${pathname}`);
      return new Response(null, { status: 499, headers: corsHeaders });
    }
    console.error('Error rendering preview tile:', err);
    const message = err instanceof Error ? err.message : 'An unknown error occurred';
    return new Response(JSON.stringify({ status: 'error', message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export const handleTileRoutes = async (req: Request, pathname: string): Promise<Response> => {
  const preview = await handlePreviewTile(req, pathname);
  if (preview) return preview;

  if (req.method === 'POST' && pathname === '/prewarm-tiles') {
    try {
      const body = await req.json();
      const parseResult = PrewarmTilesSchema.safeParse(body);

      if (!parseResult.success) {
        return new Response(
          JSON.stringify({
            error:
              parseResult.error.issues.map((issue) => issue.message).join(', ') ??
              'Invalid request data',
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const { country_code, bbox, buffer, maxZoom } = parseResult.data;
      const [minLon, minLat, maxLon, maxLat] = bbox;
      const requiredTiles = [];
      for (let z = 0; z <= maxZoom; z++) {
        requiredTiles.push(...getTilesForBbox(minLon, minLat, maxLon, maxLat, z, buffer));
      }

      const countryDir = path.join(LIBERTY_TILES_DIR, country_code);
      const { rendered, failed } = await renderLibertyTiles(countryDir, requiredTiles, req.signal);
      return new Response(
        JSON.stringify({
          status: 'ok',
          country_code,
          maxZoom,
          tileCount: requiredTiles.length,
          rendered,
          cached: requiredTiles.length - rendered - failed.length,
          failed: failed.length,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    } catch (err: unknown) {
      if (isAbortError(err) || req.signal.aborted) {
        console.debug('Prewarm cancelled by client');
        return new Response(null, { status: 499, headers: corsHeaders });
      }
      console.error('Error prewarming tiles:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  if (req.method === 'POST' && pathname === '/export-tiles') {
    try {
      const body = await req.json();
      const parseResult = ExportTilesSchema.safeParse(body);

      if (!parseResult.success) {
        return new Response(
          JSON.stringify({
            error:
              parseResult.error.issues.map((issue) => issue.message).join(', ') ??
              'Invalid request data',
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const { country_code, bbox, buffer, minZoom, maxZoom } = parseResult.data;

      const archiveStream = await exportTiles(
        { country_code, bbox, buffer, minZoom, maxZoom },
        req.signal,
      );

      return new Response(archiveStream, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${country_code}-tiles.tar.gz"`,
        },
      });
    } catch (err: unknown) {
      if (isAbortError(err) || req.signal.aborted) {
        console.debug('Tiles export cancelled by client');
        return new Response(null, { status: 499, headers: corsHeaders });
      }
      console.error('Error generating tiles archive:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  if (req.method === 'POST' && pathname === '/export-pmtiles') {
    try {
      const body = await req.json();
      const parseResult = ExportPmtilesSchema.safeParse(body);

      if (!parseResult.success) {
        return new Response(
          JSON.stringify({
            error:
              parseResult.error.issues.map((issue) => issue.message).join(', ') ??
              'Invalid request data',
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const { country_code, bbox, layers } = parseResult.data;
      const global = isGlobalCode(country_code);
      const maxZoom =
        parseResult.data.maxZoom ??
        (global ? PMTILES_GLOBAL_DEFAULT_ZOOM : PMTILES_COUNTRY_DEFAULT_ZOOM);
      const minZoom = global ? undefined : parseResult.data.minZoom;
      const regions = global ? parseResult.data.regions : undefined;

      // Reject planet-scale covers before any fetching/rendering starts
      // (resolve throws instead of materializing tens of millions of tiles).
      try {
        resolvePmtilesCover({ country_code, bbox, minZoom, maxZoom, layers, regions });
      } catch (err) {
        if (err instanceof CoverTooLargeError) {
          return new Response(
            JSON.stringify({ error: `${err.message} — reduce maxZoom or narrow the bbox.` }),
            {
              status: 400,
              headers: corsHeaders,
            },
          );
        }
        throw err;
      }

      const { filePath, manifest } = await exportPmtiles(
        { country_code, bbox, minZoom, maxZoom, layers, regions },
        req.signal,
      );

      return new Response(Bun.file(filePath), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${manifest.file}"`,
          'X-PMTiles-Sha256': manifest.sha256,
          'X-PMTiles-Bytes': String(manifest.fileSizeBytes),
        },
      });
    } catch (err: unknown) {
      if (isAbortError(err) || req.signal.aborted) {
        console.debug('PMTiles export cancelled by client');
        return new Response(null, { status: 499, headers: corsHeaders });
      }
      console.error('Error generating pmtiles archive:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  if (req.method === 'POST' && pathname === '/prewarm-pmtiles') {
    try {
      const body = await req.json().catch(() => ({}));
      const parseResult = PrewarmPmtilesSchema.safeParse(body);
      if (!parseResult.success) {
        return new Response(
          JSON.stringify({
            error:
              parseResult.error.issues.map((issue) => issue.message).join(', ') ??
              'Invalid request data',
          }),
          { status: 400, headers: corsHeaders },
        );
      }
      const packs = parseResult.data.packs;
      // Explicit packs: build consumer-defined finished artifacts (cap-checked).
      if (packs && packs.length > 0) {
        try {
          for (const p of packs) resolvePmtilesCover(p);
        } catch (err) {
          if (err instanceof CoverTooLargeError) {
            return new Response(JSON.stringify({ error: err.message }), {
              status: 400,
              headers: corsHeaders,
            });
          }
          throw err;
        }
        const results = await prewarmPmtilesPacks(packs, req.signal);
        return new Response(JSON.stringify({ status: 'ok', mode: 'packs', packs: results }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Default: fill the shared source-tile cache (world z0–3, SA z4–6,
      // prewarm countries z4–8) so any consumer export builds fast. No
      // finished packs, no fixed recipes.
      const warm = await prewarmPmtilesCache(req.signal);
      return new Response(JSON.stringify({ status: 'ok', mode: 'tiles', ...warm }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      if (isAbortError(err) || req.signal.aborted) {
        console.debug('PMTiles prewarm cancelled by client');
        return new Response(null, { status: 499, headers: corsHeaders });
      }
      console.error('Error prewarming pmtiles packs:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  if (req.method === 'GET' && pathname === '/pmtiles') {
    try {
      const entries: Record<string, { manifest: unknown; local: boolean; gcs: boolean }> = {};
      let localFiles: string[] = [];
      try {
        localFiles = await fs.readdir(PMTILES_DIR);
      } catch {
        /* no local packs yet */
      }
      for (const f of localFiles.filter((f) => f.endsWith('.manifest.json'))) {
        try {
          entries[f] = {
            manifest: JSON.parse(await fs.readFile(path.join(PMTILES_DIR, f), 'utf8')),
            local: true,
            gcs: false,
          };
        } catch {
          /* unreadable manifest — skip */
        }
      }
      if (isGcsPmtilesEnabled()) {
        for (const item of await listGcsPmtiles()) {
          if (!item.key.endsWith('.manifest.json')) continue;
          if (entries[item.key]) {
            entries[item.key].gcs = true;
            continue;
          }
          try {
            const headers = await (await import('../utils/google-auth.ts')).getAuthHeaders();
            const res = await fetch(
              `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(process.env.CACHE_BUCKET!.trim())}/o/${encodeURIComponent('pmtiles/' + item.key)}?alt=media`,
              { headers },
            );
            if (res.ok) {
              entries[item.key] = { manifest: await res.json(), local: false, gcs: true };
            }
          } catch {
            /* unreadable remote manifest — skip */
          }
        }
      }
      return new Response(JSON.stringify({ status: 'ok', packs: Object.values(entries) }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      console.error('Error listing pmtiles packs:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // Range-served pack bytes for MapLibre pmtiles.js clients + downloads.
  // Local disk first; GCS warms local disk on a miss so the next hit is local.
  const pmtilesFileMatch = pathname.match(/^\/pmtiles\/(.+)$/);
  if (req.method === 'GET' && pmtilesFileMatch) {
    const file = decodeURIComponent(pmtilesFileMatch[1]);
    if (!isSafePmtilesFile(file)) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    try {
      const localPath = path.join(PMTILES_DIR, file);
      let buf: Uint8Array | null = null;
      try {
        buf = new Uint8Array(await fs.readFile(localPath));
      } catch {
        buf = null;
      }
      if (buf === null) {
        // Cold instance: pull from GCS into local disk, then serve.
        const bytes = await downloadPmtilesFromGcs(file);
        if (bytes === null) {
          return new Response(JSON.stringify({ error: 'Not Found' }), {
            status: 404,
            headers: corsHeaders,
          });
        }
        buf = new Uint8Array(await fs.readFile(localPath));
      }
      const size = buf.length;
      const isManifest = file.endsWith('.json');
      const baseHeaders = {
        ...corsHeaders,
        'Content-Type': isManifest ? 'application/json' : 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        ...(file.endsWith('.pmtiles')
          ? { 'Content-Disposition': `attachment; filename="${file}"` }
          : {}),
      };
      const range = parseRangeHeader(req.headers.get('range'), size);
      if (req.headers.get('range') && !range) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
        });
      }
      if (!range) {
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(size) },
        });
      }
      const slice = buf.slice(range.start, range.end + 1);
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    } catch (err: unknown) {
      console.error('Error serving pmtiles file:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
};
