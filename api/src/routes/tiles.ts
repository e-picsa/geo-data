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
  PMTILES_GLOBAL_MAX_ZOOM,
  PMTILES_GLOBAL_DEFAULT_ZOOM,
  PMTILES_COUNTRY_MIN_ZOOM,
  PMTILES_COUNTRY_MAX_ZOOM,
  PMTILES_COUNTRY_DEFAULT_ZOOM,
} from '../services/pmtiles.ts';
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
 * (capped at z6, default z4) with no bbox/buffer inputs; country packs cover
 * the posted bbox starting at z7 (default max z10, cap z12). Deliberately no
 * multi-country packs and no tile buffer — small border-tile duplication
 * across files is accepted.
 */
export const ExportPmtilesSchema = z
  .object({
    country_code: z
      .string()
      .regex(/^(GLOBAL|[a-zA-Z]{2})$/, 'Must be GLOBAL or a 2-letter country code')
      .transform((v: string) => v.toUpperCase())
      .optional()
      .default('GLOBAL'),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    maxZoom: z.number().int().min(0).max(PMTILES_COUNTRY_MAX_ZOOM).optional(),
    layers: z.enum(['full', 'minimal']).optional().default('full'),
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
    } else {
      if (!v.bbox) {
        ctx.addIssue({
          code: 'custom',
          path: ['bbox'],
          message: 'bbox is required for country exports',
        });
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

export interface PreviewTile {
  x: number;
  y: number;
  z: number;
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

      const { filePath, manifest } = await exportPmtiles(
        { country_code, bbox, maxZoom, layers },
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

  return new Response('Not Found', { status: 404, headers: corsHeaders });
};
