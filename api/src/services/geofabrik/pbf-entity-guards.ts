import type {
  OsmEntity,
  OsmNode,
  OsmPbfBlock,
  OsmPbfHeaderBlock,
  OsmRelation,
  OsmWay,
} from 'osmix';

export function isPrimitiveBlock(block: OsmPbfHeaderBlock | OsmPbfBlock): block is OsmPbfBlock {
  return 'primitivegroup' in block;
}

const OSM_TYPE_CHECK = {
  node: isOsmNode,
  way: isOsmWay,
  relation: isOsmRelation,
} as const;
type OsmType = keyof typeof OSM_TYPE_CHECK;

export function isOsmType(type: OsmType, entity: OsmEntity) {
  return OSM_TYPE_CHECK[type](entity);
}

export function isOsmRelation(entity: OsmEntity): entity is OsmRelation {
  return 'members' in entity;
}

export function isOsmWay(entity: OsmEntity): entity is OsmWay {
  return 'refs' in entity;
}

export function isOsmNode(entity: OsmEntity): entity is OsmNode {
  return 'lat' in entity && 'lon' in entity;
}

export function blockHasRelations(block: OsmPbfBlock): boolean {
  return block.primitivegroup?.some((g) => g.relations?.length) ?? false;
}

export function blockHasWays(block: OsmPbfBlock): boolean {
  return block.primitivegroup?.some((g) => g.ways?.length) ?? false;
}

export function blockHasNodes(block: OsmPbfBlock): boolean {
  return (
    block.primitivegroup?.some((g) => (g.dense && g.dense.id.length > 0) || g.nodes?.length) ??
    false
  );
}
