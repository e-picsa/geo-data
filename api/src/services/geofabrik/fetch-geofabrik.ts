import type { OsmEntity } from 'osmix';
import { BoundaryCache } from './boundary-cache.ts';
import { PbfBoundaryExtractor } from './pbf-extractor.ts';
import { ensureRawPbf } from './raw-pbf.ts';
import { convertToGeoJSON } from './geojson-converter.ts';

const CACHE_VERSION = 4;

export interface OsmData {
  elements: OsmEntity[];
}

export interface FetchGeofabrikOptions {
  countryCode: string;
  adminLevel: number;
  signal: AbortSignal;
}

export async function fetchGeofabrikBoundaries(options: FetchGeofabrikOptions) {
  const { countryCode, adminLevel, signal } = options;
  const cache = new BoundaryCache(countryCode, CACHE_VERSION);

  const cached = await cache.load();
  if (cached) {
    console.log(`Geofabrik cache hit for ${countryCode} admin-${adminLevel}`);
    return convertToGeoJSON(cached, adminLevel);
  }

  console.log(`Geofabrik cache miss for ${countryCode} admin-${adminLevel}. Running extraction...`);

  const pbfPath = await ensureRawPbf(countryCode, CACHE_VERSION, signal);

  const extractor = new PbfBoundaryExtractor(pbfPath, signal, {
    countryCode,
  });
  const extracted = await extractor.extract();

  if (extracted.relations.length === 0) {
    throw new Error(`No admin-${adminLevel} boundaries found for country code: ${countryCode}`);
  }
  await cache.save(extracted);
  // TODO - filter for admin level (possibly in next step)
  return convertToGeoJSON(extracted, adminLevel);
}
