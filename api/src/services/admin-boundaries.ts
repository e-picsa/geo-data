import mapshaper from 'mapshaper';

import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { validateBody } from '../utils/validation.ts';
import { getCache, type CacheProvider } from '../utils/cache/index.ts';
import { BOUNDARY_REQUEST_SCHEMA } from '../types/schema.ts';
import type { BoundaryRequestParams } from '../types/schema.ts';
import { fetchGeofabrikBoundaries } from './geofabrik';
import { stringifyTopojsonReadable, summarizeTopojson } from '../utils/topojson.utils.ts';
export { getCountryAdminLevels } from './geofabrik/url-mapping.ts';

/**
 * Bust cache if conversion or processing methods change.
 * GCS cache object lifecycle automatically deletes after 90 days.
 */
const CACHE_VERSION = 7;

type Source = 'cache' | 'generated';

type CachePaths = {
  prefix: string;
  geojson: string;
  topojson: string;
};

export async function getBoundariesTopojson(
  countryCode: string,
  signal?: AbortSignal,
): Promise<{ topojsonString: string; source: Source }> {
  const cache = getCache();
  const paths = buildCachePaths(countryCode);

  const cachedTopojson = await readCache<any>(cache, paths.topojson);
  if (cachedTopojson) {
    console.log(`TopoJSON cache hit for ${countryCode}.`);
    const serializedTopojson = stringifyTopojsonReadable(cachedTopojson);
    return { topojsonString: serializedTopojson, source: 'cache' };
  }

  console.log(`Attempting to fetch boundaries from Geofabrik for ${countryCode}...`);
  const osmData = await fetchGeofabrikBoundaries({
    countryCode,
    signal,
  });
  console.log(`Successfully fetched boundaries from Geofabrik for ${countryCode}`);

  const topojsonString = await convertGeoJsonToTopojson(osmData, paths);

  const serializedTopojson = stringifyTopojsonReadable(JSON.parse(topojsonString));
  await writeCache(cache, paths.topojson, serializedTopojson);

  return { topojsonString: serializedTopojson, source: 'generated' };
}

export const adminBoundaries = async (req: Request) => {
  try {
    const params = await validateBody(req, BOUNDARY_REQUEST_SCHEMA);
    const { country_code } = params;

    const { topojsonString, source } = await getBoundariesTopojson(country_code, req.signal);
    return buildSuccessResponse(params, source, topojsonString);
  } catch (error) {
    console.error(typeof error, error);
    return ErrorResponse(error);
  }
};

function buildCachePaths(countryCode: string): CachePaths {
  const prefix = `derived/v${CACHE_VERSION}/country=${countryCode}`;
  return {
    prefix,
    geojson: `${prefix}/geojson.json`,
    topojson: `${prefix}/topojson.json`,
  };
}

async function readCache<T>(cache: CacheProvider, key: string): Promise<T | null> {
  try {
    return await cache.get<T>(key);
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheProvider, key: string, data: unknown): Promise<void> {
  try {
    await cache.set(key, data);
  } catch (err) {
    console.error(`Non-fatal error saving cache key "${key}":`, err);
  }
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
    `-clean allow-overlaps`,
    `-simplify weighting=0.5 10%`,
    `-filter-islands min-area=10km2`,
    `-each '` +
      `var c = this.properties.admin_centre; ` +
      `var s = "admin_centre"; ` +
      `if (!c && this.properties.label_point) { c = this.properties.label_point; s = "label"; } ` +
      `if (!c) { ` +
      `  var hasCentroid = typeof this.centroidX === "number" && !isNaN(this.centroidX) && typeof this.centroidY === "number" && !isNaN(this.centroidY); ` +
      `  var hasInner = typeof this.innerX === "number" && !isNaN(this.innerX) && typeof this.innerY === "number" && !isNaN(this.innerY); ` +
      `  if (hasCentroid) { ` +
      `    c = [Math.round(this.centroidX * 1e5) / 1e5, Math.round(this.centroidY * 1e5) / 1e5]; ` +
      `    s = "centroid"; ` +
      `  } else if (hasInner) { ` +
      `    c = [Math.round(this.innerX * 1e5) / 1e5, Math.round(this.innerY * 1e5) / 1e5]; ` +
      `    s = "point_on_surface"; ` +
      `  } ` +
      `} else { ` +
      `  c = [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]; ` +
      `} ` +
      `this.properties = { ` +
      `  id: this.properties.id || this.properties["@id"] || this.id, ` +
      `  name: this.properties.name || "", ` +
      `  admin_level: this.properties.admin_level, ` +
      `  center: c, ` +
      `  center_source: s ` +
      `}; '`,
    `-o format=topojson output.topojson`,
  ];

  return { input, commands };
}

async function convertGeoJsonToTopojson(geojson: any, paths: CachePaths): Promise<string> {
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
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(JSON.parse(topojson));

  return JSONResponse(
    {
      country_code: params.country_code,
      source,
      size_kb,
      feature_count,
      bbox,
      topojson,
    },
    200,
  );
}
