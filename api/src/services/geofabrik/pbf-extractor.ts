import { blocksToJsonEntities } from '@osmix/json';
import { OsmPbfBytesToBlocksTransformStream, toAsyncGenerator } from '@osmix/pbf';
import type { OsmNode, OsmRelation, OsmWay } from 'osmix';
import type { ExtractedOsmData } from './boundary-cache.ts';
import {
  blockHasNodes,
  blockHasRelations,
  blockHasWays,
  isOsmNode,
  isOsmRelation,
  isOsmWay,
  isPrimitiveBlock,
} from './pbf-entity-guards.ts';

export interface ExtractorOptions {
  adminLevel: number;
  progressEveryNBlocks?: number;
}

export class PbfBoundaryExtractor {
  private readonly requiredWayIds = new Set<number>();
  private readonly requiredNodeIds = new Set<number>();
  private readonly relations: OsmRelation[] = [];
  private readonly ways: OsmWay[] = [];
  private readonly nodes: OsmNode[] = [];

  private readonly adminLevel: string;
  private readonly progressEveryNBlocks: number;

  constructor(
    private readonly pbfPath: string,
    private readonly signal: AbortSignal,
    options: ExtractorOptions,
  ) {
    this.adminLevel = `${options.adminLevel}`;
    this.progressEveryNBlocks = options.progressEveryNBlocks ?? 1000;
  }

  async extract(): Promise<ExtractedOsmData> {
    const overallStart = performance.now();

    await this.scanRelations();
    const pass1Time = performance.now();

    if (this.requiredWayIds.size > 0) {
      await this.scanWays();
    }
    const pass2Time = performance.now();

    if (this.requiredNodeIds.size > 0) {
      await this.scanNodes();
    }
    const pass3Time = performance.now();

    const totalTime = Math.round(pass3Time - overallStart);
    const p1Time = Math.round(pass1Time - overallStart);
    const p2Time = Math.round(pass2Time - pass1Time);
    const p3Time = Math.round(pass3Time - pass2Time);

    console.log(
      `[PERF] Pass 1: ${p1Time}ms - found ${this.relations.length} relations, ${this.requiredWayIds.size} way refs, ${this.requiredNodeIds.size} node refs`,
    );
    if (this.requiredWayIds.size > 0) {
      console.log(
        `[PERF] Pass 2: ${p2Time}ms - found ${this.ways.length} ways, total ${this.requiredNodeIds.size} node refs`,
      );
    }
    if (this.requiredNodeIds.size > 0) {
      console.log(`[PERF] Pass 3: ${p3Time}ms - found ${this.nodes.length} nodes`);
    }
    console.log(`[PERF] Total: ${totalTime}ms`);

    return {
      relations: this.relations,
      ways: this.ways,
      nodes: this.nodes,
    };
  }

  private openBlockStream() {
    return Bun.file(this.pbfPath).stream().pipeThrough(new OsmPbfBytesToBlocksTransformStream());
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw new Error('Stream aborted');
  }

  private async scanRelations(): Promise<void> {
    console.log(`Pass 1: Scanning relations for admin_level=${this.adminLevel}...`);
    let blockCount = 0;

    for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      blockCount++;
      if (!isPrimitiveBlock(block) || !blockHasRelations(block)) continue;

      for (const entity of blocksToJsonEntities(block)) {
        if (!isOsmRelation(entity)) continue;

        const tags = entity.tags;
        if (!tags) continue;
        if (tags.boundary !== 'administrative') continue;
        if (`${tags.admin_level}` !== this.adminLevel) continue;

        this.relations.push(entity);
        this.recordRelationDependencies(entity);
      }

      if (blockCount % this.progressEveryNBlocks === 0) {
        console.log(
          `  Scanned ${blockCount} blocks - relations: ${this.relations.length}, required ways: ${this.requiredWayIds.size}`,
        );
      }
    }

    console.log(
      `Pass 1 complete. Relations: ${this.relations.length}, required ways: ${this.requiredWayIds.size}, required nodes (from relations): ${this.requiredNodeIds.size}`,
    );
  }

  private isTargetBoundary(relation: OsmRelation): boolean {
    const tags = relation.tags;
    if (!tags) return false;
    if (tags.boundary !== 'administrative') return false;
    return `${tags.admin_level}` === this.adminLevel;
  }

  private recordRelationDependencies(relation: OsmRelation): void {
    for (const member of relation.members) {
      if (member.type === 'way') {
        this.requiredWayIds.add(member.ref);
      } else if (member.type === 'node' && member.role === 'admin_centre') {
        this.requiredNodeIds.add(member.ref);
      }
    }
  }

  private async scanWays(): Promise<void> {
    console.log('Pass 2: Extracting required ways...');
    let remaining = this.requiredWayIds.size;

    for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      if (!isPrimitiveBlock(block) || !blockHasWays(block)) continue;
      if (remaining === 0) break;

      for (const entity of blocksToJsonEntities(block)) {
        if (!isOsmWay(entity) || !this.requiredWayIds.has(entity.id)) continue;

        this.ways.push(entity);
        remaining--;
        for (const nodeId of entity.refs) {
          this.requiredNodeIds.add(nodeId);
        }
      }
    }

    console.log(
      `Pass 2 complete. Ways: ${this.ways.length}, total required nodes: ${this.requiredNodeIds.size}`,
    );
  }

  private async scanNodes(): Promise<void> {
    console.log('Pass 3: Extracting required nodes...');
    let remaining = this.requiredNodeIds.size;

    for await (const block of toAsyncGenerator(this.openBlockStream())) {
      this.checkAborted();
      if (!isPrimitiveBlock(block)) continue;
      if (blockHasWays(block)) break;
      if (!blockHasNodes(block)) continue;
      if (remaining === 0) break;

      for (const entity of blocksToJsonEntities(block)) {
        if (!isOsmNode(entity) || !this.requiredNodeIds.has(entity.id)) {
          continue;
        }
        this.nodes.push(entity);
        remaining--;
      }
    }

    console.log(`Pass 3 complete. Nodes: ${this.nodes.length}`);
  }
}
