import mapshaper from 'mapshaper';

import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { validateBody } from '../utils/validation.ts';
import { getCache, type CacheProvider } from '../utils/cache/index.ts';
import { BOUNDARY_REQUEST_SCHEMA } from '../types/schema.ts';
import type { BoundaryRequestParams } from '../types/schema.ts';
import { fetchGeofabrikBoundaries } from './geofabrik';
import { stringifyTopojsonReadable, summarizeTopojson } from '../utils/topojson.utils.ts';

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

export const adminBoundaries = async (req: Request) => {
  try {
    const params = await validateBody(req, BOUNDARY_REQUEST_SCHEMA);
    const { country_code, admin_level } = params;

    const cache = getCache();
    const paths = buildCachePaths(country_code, admin_level);

    const cachedTopojson = await readCache<any>(cache, paths.topojson);
    if (cachedTopojson) {
      console.log(`TopoJSON cache hit for ${country_code} admin level ${admin_level}.`);
      const serializedTopojson = stringifyTopojsonReadable(cachedTopojson);
      return buildSuccessResponse(params, 'cache', serializedTopojson);
    }

    const dataSource = 'geofabrik';

    console.log(`Attempting to fetch boundaries from Geofabrik for ${country_code}...`);
    const osmData = await fetchGeofabrikBoundaries({
      countryCode: country_code,
      adminLevel: admin_level,
      signal: req.signal,
    });
    console.log(`Successfully fetched boundaries from Geofabrik for ${country_code}`);

    const topojsonString = await convertGeoJsonToTopojson(osmData, paths);

    const serializedTopojson = stringifyTopojsonReadable(JSON.parse(topojsonString));
    await writeCache(cache, paths.topojson, serializedTopojson);

    return buildSuccessResponse(params, 'generated', serializedTopojson, dataSource);
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

async function writeCache(cache: CacheProvider, key: string, value: unknown) {
  return cache.set(key, value).catch((err) => {
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

async function convertGeoJsonToTopojson(geojson: unknown, paths: CachePaths): Promise<string> {
  console.log('Converting to GeoJSON...');
  const cache = getCache();

  // Optional/debug cache
  await writeCache(cache, paths.geojson, geojson);

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
  return topojsonString;
}

function buildSuccessResponse(
  params: BoundaryRequestParams,
  source: Source,
  topojson: string,
  dataSource: 'geofabrik' | 'overpass' = 'overpass',
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(JSON.parse(topojson));

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
