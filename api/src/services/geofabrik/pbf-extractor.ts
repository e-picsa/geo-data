import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type { OsmEntity, OsmNode, OsmRelation, OsmWay } from 'osmix';
import { isOsmType, isPrimitiveBlock } from './pbf-entity-guards.ts';
import type { ExtractedOsmData } from './boundary-cache.ts';

export interface ExtractorOptions {
  countryCode: string;
}

// Strictly allow only tags necessary for admin identification and rendering.
// This prevents wikidata/population/history bloat.
const RELATION_TAG_ALLOWLIST = new Set([
  'name',
  'admin_level',
  'boundary',
  'type',
  'ISO3166-1',
  'ISO3166-2',
]);

const PROGRESS_EVERY_BLOCKS = 1000;

const ADMIN_LEVELS = new Set([2, 3, 4, 5]);

// Valid roles for boundary geometries. Explicitly excludes 'subarea' and 'label'.
const VALID_BOUNDARY_ROLES = new Set(['outer', 'inner', '']);

export class PbfBoundaryExtractor {
  constructor(
    private readonly pbfPath: string,
    private readonly signal: AbortSignal,
    public options: ExtractorOptions,
  ) {}

  async extract(): Promise<ExtractedOsmData> {
    const { nodes, ways, relations } = await this.extractData();
    return {
      relations,
      ways,
      nodes,
    };
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw new Error('Stream aborted');
  }

  private openBlockStream() {
    return Bun.file(this.pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());
  }

  private async extractData() {
    console.log(`Scanning for admin_levels=[${Array.from(ADMIN_LEVELS).join(',')}]...`);
    const { countryCode } = this.options;

    const requiredWays = new Set<number>();
    const requiredNodes = new Set<number>();

    // PASS 1: Relations
    const relationsRaw = await this.filterBlocks<OsmRelation>('relation', (entity) => {
      const tags = entity.tags;
      if (!tags || tags.boundary !== 'administrative' || !tags.admin_level) return false;
      if (!ADMIN_LEVELS.has(Number(tags.admin_level))) return false;

      // Filter to includ target country (where tagged)
      const iso1Code = tags['ISO3166-1'];
      if (iso1Code && iso1Code !== countryCode) return false;
      const iso2Code = tags['ISO3166-2'];
      if (iso2Code && !`${iso2Code}`.startsWith(`${countryCode}-`)) return false;

      return true;
    });

    // Filter relation members to only include valid ways and nodes (no subareas)
    const relations = relationsRaw.map((relation) => {
      relation.members = relation.members.filter((member) => {
        const { type, role = '' } = member;
        if (type === 'way' && VALID_BOUNDARY_ROLES.has(role)) return true;

        // NOTE - admin_centre nodes can be included by uncommenting below
        // However they also bloat the topojson slightly (can have properties trimmed)
        // and so only useful if planning to actively use. Centroid for polygon can always
        // be calculated on the fly

        // if (type === 'node' && role === 'admin_centre') return true;
        return false;
      });
      return relation;
    });

    // Mark required ways and nodes
    for (const relation of relations) {
      for (const member of relation.members) {
        if (member.type === 'way') {
          requiredWays.add(member.ref);
        } else if (member.type === 'node') {
          requiredNodes.add(member.ref);
        }
      }
    }

    console.log(`Found ${relations.length} relations requiring ${requiredWays.size} ways.`);

    // PASS 2: Ways
    const ways = await this.filterBlocks<OsmWay>('way', ({ id }) => requiredWays.has(id));
    const waysRecord: Record<number, number[]> = {};
    for (const way of ways) {
      if (!way.refs) continue;
      waysRecord[way.id] = way.refs;
      for (const ref of way.refs) {
        requiredNodes.add(ref);
      }
    }

    console.log(`Found ${ways.length} ways requiring ${requiredNodes.size} nodes.`);

    // PASS 3: Nodes (Convert to flat coordinate map to save memory/JSON space)
    const rawNodes = await this.filterBlocks<OsmNode>('node', ({ id }) => requiredNodes.has(id));
    const nodesRecord: Record<number, [number, number]> = {};
    rawNodes.forEach(({ id, lat, lon }) => (nodesRecord[id] = [lon, lat]));

    return {
      relations,
      ways: waysRecord,
      nodes: nodesRecord,
    } satisfies ExtractedOsmData;
  }

  private async filterBlocks<T extends OsmEntity>(
    targetType: 'relation' | 'way' | 'node',
    filterFn: (entity: T) => boolean,
  ): Promise<T[]> {
    const start = performance.now();
    let blockCount = 0;
    const entities: T[] = [];

    streamLoop: for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      blockCount++;

      if (isPrimitiveBlock(block)) {
        const entityIterator = blocksToJsonEntities(block);

        // Peek at the first entity to determine block type (Fast-Forward logic)
        const firstIteration = entityIterator.next();
        if (firstIteration.done) continue;

        const firstEntity = firstIteration.value;

        // 1. OVER-SHOOT CHECK (Stream Termination)
        if (
          (targetType === 'node' && isOsmType('way', firstEntity)) ||
          (targetType === 'way' && isOsmType('relation', firstEntity))
        ) {
          break streamLoop;
        }

        // 2. UNDER-SHOOT CHECK (Block Skipping)
        // If the block is not our target type, skip the rest of the iterator instantly.
        if (!isOsmType(targetType, firstEntity)) {
          continue streamLoop;
        }

        // 3. TARGET ZONE (Process the block)
        // Process the first entity we already peeked at
        if (filterFn(firstEntity as T)) {
          const cleaned = this.cleanEntity(targetType, firstEntity) as T;
          entities.push(cleaned);
        }

        // Process the rest of the block
        for (const entity of entityIterator) {
          if (filterFn(entity as T)) {
            const cleaned = this.cleanEntity(targetType, entity) as T;
            entities.push(cleaned);
          }
        }
      }

      if (blockCount % PROGRESS_EVERY_BLOCKS === 0) {
        process.stdout.write(`\rScanned ${blockCount} blocks for ${targetType}s...`);
      }
    }

    process.stdout.write('\n');
    const end = performance.now();
    console.log(`${targetType} extracted in (${((end - start) / 1000).toFixed(1)}s)`);
    return entities;
  }

  // Strictly enforces the allowlist for Relation tags
  private cleanEntity<T extends OsmEntity>(type: 'relation' | 'way' | 'node', entity: T) {
    // Clean tags, and omit empty
    if (type === 'relation') {
      const relation = entity as OsmRelation;
      const { id, members, tags } = relation;
      if (tags) {
        const cleaned = Object.entries(tags).filter(([key]) => RELATION_TAG_ALLOWLIST.has(key));
        if (cleaned.length > 0) {
          return { id, tags: Object.fromEntries(cleaned), members };
        }
      }
      return { id, members };
    }
    // Keep minimal id and refs for ways
    if (type === 'way') {
      const way = entity as OsmWay;
      const { id, refs } = way;
      return { id, refs };
    }
    // Keep minimal id, lat and lon for nodes
    // (tags like admin_centre also defined in relation members data)
    if (type === 'node') {
      const node = entity as OsmNode;
      const { id, lat, lon } = node;
      return { id, lat, lon };
    }
  }
}
