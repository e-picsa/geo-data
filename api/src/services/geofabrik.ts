import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCache } from '../utils/cache.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getGeofabrikUrl, shouldUseGeofabrik } from './geofabrik-mapping.ts';
import { osmPbfToJson } from '@osmix/json';
import { toAsyncGenerator } from '@osmix/pbf';

const CACHE_VERSION = 1;
const DEBUG = process.env.DEBUG_GEOFABRIK === '1';
const VALID_ADMIN_LEVELS = new Set(['2', '3', '4', '5']);

interface OsmMember {
  type: 'node' | 'way' | 'relation';
  id?: number;
  ref?: number;
  role?: string;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: OsmMember[];
  lat?: number;
  lon?: number;
}

interface OsmData {
  elements: OsmElement[];
}

function geofabrikCacheKey(countryCode: string): string {
  return `geofabrik/v${CACHE_VERSION}/extracted/${countryCode}/boundaries.json`;
}

function rawPbfPath(countryCode: string): string {
  return `.cache/geofabrik/v${CACHE_VERSION}/raw/${countryCode}.pbf`;
}

async function ensureRawPbf(countryCode: string, signal: AbortSignal): Promise<string> {
  const pbfPath = rawPbfPath(countryCode);
  const file = Bun.file(pbfPath);

  if (await file.exists()) {
    const size = file.size;
    // Defensive check: A valid PBF extract will be well over 50KB.
    // If it is smaller, we likely cached a Geofabrik 404/302 HTML page.
    if (size > 50_000) {
      if (DEBUG) console.log(`Using cached PBF for ${countryCode} (${size} bytes)`);
      return pbfPath;
    }
    console.warn(
      `Cached PBF for ${countryCode} is anomalously small (${size} bytes). Purging and re-downloading.`,
    );
  }

  const url = getGeofabrikUrl(countryCode);
  if (!url) {
    throw new Error(`No Geofabrik URL for country code: ${countryCode}`);
  }

  console.log(`Downloading PBF from Geofabrik for ${countryCode}...`);

  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download PBF: HTTP ${response.status} ${response.statusText}`);
  }

  // Ensure the directory structure exists before writing
  await mkdir(dirname(pbfPath), { recursive: true });
  await Bun.write(pbfPath, response);

  const downloadedSize = Bun.file(pbfPath).size;
  console.log(`Cached raw PBF for ${countryCode} (${downloadedSize} bytes)`);

  return pbfPath;
}

async function parsePbfToOsm(pbfPath: string, signal: AbortSignal): Promise<OsmData> {
  // Web Streams API is natively expected by @osmix
  const webStream = Bun.file(pbfPath).stream();
  const jsonStream = osmPbfToJson(webStream);

  const elements: OsmElement[] = [];
  const boundaryRelationIds = new Set<number>();
  const relevantWayIds = new Set<number>();
  const relevantNodeIds = new Set<number>();

  let nodeCount = 0;
  let wayCount = 0;
  let relationCount = 0;

  for await (const item of toAsyncGenerator(jsonStream)) {
    if (signal.aborted) {
      throw new Error('Stream aborted by signal');
    }

    // @osmix pattern: Header blocks do not contain an 'id'
    if (!('id' in item)) {
      continue;
    }

    // Cast item to our internal OsmElement format
    const entity = item as unknown as OsmElement;

    if (entity.type === 'node') {
      nodeCount++;
      continue;
    }

    if (entity.type === 'way') {
      wayCount++;
      continue;
    }

    if (entity.type === 'relation') {
      relationCount++;

      const isBoundary = entity.tags?.boundary === 'administrative';
      const adminLevel = entity.tags?.admin_level;
      const isValidLevel = adminLevel !== undefined && VALID_ADMIN_LEVELS.has(String(adminLevel));

      if (!isBoundary || !isValidLevel) continue;

      elements.push(entity);
      boundaryRelationIds.add(entity.id);

      for (const member of entity.members || []) {
        // Handle varying osmix member reference structures
        const memberId = member.id ?? member.ref;
        if (memberId === undefined) continue;

        if (member.type === 'way') relevantWayIds.add(memberId);
        else if (member.type === 'node') relevantNodeIds.add(memberId);
      }
    }
  }

  console.log(
    `Parsed ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations.\n` +
      `Found ${elements.length} boundary relations.\n` +
      `Required geometry references: ${relevantWayIds.size} ways, ${relevantNodeIds.size} nodes.`,
  );

  return { elements };
}

export async function fetchGeofabrikBoundaries(
  countryCode: string,
  signal: AbortSignal,
): Promise<OsmData> {
  const cache = getCache();
  const cacheKey = geofabrikCacheKey(countryCode);

  const cached = await cache.get<OsmData>(cacheKey);
  if (cached) {
    if (DEBUG) console.log(`Geofabrik cache hit for ${countryCode}`);
    return cached;
  }

  const pbfPath = await ensureRawPbf(countryCode, signal);
  const pbfSize = Bun.file(pbfPath).size;

  console.log(`Parsing PBF for ${countryCode} (${pbfSize} bytes)...`);
  const osmData = await parsePbfToOsm(pbfPath, signal);

  console.log(`Extracted ${osmData.elements.length} boundary elements for ${countryCode}`);

  if (osmData.elements.length === 0) {
    throw new Error(`No admin boundaries found for country code: ${countryCode}`);
  }

  await cache.set(cacheKey, osmData).catch((err) => {
    console.error(`Error caching Geofabrik data for "${countryCode}":`, err);
  });

  if (DEBUG) console.log(`Cache updated: ${cacheKey} (${osmData.elements.length} elements)`);

  return osmData;
}

export { shouldUseGeofabrik };
