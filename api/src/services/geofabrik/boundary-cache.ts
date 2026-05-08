import type { OsmNode, OsmRelation, OsmWay } from 'osmix';
import { getCache } from '../../utils/cache.ts';

export interface ExtractedOsmData {
  relations: OsmRelation[];
  ways: OsmWay[];
  nodes: OsmNode[];
}

export class BoundaryCache {
  constructor(
    private readonly countryCode: string,
    private readonly adminLevel: number,
    private readonly cacheVersion: number,
  ) {}

  private key(kind: 'relations' | 'ways' | 'nodes'): string {
    return `geofabrik/v${this.cacheVersion}/extracted/${this.countryCode}/admin-${this.adminLevel}/${kind}.json`;
  }

  async load(): Promise<ExtractedOsmData | null> {
    const cache = getCache();
    const [relations, ways, nodes] = await Promise.all([
      cache.get<OsmRelation[]>(this.key('relations')),
      cache.get<OsmWay[]>(this.key('ways')),
      cache.get<OsmNode[]>(this.key('nodes')),
    ]);

    if (!relations || !ways || !nodes) return null;

    return { relations, ways, nodes };
  }

  async save(data: ExtractedOsmData): Promise<void> {
    const cache = getCache();
    const writes: Promise<unknown>[] = [];

    const writeIfNonEmpty = <T>(
      key: ReturnType<BoundaryCache['key']>,
      elements: T[],
      label: string,
    ) => {
      if (elements.length === 0) return;
      writes.push(
        cache.set(key, elements).catch((err) => {
          console.error(
            `Failed to cache ${label} for ${this.countryCode} admin-${this.adminLevel}:`,
            err,
          );
        }),
      );
    };

    writeIfNonEmpty(this.key('relations'), data.relations, 'relations');
    writeIfNonEmpty(this.key('ways'), data.ways, 'ways');
    writeIfNonEmpty(this.key('nodes'), data.nodes, 'nodes');

    await Promise.all(writes);
  }
}
