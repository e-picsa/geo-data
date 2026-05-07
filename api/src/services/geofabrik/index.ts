export {
  fetchGeofabrikBoundaries,
  type FetchGeofabrikOptions,
  type OsmData,
} from './fetch-geofabrik.ts';
export { type ExtractedOsmData } from './boundary-cache.ts';
export { type ExtractorOptions, PbfBoundaryExtractor } from './pbf-extractor.ts';
export { BoundaryCache } from './boundary-cache.ts';
export { ensureRawPbf, rawPbfPath } from './raw-pbf.ts';
export {
  isPrimitiveBlock,
  isOsmRelation,
  isOsmWay,
  isOsmNode,
  blockHasRelations,
  blockHasWays,
  blockHasNodes,
} from './pbf-entity-guards.ts';
