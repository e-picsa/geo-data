import { nodeToFeature, relationToFeature } from '@osmix/geojson';
import type { ExtractedOsmData } from './boundary-cache.ts';
// Note: You may need to install @types/geojson for the FeatureCollection types
import type { FeatureCollection, Feature } from 'geojson';

/**
 * Converts extracted OSM entities into a valid GeoJSON FeatureCollection.
 */
export function convertToGeoJSON(data: ExtractedOsmData): FeatureCollection {
  const { nodes, ways, relations } = data;

  // 1. Build in-memory indexes for O(1) resolution
  console.log('Building geometry lookup indexes...');
  const nodeIndex = new Map<number, [number, number]>();
  for (const node of nodes) {
    if (typeof node.lon === 'number' && typeof node.lat === 'number') {
      nodeIndex.set(node.id, [node.lon, node.lat]);
    }
  }

  const wayIndex = new Map<number, (typeof ways)[0]>();
  for (const way of ways) {
    wayIndex.set(way.id, way);
  }

  // 2. Define resolution callbacks
  const refToPosition = (ref: number): [number, number] => {
    const coords = nodeIndex.get(ref);
    if (!coords) {
      // Fail fast on missing geometry rather than producing invalid GeoJSON
      throw new Error(`Coordinate resolution failed: Node ${ref} is missing from the extract.`);
    }
    return coords;
  };

  const getWay = (wayId: number) => wayIndex.get(wayId) ?? null;

  // 3. Process entities into features
  console.log('Constructing GeoJSON features...');
  const features: Feature[] = [];

  // Convert Relations
  // Administrative boundaries are primarily built from multipolygon relations.
  for (const relation of relations) {
    try {
      features.push(relationToFeature(relation, refToPosition, getWay));
    } catch (error) {
      console.error(`Failed to generate feature for relation ${relation.id}:`, error);
    }
  }

  // Include nodes identified during extraction (admin_centre)
  for (const node of nodes) {
    features.push(nodeToFeature(node));
  }

  console.log(`Conversion complete. Generated ${features.length} features.`);

  return {
    type: 'FeatureCollection',
    features,
  };
}
