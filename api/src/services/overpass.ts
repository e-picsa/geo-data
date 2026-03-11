import { corsHeaders } from '../utils/cors.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getCache } from '../utils/cache.ts';
import { OVERPASS_QUERY_MAPPING } from './overpass-mapping.ts';

export { OVERPASS_QUERY_MAPPING };

/**
 * Bust cache if query or processing methods change.
 * GCS cache object lifecycle automatically deletes after 90 days.
 */
const CACHE_VERSION = 1;

function overpassCacheKey(countryCode: string, adminLevel: number): string {
  return `overpass/v${CACHE_VERSION}/country=${countryCode}/admin_level=${adminLevel}/overpass.json`;
}

/**
 * Build an Overpass QL query string for the given country and admin level.
 */
export function buildOverpassQuery(countryCode: string, adminLevel: number): string {
  const queryBuilder = OVERPASS_QUERY_MAPPING[adminLevel];
  if (!queryBuilder) {
    throw new Error(`Admin level ${adminLevel} is not supported`);
  }
  return queryBuilder(countryCode).trim();
}

/**
 * Fetch Overpass data for a given country and admin level.
 *
 * This is **cache-through**: it checks the cache first and only hits the
 * Overpass API on a miss. Successful API responses are written back to
 * the cache automatically.
 */
export async function fetchOverpassData(
  signal: AbortSignal,
  countryCode: string,
  adminLevel: number,
): Promise<unknown> {
  const cache = getCache();
  const cacheKey = overpassCacheKey(countryCode, adminLevel);

  // Check cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(`Overpass cache hit for ${countryCode} admin level ${adminLevel}.`);
    return cached;
  }

  // Cache miss — query the API
  const overpassQuery = buildOverpassQuery(countryCode, adminLevel);
  console.log(`Fetching Overpass data for ${countryCode} admin level ${adminLevel}...`);

  const overpassResponse = await fetchWithRetry('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: overpassQuery,
    signal,
  });

  if (!overpassResponse.ok) {
    const errorText = await overpassResponse.text();
    console.error(`Overpass API error (${overpassResponse.status}):`, errorText);

    let status = 502;
    let message = 'Failed to fetch from Overpass API';

    if (overpassResponse.status === 429) {
      status = 429;
      message = 'Overpass API rate limit exceeded. Please try again later.';
    } else if (overpassResponse.status === 504) {
      status = 504;
      message = 'Overpass API gateway timeout. The query took too long to execute.';
    }

    throw new Response(
      JSON.stringify({
        error: message,
        details: errorText || overpassResponse.statusText,
        upstream_status: overpassResponse.status,
      }),
      {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  let osmData: any;
  try {
    osmData = await overpassResponse.json();
  } catch {
    throw new Response(
      JSON.stringify({
        error: 'Invalid JSON returned by Overpass API',
      }),
      {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  console.log(
    `Received ${osmData?.elements?.length || 0} elements from Overpass for ${countryCode}`,
  );

  // Write to cache (fire-and-forget)
  cache.set(cacheKey, osmData).catch((err) => {
    console.error(`Non-fatal error saving Overpass cache for "${cacheKey}":`, err);
  });

  return osmData;
}

/**
 * Derive a bounding box [minLon, minLat, maxLon, maxLat] for a country
 * by querying its admin_level 2 boundary from Overpass.
 *
 * Each element returned by `out geom qt;` carries a `bounds` object with
 * `minlat`, `minlon`, `maxlat`, `maxlon`.  We take the envelope of all
 * returned elements.
 */
export async function getBboxForCountry(
  countryCode: string,
  signal?: AbortSignal,
): Promise<[number, number, number, number]> {
  const osmData = await fetchOverpassData(signal ?? AbortSignal.timeout(30_000), countryCode, 2);

  const elements = (osmData as any)?.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error(`No admin_level 2 boundary found for country code "${countryCode}"`);
  }

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const el of elements) {
    const b = el.bounds;
    if (!b) continue;
    if (b.minlon < minLon) minLon = b.minlon;
    if (b.minlat < minLat) minLat = b.minlat;
    if (b.maxlon > maxLon) maxLon = b.maxlon;
    if (b.maxlat > maxLat) maxLat = b.maxlat;
  }

  if (!isFinite(minLon)) {
    throw new Error(`Could not extract bounding box from Overpass response for "${countryCode}"`);
  }

  return [minLon, minLat, maxLon, maxLat];
}
