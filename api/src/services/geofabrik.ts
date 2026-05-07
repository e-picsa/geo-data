import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCache } from '../utils/cache.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getGeofabrikUrl } from './geofabrik-mapping.ts';

import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type {
  OsmEntity,
  OsmNode,
  OsmPbfBlock,
  OsmPbfHeaderBlock,
  OsmRelation,
  OsmWay,
} from 'osmix';

const CACHE_VERSION = 3;
const VALID_ADMIN_LEVELS = new Set(['2', '3', '4', '5']);
const MIN_VALID_PBF_BYTES = 50_000;

export interface OsmData {
  elements: OsmEntity[];
}

export interface ExtractedOsmData {
  relations: OsmRelation[];
  ways: OsmWay[];
  nodes: OsmNode[];
}

// ==========================================
// STRUCTURAL TYPE GUARDS
// ==========================================
function isPrimitiveBlock(block: OsmPbfHeaderBlock | OsmPbfBlock): block is OsmPbfBlock {
  return 'primitivegroup' in block;
}

function isOsmRelation(entity: OsmEntity): entity is OsmRelation {
  return 'members' in entity;
}

function isOsmWay(entity: OsmEntity): entity is OsmWay {
  return 'refs' in entity;
}

function isOsmNode(entity: OsmEntity): entity is OsmNode {
  return 'lat' in entity && 'lon' in entity;
}

function blockHasRelations(block: OsmPbfBlock): boolean {
  return block.primitivegroup?.some((g) => g.relations?.length) ?? false;
}

function blockHasWays(block: OsmPbfBlock): boolean {
  return block.primitivegroup?.some((g) => g.ways?.length) ?? false;
}

function blockHasNodes(block: OsmPbfBlock): boolean {
  return (
    block.primitivegroup?.some((g) => (g.dense && g.dense.id.length > 0) || g.nodes?.length) ??
    false
  );
}

// ==========================================
// CACHE KEYS
// ==========================================
function relationsCacheKey(countryCode: string): string {
  return `geofabrik/v${CACHE_VERSION}/extracted/${countryCode}/relations.json`;
}

function waysCacheKey(countryCode: string): string {
  return `geofabrik/v${CACHE_VERSION}/extracted/${countryCode}/ways.json`;
}

function nodesCacheKey(countryCode: string): string {
  return `geofabrik/v${CACHE_VERSION}/extracted/${countryCode}/nodes.json`;
}

function rawPbfPath(countryCode: string): string {
  return `.cache/geofabrik/v${CACHE_VERSION}/raw/${countryCode}.pbf`;
}

async function ensureRawPbf(countryCode: string, signal: AbortSignal): Promise<string> {
  const pbfPath = rawPbfPath(countryCode);
  const file = Bun.file(pbfPath);

  if (await file.exists()) {
    const size = file.size;
    if (size > MIN_VALID_PBF_BYTES) {
      console.log(`Using cached PBF for ${countryCode} (${size} bytes)`);
      return pbfPath;
    }
    console.warn(`Cached PBF for ${countryCode} is anomalously small (${size} bytes). Purging.`);
  }

  const url = getGeofabrikUrl(countryCode);
  if (!url) {
    throw new Error(`No Geofabrik URL for country code: ${countryCode}`);
  }

  console.log(`Downloading PBF from Geofabrik for ${countryCode}...`);

  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download PBF: HTTP ${response.status}`);
  }

  await mkdir(dirname(pbfPath), { recursive: true });
  await Bun.write(pbfPath, response);

  return pbfPath;
}

// ==========================================
// EXTRACTION PIPELINE
// ==========================================

function openBlockStream(pbfPath: string) {
  return Bun.file(pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());
}

/**
 * PBF files are ordered: nodes → ways → relations.
 * We need three sequential streaming passes:
 *   1. Relations: determine which admin boundaries to extract and their
 *      required way/node dependencies.
 *   2. Ways: collect required ways, which reveals additional required nodes.
 *   3. Nodes: collect all required nodes (from relations + ways).
 *
 * A single pass cannot work because nodes appear first in the file but
 * their required IDs are only known after reading relations and ways.
 */
async function extractAllFromPbf(pbfPath: string, signal: AbortSignal): Promise<ExtractedOsmData> {
  const requiredWayIds = new Set<number>();
  const requiredNodeIds = new Set<number>();
  const relations: OsmRelation[] = [];
  const ways: OsmWay[] = [];
  const nodes: OsmNode[] = [];

  const checkAborted = () => {
    if (signal.aborted) throw new Error('Stream aborted');
  };

  // ---- Pass 1: Relations ----
  console.log('Pass 1: Scanning relations for admin boundaries...');
  let blockCount = 0;
  for await (const block of toAsyncGenerator(openBlockStream(pbfPath))) {
    checkAborted();
    blockCount++;
    if (!isPrimitiveBlock(block) || !blockHasRelations(block)) continue;

    for (const entity of blocksToJsonEntities(block)) {
      if (!isOsmRelation(entity)) continue;

      const tags = entity.tags;
      if (tags?.boundary !== 'administrative') continue;
      if (!VALID_ADMIN_LEVELS.has(`${tags.admin_level}`)) continue;

      relations.push(entity);
      for (const member of entity.members) {
        if (member.type === 'way') {
          requiredWayIds.add(member.ref);
        } else if (member.type === 'node' && member.role === 'admin_centre') {
          requiredNodeIds.add(member.ref);
        }
      }
    }

    if (blockCount % 1000 === 0) {
      console.log(
        `  Scanned ${blockCount} blocks - relations: ${relations.length}, required ways: ${requiredWayIds.size}`,
      );
    }
  }
  console.log(
    `Pass 1 complete. Relations: ${relations.length}, required ways: ${requiredWayIds.size}, required nodes (from relations): ${requiredNodeIds.size}`,
  );

  // ---- Pass 2: Ways ----
  if (requiredWayIds.size === 0) {
    return { relations, ways, nodes };
  }

  console.log('Pass 2: Extracting required ways...');
  let remainingWays = requiredWayIds.size;
  for await (const block of toAsyncGenerator(openBlockStream(pbfPath))) {
    checkAborted();
    if (!isPrimitiveBlock(block) || !blockHasWays(block)) continue;
    if (remainingWays === 0) break;

    for (const entity of blocksToJsonEntities(block)) {
      if (!isOsmWay(entity) || !requiredWayIds.has(entity.id)) continue;

      ways.push(entity);
      remainingWays--;
      for (const nodeId of entity.refs) {
        requiredNodeIds.add(nodeId);
      }
    }
  }
  console.log(
    `Pass 2 complete. Ways: ${ways.length}, total required nodes: ${requiredNodeIds.size}`,
  );

  // ---- Pass 3: Nodes ----
  if (requiredNodeIds.size === 0) {
    return { relations, ways, nodes };
  }

  console.log('Pass 3: Extracting required nodes...');
  let remainingNodes = requiredNodeIds.size;
  for await (const block of toAsyncGenerator(openBlockStream(pbfPath))) {
    checkAborted();
    if (!isPrimitiveBlock(block) || !blockHasNodes(block)) continue;
    if (remainingNodes === 0) break;
    // Nodes come before ways in PBF, so stop scanning once we hit ways.
    if (blockHasWays(block)) break;

    for (const entity of blocksToJsonEntities(block)) {
      if (!isOsmNode(entity) || !requiredNodeIds.has(entity.id)) continue;

      nodes.push(entity);
      remainingNodes--;
    }
  }
  console.log(`Pass 3 complete. Nodes: ${nodes.length}`);

  return { relations, ways, nodes };
}

async function extractAndCacheBoundaries(
  countryCode: string,
  signal: AbortSignal,
): Promise<ExtractedOsmData> {
  const pbfPath = await ensureRawPbf(countryCode, signal);
  console.log(`Extracting admin boundaries for ${countryCode}...`);

  const { relations, ways, nodes } = await extractAllFromPbf(pbfPath, signal);

  const cache = getCache();
  const writes: Promise<unknown>[] = [];

  if (relations.length > 0) {
    writes.push(
      cache
        .set(relationsCacheKey(countryCode), { elements: relations })
        .catch((err) => console.error(`Failed to cache relations for ${countryCode}:`, err)),
    );
  }
  if (ways.length > 0) {
    writes.push(
      cache
        .set(waysCacheKey(countryCode), { elements: ways })
        .catch((err) => console.error(`Failed to cache ways for ${countryCode}:`, err)),
    );
  }
  if (nodes.length > 0) {
    writes.push(
      cache
        .set(nodesCacheKey(countryCode), { elements: nodes })
        .catch((err) => console.error(`Failed to cache nodes for ${countryCode}:`, err)),
    );
  }

  await Promise.all(writes);

  return { relations, ways, nodes };
}

export async function fetchGeofabrikBoundaries(
  countryCode: string,
  signal: AbortSignal,
): Promise<OsmData> {
  const cache = getCache();

  const [relationsData, waysData, nodesData] = await Promise.all([
    cache.get<{ elements: OsmRelation[] }>(relationsCacheKey(countryCode)),
    cache.get<{ elements: OsmWay[] }>(waysCacheKey(countryCode)),
    cache.get<{ elements: OsmNode[] }>(nodesCacheKey(countryCode)),
  ]);

  if (relationsData && waysData && nodesData) {
    console.log(
      `Geofabrik cache hit for ${countryCode} (relations: ${relationsData.elements.length}, ways: ${waysData.elements.length}, nodes: ${nodesData.elements.length})`,
    );
    return {
      elements: [...relationsData.elements, ...waysData.elements, ...nodesData.elements],
    };
  }

  console.log(`Geofabrik cache miss for ${countryCode}. Running extraction...`);
  const extracted = await extractAndCacheBoundaries(countryCode, signal);

  if (extracted.relations.length === 0) {
    throw new Error(`No admin boundaries found for country code: ${countryCode}`);
  }

  return {
    elements: [...extracted.relations, ...extracted.ways, ...extracted.nodes],
  };
}
