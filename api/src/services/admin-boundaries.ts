import mapshaper from 'mapshaper';

import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { validateBody } from '../utils/validation.ts';
import { getCache, type CacheProvider } from '../utils/cache/index.ts';
import { BOUNDARY_REQUEST_SCHEMA } from '../types/schema.ts';
import type { BoundaryRequestParams } from '../types/schema.ts';
import { fetchGeofabrikBoundaries } from './geofabrik';

/**
 * Bust cache if conversion or processing methods change.
 * GCS cache object lifecycle automatically deletes after 90 days.
 *
 * NOTE: The raw Overpass response cache version lives in overpass.ts.
 * This version only covers the derived geojson/topojson artefacts.
 */
const CACHE_VERSION = 1;

type Source = 'cache' | 'generated';

type CachePaths = {
  prefix: string;
  geojson: string;
  topojson: string;
};

type TopojsonSummary = {
  size_kb: number;
  feature_count: number;
  bbox: unknown[];
};

export const adminBoundaries = async (req: Request) => {
  try {
    const params = await validateBody(req, BOUNDARY_REQUEST_SCHEMA);
    const { country_code, admin_level } = params;

    const cache = getCache();
    const paths = buildCachePaths(country_code, admin_level);

    const cachedTopojson = await readCache<any>(cache, paths.topojson);
    if (cachedTopojson) {
      console.log(`TopoJSON cache hit for ${country_code} admin level ${admin_level}.`);
      return buildSuccessResponse(params, 'cache', cachedTopojson);
    }

    const dataSource = 'geofabrik';

    console.log(`Attempting to fetch boundaries from Geofabrik for ${country_code}...`);
    const osmData = await fetchGeofabrikBoundaries({
      countryCode: country_code,
      adminLevel: admin_level,
      signal: req.signal,
    });
    console.log(`Successfully fetched boundaries from Geofabrik for ${country_code}`);

    const topojson = await convertGeoJsonToTopojson(osmData, paths);

    writeTopojsonCache(cache, paths.topojson, topojson);

    return buildSuccessResponse(params, 'generated', topojson, dataSource);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error(typeof error, error);

    const e = error as any;
    const msg =
      typeof e === 'string'
        ? e
        : e?.details || e?.error || e?.message || e?.msg || 'Failed to generate admin boundaries';

    return ErrorResponse(msg);
  }
};

function buildCachePaths(countryCode: string, adminLevel: number): CachePaths {
  const prefix = `derived/v${CACHE_VERSION}/country=${countryCode}/admin_level=${adminLevel}`;

  return {
    prefix,
    geojson: `${prefix}/geojson.json`,
    topojson: `${prefix}/topojson.json`,
  };
}

async function readCache<T>(cache: CacheProvider, key: string): Promise<T | null> {
  return await cache.get<T>(key);
}

function writeCache(cache: CacheProvider, key: string, value: unknown): void {
  cache.set(key, value).catch((err) => {
    console.error(`Non-fatal error saving cache key "${key}":`, err);
  });
}

/**
 * Writes the topojson to cache using a human-readable serialization:
 * - Top-level metadata (type, bbox, transform, objects) is pretty-printed.
 * - The `arcs` array is placed at the end with one arc per line, so the
 *   file remains greppable/diffable without exploding in size.
 *
 * If your CacheProvider only accepts objects, swap this to call
 * `cache.set(key, topojson)` and move the formatting to a separate
 * disk-write path.
 */
function writeTopojsonCache(cache: CacheProvider, key: string, topojson: any): void {
  const serialized = stringifyTopojsonReadable(topojson);
  cache.set(key, serialized as any).catch((err) => {
    console.error(`Non-fatal error saving cache key "${key}":`, err);
  });
}

/**
 * Pretty-prints a TopoJSON object with `arcs` placed at the end,
 * one arc per line. Produces valid JSON.
 */
function stringifyTopojsonReadable(topo: any): string {
  const { arcs, ...rest } = topo ?? {};
  const prettyRest = JSON.stringify(rest, null, 2);

  const arcsBlock =
    Array.isArray(arcs) && arcs.length > 0
      ? '[\n' + arcs.map((a: any) => '    ' + JSON.stringify(a)).join(',\n') + '\n  ]'
      : '[]';

  // Inject "arcs" as the last key inside the top-level object.
  const trimmed = prettyRest.replace(/\}\s*$/, '').trimEnd();
  const sep = trimmed.endsWith('{') ? '' : ',';

  return `${trimmed}${sep}\n  "arcs": ${arcsBlock}\n}\n`;
}

function buildMapshaperInputsAndCommands(geojson: any): {
  input: Record<string, unknown>;
  commands: string[];
} {
  const input: Record<string, unknown> = {
    'input.geojson': geojson,
  };

  const commands: string[] = [
    `-i input.geojson`,
    `-clean`,
    `-simplify weighting=0.5 10%`,
    `-filter-islands min-area=10km2`,
    `-each 'this.properties = { id: this.properties["@id"] || this.id, name: this.properties.name || "" }'`,
  ];

  commands.push(`-o output.topojson format=topojson quantization=1e3 bbox`);

  return { input, commands };
}

async function convertGeoJsonToTopojson(geojson: unknown, paths: CachePaths): Promise<any> {
  console.log('Converting to GeoJSON...');
  const cache = getCache();

  // Optional/debug cache
  writeCache(cache, paths.geojson, geojson);

  console.log('Optimizing with Mapshaper...');

  const { input, commands } = buildMapshaperInputsAndCommands(geojson);

  const topojsonString = await new Promise<string>((resolve, reject) => {
    mapshaper.applyCommands(commands.join(' '), input, (err: Error | null, output: any) => {
      geojson = null as any;

      if (err) {
        reject(err);
        return;
      }

      try {
        resolve(output['output.topojson'].toString());
      } catch (parseError) {
        reject(parseError);
      }
    });
  });

  console.log('Mapshaper processing complete.');
  return JSON.parse(topojsonString);
}

function summarizeTopojson(topojson: any): TopojsonSummary {
  const topojsonString = JSON.stringify(topojson);
  const bytes = new TextEncoder().encode(topojsonString).length;
  const size_kb = Math.round(bytes / 1024);

  const feature_count = Object.values(topojson.objects || {}).reduce((sum: number, obj: any) => {
    if (Array.isArray(obj?.geometries)) {
      return sum + obj.geometries.length;
    }
    if (obj?.type) {
      return sum + 1;
    }
    return sum;
  }, 0);

  const bbox = Array.isArray(topojson.bbox) ? topojson.bbox : [];

  return {
    size_kb,
    feature_count,
    bbox,
  };
}

function buildSuccessResponse(
  params: BoundaryRequestParams,
  source: Source,
  topojson: any,
  dataSource: 'geofabrik' | 'overpass' = 'overpass',
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(topojson);

  return JSONResponse(
    {
      country_code: params.country_code,
      admin_level: params.admin_level,
      source,
      data_source: dataSource,
      size_kb,
      feature_count,
      bbox,
      topojson,
    },
    200,
  );
}
