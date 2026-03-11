import { corsHeaders } from '../utils/cors.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { OVERPASS_QUERY_MAPPING } from './overpass-mapping.ts';

export { OVERPASS_QUERY_MAPPING };

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
 * POST a query to the Overpass API and return the parsed JSON response.
 *
 * Accepts an AbortSignal (rather than a full Request) so it can be reused
 * outside of HTTP request handlers.
 */
export async function fetchOverpassData(
  signal: AbortSignal,
  overpassQuery: string,
  countryCode: string,
): Promise<unknown> {
  console.log(`Fetching Overpass data for ${countryCode}...`);

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
  const query = buildOverpassQuery(countryCode, 2);
  const osmData = await fetchOverpassData(
    signal ?? AbortSignal.timeout(30_000),
    query,
    countryCode,
  );

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
