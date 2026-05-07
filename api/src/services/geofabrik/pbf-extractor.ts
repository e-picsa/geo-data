import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type { OsmNode, OsmRelation, OsmWay } from 'osmix';
import type { ExtractedOsmData } from './boundary-cache.ts';
import { isOsmNode, isOsmRelation, isOsmWay, isPrimitiveBlock } from './pbf-entity-guards.ts';

export interface ExtractorOptions {
  adminLevel: number;
  countryCode?: string;
  progressEveryNBlocks?: number;
}

type WayRefs = number[];

type LatLon = [number, number];

export class PbfBoundaryExtractor {
  private wayIndex = new Map<number, WayRefs>();
  private nodeIndex = new Map<number, LatLon>();
  private relationsIndex = new Map<number, OsmRelation>();

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
    const overallStart = performance.now();
    await this.singlePass();

    const { nodes, ways, relations } = this.buildResults();

    console.log(`[PERF] Total: ${Math.round(performance.now() - overallStart)}ms`);

    return { relations, ways, nodes };
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw new Error('Stream aborted');
  }

  private async singlePass(): Promise<void> {
    let blockCount = 0;

    console.log(`Single pass: Scanning for admin_level=${this.adminLevel}...`);

    for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      blockCount++;

      if (isPrimitiveBlock(block)) {
        for (const entity of blocksToJsonEntities(block)) {
          if (isOsmNode(entity)) {
            this.nodeIndex.set(entity.id, [entity.lat, entity.lon]);
            continue;
          }
          if (isOsmRelation(entity)) {
            this.processRelation(entity);
            continue;
          }
          if (isOsmWay(entity)) {
            this.wayIndex.set(entity.id, entity.refs);
            continue;
          }
        }
      }

      if (blockCount % this.progressEveryNBlocks === 0) {
        console.log(`  Scanned ${blockCount} blocks`);
      }
    }
  }

  private openBlockStream() {
    return Bun.file(this.pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());
  }

  private processRelation(entity: OsmRelation): void {
    const tags = entity.tags;
    if (!tags) return;
    if (tags.boundary !== 'administrative') return;

    if (this.adminLevel === '2' && this.countryCode) {
      const isoCode = tags['ISO3166-1'];
      if (isoCode && isoCode !== this.countryCode) {
        return;
      }
    }

    if (`${tags.admin_level}` !== this.adminLevel) return;

    this.relationsIndex.set(entity.id, entity);
  }

  private buildResults() {
    const relations: OsmRelation[] = [];
    const ways: OsmWay[] = [];
    const nodes: OsmNode[] = [];

    const requiredWayIds = new Set<number>();
    const requiredNodeIds = new Set<number>();

    for (const relation of this.relationsIndex.values()) {
      relations.push(relation);

      for (const member of relation.members || []) {
        if (member.type === 'way') {
          requiredWayIds.add(member.ref);
        } else if (member.type === 'node' && member.role === 'admin_centre') {
          requiredNodeIds.add(member.ref);
        }
      }
    }

    for (const wayId of requiredWayIds) {
      const refs = this.wayIndex.get(wayId);
      if (!refs) continue;

      ways.push({
        id: wayId,
        refs: refs,
        tags: {},
        members: [],
      } as OsmWay);

      for (const nodeId of refs) {
        requiredNodeIds.add(nodeId);
      }
    }

    for (const nodeId of requiredNodeIds) {
      const latlon = this.nodeIndex.get(nodeId);
      if (!latlon) continue;

      nodes.push({
        id: nodeId,
        lat: latlon[0],
        lon: latlon[1],
        tags: {},
      } as OsmNode);
    }

    console.log(
      `[PERF] Results: ${relations.length} relations, ${ways.length} ways, ${nodes.length} nodes`,
    );

    return { ways, nodes, relations };
  }
}
