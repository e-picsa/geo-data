import { relationToFeature } from '@osmix/geojson';
import type { ExtractedOsmData } from './boundary-cache.ts';
import type { FeatureCollection, Feature } from 'geojson';
import type { OsmWay } from 'osmix';
import { VALID_BOUNDARY_ROLES } from './pbf-extractor.ts';

/**
 * Converts extracted OSM entities into a valid GeoJSON FeatureCollection.
 */
export function convertToGeoJSON(data: ExtractedOsmData): FeatureCollection {
  const { nodes, ways, relations } = data;

  // 1. Filter out relations that are missing required boundary ways (e.g. cross-border relations from neighboring countries)
  const filteredRelations = relations.filter((relation) => {
    const { members } = relation;
    // Only boundary ways are strictly required to construct the polygon geometry.
    // Missing admin_centre or label nodes must NOT drop the relation.
    const missingWay = members.find(
      ({ type, ref, role = '' }) =>
        type === 'way' && VALID_BOUNDARY_ROLES.has(role) && !(ref in ways),
    );
    return !missingWay;
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
      const url = `https://www.openstreetmap.org/way/${id}`;
      throw new Error(`Generation failed: Way ${id} is missing from the extract.\n${url}`);
    }
    return { id, refs } as any;
  };

  // 3. Convert relations to features
  console.log('Constructing GeoJSON features...');
  const features: Feature[] = [];

  for (const relation of filteredRelations) {
    try {
      const feature = relationToFeature(relation, refToPosition, getWay);

      if (feature) {
        // Look up representative center nodes from relation members
        let adminCentreCoords: [number, number] | undefined;
        let labelCoords: [number, number] | undefined;

        for (const member of relation.members || []) {
          if (member.type === 'node') {
            if (member.role === 'admin_centre' && !adminCentreCoords) {
              const pt = nodes[member.ref];
              if (pt) adminCentreCoords = pt;
            } else if (member.role === 'label' && !labelCoords) {
              const pt = nodes[member.ref];
              if (pt) labelCoords = pt;
            }
          }
        }

        const props = (feature.properties ??= {});
        if (adminCentreCoords) {
          props.admin_centre = adminCentreCoords;
        }
        if (labelCoords) {
          props.label_point = labelCoords;
        }

        features.push(feature);
      }
    } catch (error) {
      console.error(`Failed to generate feature for relation ${relation.id}:`, error);
    }
  }

  console.log(`Conversion complete. Generated ${features.length} features.`);

  return {
    type: 'FeatureCollection',
    features,
  };
}
