import path from 'node:path';
import type { CustomLayerDefinition } from './types.ts';
import { getCustomLayersForCountry } from './registry.ts';

export interface NormalizedCustomFeature {
  type: 'Feature';
  id?: string | number;
  geometry: any;
  properties: {
    id: string;
    name: string;
    custom_layer: string;
    layer_name: string;
    citation: string;
    [key: string]: any;
  };
}

/**
 * Loads and normalizes all custom layer features for a given country.
 */
export async function loadCustomLayerFeaturesForCountry(
  countryCode: string,
): Promise<NormalizedCustomFeature[]> {
  const definitions = getCustomLayersForCountry(countryCode);
  if (!definitions.length) return [];

  const allFeatures: NormalizedCustomFeature[] = [];

  for (const def of definitions) {
    const features = await loadCustomLayer(def);
    allFeatures.push(...features);
  }

  return allFeatures;
}

/**
 * Reads a single custom layer's GeoJSON and normalizes its feature attributes.
 */
export async function loadCustomLayer(
  definition: CustomLayerDefinition,
): Promise<NormalizedCustomFeature[]> {
  // Resolve path relative to api root
  const apiRoot = path.resolve(import.meta.dir, '../../..');
  const fullPath = path.isAbsolute(definition.filePath)
    ? definition.filePath
    : path.resolve(apiRoot, definition.filePath);

  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    console.warn(`Custom layer file not found for ${definition.id}: ${fullPath}`);
    return [];
  }

  try {
    const rawData = await file.json();
    const rawFeatures = rawData.type === 'FeatureCollection' ? rawData.features : [rawData];
    const { idKey, nameKey, extraKeys = [] } = definition.propertyMapping;

    return rawFeatures.map((f: any, idx: number) => {
      const props = f.properties || {};
      const id = String(props[idKey] || f.id || `${definition.id}_${idx + 1}`);
      const name = String(props[nameKey] || id);

      const normalizedProps: NormalizedCustomFeature['properties'] = {
        id,
        name,
        custom_layer: definition.id,
        layer_name: definition.name,
        citation: definition.citation.sourceName,
      };

      for (const k of extraKeys) {
        if (props[k] !== undefined) {
          normalizedProps[k] = props[k];
        }
      }

      return {
        type: 'Feature',
        id,
        geometry: f.geometry,
        properties: normalizedProps,
      };
    });
  } catch (err) {
    console.error(`Failed to load custom layer ${definition.id}:`, err);
    return [];
  }
}
