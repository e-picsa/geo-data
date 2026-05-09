import type { OsmRelation } from 'osmix';
import { getCache } from '../../utils/cache';

export interface ExtractedOsmData {
  relations: OsmRelation[];
  /** Ways maintain a record of node refs by id */
  ways: Record<number, number[]>;
  /** Nodes will have been converted from osm to simpler format for processing */
  nodes: Record<number, [number, number]>;
}

export class BoundaryCache {
  constructor(
    private readonly countryCode: string,
    private readonly cacheVersion: number,
  ) {}

  private key(kind: 'relations' | 'ways' | 'nodes'): string {
    return `geofabrik/v${this.cacheVersion}/extracted/${this.countryCode}/${kind}.json`;
  }

  async load(): Promise<ExtractedOsmData | null> {
    const cache = getCache();
    const [relations, ways, nodes] = await Promise.all([
      cache.get<OsmRelation[]>(this.key('relations')),
      cache.get<Record<number, number[]>>(this.key('ways')),
      cache.get<Record<number, [number, number]>>(this.key('nodes')),
    ]);

    if (!relations || !ways || !nodes) return null;

    return { relations, ways, nodes };
  }

  async save(data: ExtractedOsmData): Promise<void> {
    const cache = getCache();
    const writes: Promise<unknown>[] = [];

    const writeIfNonEmpty = <T>(key: ReturnType<BoundaryCache['key']>, data: T, label: string) => {
      if (Array.isArray(data) && data.length === 0) return;
      writes.push(
        cache.set(key, data).catch((err) => {
          console.error(`Failed to cache ${label} for ${this.countryCode}:`, err);
        }),
      );
    };

    writeIfNonEmpty(this.key('relations'), data.relations, 'relations');
    writeIfNonEmpty(this.key('ways'), data.ways, 'ways');
    writeIfNonEmpty(this.key('nodes'), data.nodes, 'nodes');

    await Promise.all(writes);
  }
}
