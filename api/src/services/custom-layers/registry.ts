import type { CustomLayerDefinition, CustomLayerInfo } from './types.ts';

/**
 * Registry of custom boundary layers indexed by 2-letter ISO country code.
 */
export const CUSTOM_LAYERS_REGISTRY: Record<string, CustomLayerDefinition[]> = {
  MW: [
    {
      id: 'mw_epa',
      countryCode: 'MW',
      name: 'Extension Planning Areas (EPA)',
      category: 'agriculture',
      description:
        'Frontline agricultural planning and extension areas under the Ministry of Agriculture, covering all agricultural divisions, forest reserves, and municipal areas.',
      citation: {
        sourceName: 'Malawi Spatial Data Portal (MASDAP) / Ministry of Agriculture',
        sourceUrl: 'https://www.masdap.mw/catalogue/#/dataset/119',
        retrievalDate: '2026-10-22',
        details:
          'Official Agricultural Extension Planning Areas (EPA) published by the Department of Surveys and Department of Agricultural Extension Services (DAES).',
        license: 'Malawi Government Open Spatial Data',
      },
      filePath: 'data/custom-layers/MW/mw_epa.geojson',
      propertyMapping: {
        idKey: 'id',
        nameKey: 'name',
        extraKeys: ['district', 'unit_type'],
      },
    },
  ],
};

export function getCustomLayersForCountry(countryCode?: string): CustomLayerDefinition[] {
  if (!countryCode) return [];
  return CUSTOM_LAYERS_REGISTRY[countryCode.toUpperCase()] || [];
}

export function getCustomLayerInfoForCountry(countryCode?: string): CustomLayerInfo[] {
  return getCustomLayersForCountry(countryCode).map(
    ({ id, countryCode: cc, name, category, description, citation }) => ({
      id,
      countryCode: cc,
      name,
      category,
      description,
      citation,
    }),
  );
}
