import { relationToFeature } from '@osmix/geojson';
import type { ExtractedOsmData } from './boundary-cache.ts';
import type { FeatureCollection, Feature } from 'geojson';
import type { OsmEntityType, OsmTags, OsmWay } from 'osmix';
import { VALID_BOUNDARY_ROLES } from './pbf-extractor.ts';

/**
 * Converts extracted OSM entities into a valid GeoJSON FeatureCollection.
 */
export function convertToGeoJSON(data: ExtractedOsmData): FeatureCollection {
  const { nodes, ways, relations } = data;

  const skippedFeatures: { id: number; ref: number; type: OsmEntityType; tags?: OsmTags }[] = [];

  // 1. Filter out relations that are missing required boundary ways (e.g. partial border relations or external datasets)
  const filteredRelations = relations.filter((relation) => {
    const { members } = relation;
    // Only boundary ways are strictly required to construct the polygon geometry.
    // Missing admin_centre or label nodes must NOT drop the relation.
    const missingWay = members.find(
      ({ type, ref, role = '' }) =>
        type === 'way' && VALID_BOUNDARY_ROLES.has(role) && !(ref in ways),
    );
    if (missingWay) {
      const { type, ref } = missingWay;
      const { id, tags } = relation;
      skippedFeatures.push({ id, type, ref, tags });
      return false;
    }
    return true;
  });

  // debug logging
  const relationsByAdminLevel: Record<string, number> = {};
  filteredRelations.forEach(({ tags }) => {
    const adminLevel = tags?.admin_level || 'unknown';
    relationsByAdminLevel[adminLevel] ??= 0;
    relationsByAdminLevel[adminLevel]++;
  });
  skippedFeatures.forEach(({ id, ref, type, tags }) => {
    const url1 = `https://www.openstreetmap.org/relation/${id}`;
    const url2 = `https://www.openstreetmap.org/${type}/${ref}`;
    console.warn('Skip missing entry (likely different country)', url1, url2, { id, tags });
  });
  console.log({ relationsByAdminLevel });

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
      const feature = relationToFeature(relation, refToPosition, getWay);

      // Extract admin_centre and label candidate coordinates from relation members
      let adminCentre: [number, number] | undefined;
      let labelPoint: [number, number] | undefined;

      for (const member of relation.members) {
        if (member.type === 'node') {
          if (member.role === 'admin_centre' && nodes[member.ref]) {
            adminCentre = nodes[member.ref];
          } else if (member.role === 'label' && nodes[member.ref]) {
            labelPoint = nodes[member.ref];
          }
        }
      }

      const extraProps: Record<string, unknown> = {};
      if (adminCentre) extraProps.admin_centre = adminCentre;
      if (labelPoint) extraProps.label_point = labelPoint;

      feature.properties = {
        ...feature.properties,
        ...extraProps,
      };

      features.push(feature);
    } catch (error) {
      console.error(`Failed to generate feature for relation ${relation.id}:`, error);
      throw error;
    }
  }

  console.log(`Conversion complete. Generated ${features.length} features.`);

  return {
    type: 'FeatureCollection',
    features,
  };
}
