import { nodeToFeature, relationToFeature } from '@osmix/geojson';
import type { ExtractedOsmData } from './boundary-cache.ts';
// Note: You may need to install @types/geojson for the FeatureCollection types
import type { FeatureCollection, Feature } from 'geojson';
import type { OsmNode, OsmWay } from 'osmix';

/**
 * Converts extracted OSM entities into a valid GeoJSON FeatureCollection.
 */
export function convertToGeoJSON(data: ExtractedOsmData, adminLevel: number): FeatureCollection {
  const { nodes, ways, relations } = data;

  // 1. Filter out relations that are part of external data sets (e.g. partial border relation)
  const filteredRelations = relations.filter((relation) => {
    const { tags = {}, members } = relation;
    // Ensure admin level matches and all ways and nodes exist
    if (tags.admin_level === `${adminLevel}`) {
      const missingEntry = members.find(
        ({ type, ref }) =>
          (type === 'way' && !(ref in ways)) || (type === 'node' && !(ref in nodes)),
      );
      if (missingEntry) {
        const { type, ref } = missingEntry;
        const { id, tags } = relation;
        const url1 = `https://www.openstreetmap.org/relation/${id}`;
        const url2 = `https://www.openstreetmap.org/${type}/${ref}`;
        console.warn('Skip missing entry (likely different country)', url1, url2, { id, tags });
        return false;
      }
      return true;
    }
  });

  // 2. Define resolution callbacks
  const refToPosition = (ref: number): [number, number] => {
    const coords = nodes[ref];
    if (!coords) {
      // Fail fast on missing geometry rather than producing invalid GeoJSON
      const url = `https://www.openstreetmap.org/node/${ref}`;
      throw new Error(`Generation failed: Node ${ref} is missing from the extract.\n${url}`);
    }
    return coords;
  };

  const getWay = (id: number): OsmWay => {
    const refs = ways[id];
    if (!refs) {
      // Fail fast on missing geometry rather than producing invalid GeoJSON
      const url = `https://www.openstreetmap.org/way/${id}`;
      throw new Error(`Generation failed: Way ${id} is missing from the extract.\n${url}`);
    }
    return { id, refs };
  };
  // 3. Process entities into features
  console.log('Constructing GeoJSON features...');
  const features: Feature[] = [];

  // Convert Relations
  // Administrative boundaries are primarily built from multipolygon relations.
  for (const relation of filteredRelations) {
    try {
      features.push(relationToFeature(relation, refToPosition, getWay));
    } catch (error) {
      console.error(`Failed to generate feature for relation ${relation.id}:`, error);
      throw error;
    }
  }

  // Add admin centre nodes as features
  for (const { members } of filteredRelations) {
    for (const { ref, type, role } of members) {
      if (type === 'node' && role === 'admin_centre') {
        const node = nodes[ref];
        if (node) {
          const [lon, lat] = node;
          features.push(nodeToFeature({ id: ref, lat, lon }));
        }
      }
    }
  }

  console.log(`Conversion complete. Generated ${features.length} features.`);

  return {
    type: 'FeatureCollection',
    features,
  };
}
