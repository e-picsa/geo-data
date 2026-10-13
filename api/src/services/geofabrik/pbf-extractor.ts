import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type { OsmEntity, OsmNode, OsmRelation, OsmWay } from 'osmix';
import { isOsmType, isPrimitiveBlock } from './pbf-entity-guards.ts';
import type { ExtractedOsmData } from './boundary-cache.ts';

export interface ExtractorOptions {
  countryCode: string;
  adminLevels?: number[] | Set<number>;
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

const DEFAULT_ADMIN_LEVELS = new Set([2, 3, 4, 5, 6]);

// Valid roles for boundary geometries.
export const VALID_BOUNDARY_ROLES = new Set(['outer', 'inner', '']);

// Valid roles for administrative reference nodes (town center, boma, or cartographic label point).
export const VALID_NODE_ROLES = new Set(['admin_centre', 'label']);

export class PbfBoundaryExtractor {
  private readonly adminLevels: Set<number>;

  constructor(
    private readonly pbfPath: string,
    private readonly signal: AbortSignal,
    public options: ExtractorOptions,
  ) {
    this.adminLevels = options.adminLevels ? new Set(options.adminLevels) : DEFAULT_ADMIN_LEVELS;
  }

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
    console.log(`Scanning for admin_levels=[${Array.from(this.adminLevels).join(',')}]...`);
    const { countryCode } = this.options;

    const requiredWays = new Set<number>();
    const requiredNodes = new Set<number>();

    // PASS 1: Relations
    const relationsRaw = await this.filterBlocks<OsmRelation>('relation', (entity) => {
      const tags = entity.tags;
      if (!tags || tags.boundary !== 'administrative' || !tags.admin_level) return false;
      if (!this.adminLevels.has(Number(tags.admin_level))) return false;

      // Filter to include target country (where tagged)
      const iso1Code = tags['ISO3166-1'];
      if (iso1Code && iso1Code !== countryCode) return false;
      const iso2Code = tags['ISO3166-2'];
      if (iso2Code && !`${iso2Code}`.startsWith(`${countryCode}-`)) return false;

      return true;
    });

    // Filter relation members to only include valid ways and reference nodes (admin_centre / label)
    const relations = relationsRaw.map((relation) => {
      relation.members = relation.members.filter((member) => {
        const { type, role = '' } = member;
        if (type === 'way' && VALID_BOUNDARY_ROLES.has(role)) return true;
        if (type === 'node' && VALID_NODE_ROLES.has(role)) return true;
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

    console.log(
      `Found ${relations.length} relations requiring ${requiredWays.size} ways and ${requiredNodes.size} reference nodes.`,
    );

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

    console.log(`Found ${ways.length} ways requiring ${requiredNodes.size} total nodes.`);

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
          console.log(`Fast-forward: Reached end of ${targetType}s at block ${blockCount}`);
          break streamLoop;
        }

        // 2. WRONG-TYPE CHECK (Fast-Forward skipping)
        if (!isOsmType(targetType, firstEntity)) {
          continue;
        }

        // 3. PROCESS THE BLOCK
        if (filterFn(firstEntity as T)) {
          entities.push(this.trimEntityTags(firstEntity) as T);
        }

        for (const entity of entityIterator) {
          if (filterFn(entity as T)) {
            entities.push(this.trimEntityTags(entity) as T);
          }
        }
      }

      if (blockCount % PROGRESS_EVERY_BLOCKS === 0) {
        const elapsedSec = ((performance.now() - start) / 1000).toFixed(1);
        console.log(`Processed ${blockCount} blocks (${elapsedSec}s)... found ${entities.length}`);
      }
    }

    return entities;
  }

  private trimEntityTags(entity: OsmEntity): OsmEntity {
    if (entity.type !== 'relation' || !entity.tags) return entity;

    const trimmedTags: Record<string, string> = {};
    for (const [key, value] of Object.entries(entity.tags)) {
      if (RELATION_TAG_ALLOWLIST.has(key)) {
        trimmedTags[key] = value;
      }
    }
    return { ...entity, tags: trimmedTags };
  }
}
