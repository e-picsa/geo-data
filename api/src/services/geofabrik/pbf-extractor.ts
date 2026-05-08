import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type { OsmEntity, OsmNode, OsmRelation, OsmWay } from 'osmix';
import type { ExtractedOsmData } from './boundary-cache.ts';
import { isOsmType, isPrimitiveBlock } from './pbf-entity-guards.ts';

export interface ExtractorOptions {
  adminLevel: number;
  countryCode?: string;
  progressEveryNBlocks?: number;
}

const IGNORED_TAGS = new Set(['created_by']);

export class PbfBoundaryExtractor {
  private readonly adminLevel: string;
  private readonly countryCode: string;
  private readonly progressEveryNBlocks: number;

  constructor(
    private readonly pbfPath: string,
    private readonly signal: AbortSignal,
    options: ExtractorOptions,
  ) {
    this.adminLevel = `${options.adminLevel}`;
    this.countryCode = options.countryCode ?? '';
    this.progressEveryNBlocks = options.progressEveryNBlocks ?? 1000;
  }

  async extract(): Promise<ExtractedOsmData> {
    const { nodes, ways, relations } = await this.extractData();
    return { relations, ways, nodes };
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw new Error('Stream aborted');
  }

  private openBlockStream() {
    return Bun.file(this.pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());
  }

  /**
   * OSM stores data bottom-up [...nodes, ...ways, ...relations], however
   * filtering is typically top-down (relations specify ways which have nodes).
   * We essentially need to process in reverse to build full dependency chains,
   * however this is not possible with protobuf format, so instead need to make multiple passes
   *
   * TODO - performance could be drastically improved either using native osmium bindings
   * to extract each data type, or smarter methods to identify where to start processing blocks from
   * (e.g. relations usually near the end, nodes only at the start)
   */
  private async extractData() {
    console.log(`Multi-pass extraction: Scanning for admin_level=${this.adminLevel}...`);

    // List of required ways and nodes will be updated during processing
    const requiredWays = new Set<number>();
    const requiredNodes = new Set<number>();

    // Relations
    const relations = await this.filterBlocks<OsmRelation>('relation', ({ tags }) => {
      if (!tags) return false;
      if (tags.boundary !== 'administrative') return false;
      // If filtering level 2 ignore relations for countries that share border (if tagged)
      if (this.adminLevel === '2' && this.countryCode) {
        const isoCode = tags['ISO3166-1'];
        if (isoCode && isoCode !== this.countryCode) {
          return false;
        }
      }
      if (tags.admin_level && `${tags.admin_level}` !== this.adminLevel) return false;
      return true;
    });

    // Relation-specified ways and admin centre nodes
    relations.forEach(({ members }) =>
      members.forEach(({ type, ref, role }) => {
        if (type === 'way') requiredWays.add(ref);
        else if (type === 'node' && role === 'admin_centre') {
          requiredNodes.add(ref);
        }
      }),
    );

    // Ways
    const ways = await this.filterBlocks<OsmWay>('way', ({ id }) => requiredWays.has(id));
    ways.forEach(({ refs }) => refs.forEach((ref) => requiredNodes.add(ref)));

    // Nodes
    const nodes = await this.filterBlocks<OsmNode>('node', ({ id }) => requiredNodes.has(id));
    return { nodes, ways, relations };
  }

  private async filterBlocks<T extends OsmEntity>(
    type: 'relation' | 'way' | 'node',
    filterFn = (entity: T) => true,
  ): Promise<T[]> {
    const start = performance.now();
    let blockCount = 0;
    const entities: T[] = [];

    // Label the outer loop so we can kill the stream from inside the entity loop
    streamLoop: for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      blockCount++;
      if (isPrimitiveBlock(block)) {
        for (const entity of blocksToJsonEntities(block)) {
          // 1. OVER-SHOOT CHECK:
          // If we see an entity type that comes AFTER our target, kill the entire stream.
          if (type === 'node' && isOsmType('way', entity)) {
            console.log(`Way detected, stop processing nodes`);
            break streamLoop;
          }
          if (type === 'way' && isOsmType('relation', entity)) {
            console.log(`Relation detected, stop processing ways`);
            break streamLoop;
          }
          // 2. Under shoot check
          if (!isOsmType(type, entity)) {
            continue;
          }

          // 3. TARGET ZONE:
          // We are in the correct topological zone. Apply any other filter functions.
          if (filterFn(entity as T)) {
            entities.push(this.cleanEntityData(entity as T));
          }
        }
      }
      if (blockCount % this.progressEveryNBlocks === 0) {
        console.log(`  Scanned ${blockCount} blocks`);
      }
    }
    const end = performance.now();
    const duration = ((end - start) / 1000).toFixed(1);
    console.log(`${type} extracted in (${duration})s`);
    return entities;
  }

  /** Strip localised metadata from relations (e.g. ISO3166-1:alpha3 or name:ar) */
  private cleanEntityData<T extends OsmEntity>(entity: T) {
    const { id, tags, ...rest } = entity;
    // clean and remove empty tags
    if (tags) {
      // TODO - eventually define list of tags to include

      const cleanedTags = Object.fromEntries(
        Object.entries(tags).filter(([key]) => !key.includes(':') && !IGNORED_TAGS.has(key)),
      );
      if (Object.keys(cleanedTags).length > 0) {
        return { id, tags: cleanedTags, ...rest } as T;
      } else {
        return { id, ...rest } as T;
      }
    }
    // order so tags appear after id (easier debugging)
    return { id, tags, ...rest } as T;
  }
}
