import osmtogeojson from 'osmtogeojson';
import mapshaper from 'mapshaper';

import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { validateBody } from '../utils/validation.ts';
import { getCache, type CacheProvider } from '../utils/cache.ts';
import { BOUNDARY_REQUEST_SCHEMA } from '../types/schema.ts';
import type { BoundaryRequestParams } from '../types/schema.ts';
import { fetchOverpassData } from './overpass.ts';

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

    // fetchOverpassData is cache-through — it reads/writes the Overpass
    // response cache internally, so we don't manage it here.
    const osmData = await fetchOverpassData(req.signal, country_code, admin_level);

    const topojson = await convertOsmToTopojson(osmData, admin_level, cache, paths);

    writeCache(cache, paths.topojson, topojson);

    return buildSuccessResponse(params, 'generated', topojson);
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

function hasAdminLevel(feature: any, level: number): boolean {
  return Number(feature?.properties?.admin_level) === level;
}

function buildMapshaperInputsAndCommands(
  geojson: any,
  adminLevel: number,
): {
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

  if (adminLevel === 5) {
    const countryFeatures = geojson.features.filter((f: any) => hasAdminLevel(f, 2));
    const targetFeatures = geojson.features.filter((f: any) => hasAdminLevel(f, 5));

    input['input.geojson'] = {
      type: 'FeatureCollection',
      features: targetFeatures,
    };

    input['mask.geojson'] = {
      type: 'FeatureCollection',
      features: countryFeatures,
    };

    commands.push(`-clip mask.geojson`);
    // Filter out slivers along the border.
    // 5km2 is arbitrary but should drop the border overlaps while keeping real districts.
    commands.push(`-filter-islands min-area=5km2`);
  }

  commands.push(`-o output.topojson format=topojson quantization=1e3 bbox`);

  return { input, commands };
}

async function convertOsmToTopojson(
  osmData: unknown,
  adminLevel: number,
  cache: import('../utils/cache.ts').CacheProvider,
  paths: CachePaths,
): Promise<any> {
  console.log('Converting to GeoJSON...');
  let geojson: any = osmtogeojson(osmData as any);

  // Optional/debug cache
  writeCache(cache, paths.geojson, geojson);

  console.log('Optimizing with Mapshaper...');

  const { input, commands } = buildMapshaperInputsAndCommands(geojson, adminLevel);

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
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(topojson);

  return JSONResponse(
    {
      country_code: params.country_code,
      admin_level: params.admin_level,
      source,
      size_kb,
      feature_count,
      bbox,
      topojson,
    },
    200,
  );
}
