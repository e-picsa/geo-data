import type { OsmEntity } from 'osmix';
import { BoundaryCache, type ExtractedOsmData } from './boundary-cache.ts';
import { PbfBoundaryExtractor } from './pbf-extractor.ts';
import { ensureRawPbf } from './raw-pbf.ts';

const CACHE_VERSION = 4;

export interface OsmData {
  elements: OsmEntity[];
}

export interface FetchGeofabrikOptions {
  countryCode: string;
  adminLevel: number;
  signal: AbortSignal;
}

function flatten(data: ExtractedOsmData): OsmData {
  return {
    elements: [...data.relations, ...data.ways, ...data.nodes],
  };
}

export async function fetchGeofabrikBoundaries(options: FetchGeofabrikOptions): Promise<OsmData> {
  const { countryCode, adminLevel, signal } = options;
  const cache = new BoundaryCache(countryCode, adminLevel, CACHE_VERSION);

  const cached = await cache.load();
  if (cached) {
    console.log(`Geofabrik cache hit for ${countryCode} admin-${adminLevel}`);
    console.log(
      `relations: ${cached.relations.length}, ways: ${cached.ways.length}, nodes: ${cached.nodes.length}`,
    );
    return flatten(cached);
  }

  console.log(`Geofabrik cache miss for ${countryCode} admin-${adminLevel}. Running extraction...`);

  const pbfPath = await ensureRawPbf(countryCode, CACHE_VERSION, signal);

  const extractor = new PbfBoundaryExtractor(pbfPath, signal, { adminLevel, countryCode });
  const extracted = await extractor.extract();

  if (extracted.relations.length === 0) {
    throw new Error(`No admin-${adminLevel} boundaries found for country code: ${countryCode}`);
  }
  await cache.save(extracted);
  return flatten(extracted);
}
