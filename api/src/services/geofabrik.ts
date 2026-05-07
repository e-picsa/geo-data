import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCache } from '../utils/cache.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getGeofabrikUrl } from './geofabrik-mapping.ts';

// Core Osmix Imports
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

const CACHE_VERSION = 2;
const VALID_ADMIN_LEVELS = new Set(['2', '3', '4', '5']);

export interface OsmData {
  elements: OsmEntity[];
}

// ==========================================
// STRUCTURAL TYPE GUARDS
// ==========================================
/**
 * Narrows the block stream union, stripping out the initial OsmPbfHeaderBlock.
 */
function isPrimitiveBlock(block: OsmPbfHeaderBlock | OsmPbfBlock): block is OsmPbfBlock {
  return 'primitivegroup' in block;
}
/**
 * Narrows the unknown stream item to a generic OsmEntity.
 * Filters out OsmPbfHeaderBlock and malformed data.
 */
function isOsmEntity(item: unknown): item is OsmEntity {
  return typeof item === 'object' && item !== null && 'id' in item;
}

/** Relation Guard: Identified by the 'members' array */
function isOsmRelation(entity: OsmEntity): entity is OsmRelation {
  return 'members' in entity;
}

/** Way Guard: Identified by the 'refs' array */
function isOsmWay(entity: OsmEntity): entity is OsmWay {
  return 'refs' in entity;
}

/** Node Guard: Identified by geographic coordinates */
function isOsmNode(entity: OsmEntity): entity is OsmNode {
  return 'lat' in entity && 'lon' in entity;
}

// ==========================================
// EXTRACTION PIPELINE
// ==========================================

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
    if (size > 50_000) {
      console.log(`Using cached PBF for ${countryCode} (${size} bytes)`);
      return pbfPath;
    }
    console.warn(`Cached PBF for ${countryCode} is anomalously small (${size} bytes). Purging.`);
  }

  const url = getGeofabrikUrl(countryCode);
  if (!url) throw new Error(`No Geofabrik URL for country code: ${countryCode}`);

  console.log(`Downloading PBF from Geofabrik for ${countryCode}...`);

  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) throw new Error(`Failed to download PBF: HTTP ${response.status}`);

  await mkdir(dirname(pbfPath), { recursive: true });
  await Bun.write(pbfPath, response);

  return pbfPath;
}

// ==========================================
// EXTRACTION PIPELINE
// ==========================================

async function extractAdminBoundaries(pbfPath: string, signal: AbortSignal): Promise<OsmData> {
  // The "Half-Pipe": Streams bytes to blocks, but stops before JSON hydration.
  // This is natively optimized by Bun/Node Web Streams.
  const getBlockStream = () =>
    Bun.file(pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());

  const requiredWays = new Set<number>();
  const requiredNodes = new Set<number>();
  const extractedElements = new Map<string, OsmEntity>();

  // ------------------------------------------
  // PASS 1: Identify Relations & Dependencies
  // ------------------------------------------
  console.log('Extracting boundaries...');
  for await (const block of toAsyncGenerator(getBlockStream())) {
    if (signal.aborted) throw new Error('Stream aborted');

    // Type Guard: Skip the Header Block
    if (!isPrimitiveBlock(block)) continue;

    // Low-level skip: Only pay the JSON tax if the block contains relations
    const hasRelations = block.primitivegroup?.some((g) => g.relations && g.relations.length > 0);
    if (!hasRelations) continue;

    // Manually hydrate only this specific block
    for (const entity of blocksToJsonEntities(block)) {
      if (isOsmEntity(entity) && isOsmRelation(entity)) {
        const isBoundary = entity.tags?.boundary === 'administrative';
        const adminLevel = String(entity.tags?.admin_level);

        if (isBoundary && VALID_ADMIN_LEVELS.has(adminLevel)) {
          extractedElements.set(`relation_${entity.id}`, entity);

          for (const member of entity.members) {
            if (member.type === 'way') {
              requiredWays.add(member.ref);
            } else if (member.type === 'node' && member.role === 'admin_centre') {
              requiredNodes.add(member.ref);
            }
          }
        }
      }
    }
  }

  // ------------------------------------------
  // PASS 2: Extract Required Ways
  // ------------------------------------------

  for await (const block of toAsyncGenerator(getBlockStream())) {
    console.log('Extracting ways...');
    if (signal.aborted) throw new Error('Stream aborted');

    // Type Guard: Skip the Header Block
    if (!isPrimitiveBlock(block)) continue;

    // Low-level skip: Only pay the JSON tax if the block contains ways
    const hasWays = block.primitivegroup?.some((g) => g.ways && g.ways.length > 0);
    if (!hasWays) continue;

    for (const entity of blocksToJsonEntities(block)) {
      if (isOsmEntity(entity) && isOsmWay(entity) && requiredWays.has(entity.id)) {
        extractedElements.set(`way_${entity.id}`, entity);

        for (const nodeId of entity.refs) {
          requiredNodes.add(nodeId);
        }
      }
    }
  }

  // ------------------------------------------
  // PASS 3: Extract Required Nodes
  // ------------------------------------------

  for await (const block of toAsyncGenerator(getBlockStream())) {
    console.log('Extracting nodes...');
    if (signal.aborted) throw new Error('Stream aborted');

    // Type Guard: Skip the Header Block
    if (!isPrimitiveBlock(block)) continue;

    // Low-level skip: Only pay the JSON tax if the block contains nodes
    const hasNodes = block.primitivegroup?.some(
      (g) => (g.dense && g.dense.id.length > 0) || (g.nodes && g.nodes.length > 0),
    );
    if (!hasNodes) continue;

    for (const entity of blocksToJsonEntities(block)) {
      if (isOsmEntity(entity) && isOsmNode(entity) && requiredNodes.has(entity.id)) {
        extractedElements.set(`node_${entity.id}`, entity);
      }
    }
  }

  const finalElements = Array.from(extractedElements.values());
  console.log(`Extraction complete. Total elements extracted: ${finalElements.length}`);

  return { elements: finalElements };
}

export async function fetchGeofabrikBoundaries(
  countryCode: string,
  signal: AbortSignal,
): Promise<OsmData> {
  const cache = getCache();
  const cacheKey = geofabrikCacheKey(countryCode);

  const cached = await cache.get<OsmData>(cacheKey);
  if (cached) {
    console.log(`Geofabrik cache hit for ${countryCode}`);
    return cached;
  }

  const pbfPath = await ensureRawPbf(countryCode, signal);
  console.log(`Extracting admin boundaries...`);
  const osmData = await extractAdminBoundaries(pbfPath, signal);

  if (osmData.elements.length === 0) {
    throw new Error(`No admin boundaries found for country code: ${countryCode}`);
  }

  await cache.set(cacheKey, osmData).catch((err) => {
    console.error(`Failed to write extraction to local cache for "${countryCode}":`, err);
  });

  return osmData;
}
