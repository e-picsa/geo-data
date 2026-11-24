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
        'Frontline agricultural planning and extension areas under the Ministry of Agriculture (EPAs only; forest reserves, parks and urban areas are excluded — see mw_planning_units for the wall-to-wall dataset).',
      citation: {
        sourceName: 'Malawi Spatial Data Portal (MASDAP) / Ministry of Agriculture',
        sourceUrl: 'https://www.masdap.mw/catalogue/#/dataset/119',
        retrievalDate: '2026-10-22',
        details:
          'Official Agricultural Extension Planning Areas (EPA) published by the Department of Surveys and Department of Agricultural Extension Services (DAES). Source catalogue vintage 2013-11-18, retrieved 2026-10-22: 186 EPA polygons. Newer EPAs (e.g. Chiluwa, Salima) and retired names (e.g. Likangala, now Mpokwe) have no polygon here — see coverage.omitted and data/custom-layers/MW/mw_epa_name_registry.json. Filtered to unit_type=epa from the source file.',
        license: 'Malawi Government Open Spatial Data',
      },
      coverage: {
        vintage: 'MASDAP catalogue 2013-11-18 (retrieved 2026-10-22)',
        featureCount: 186,
        omitted: [
          'Chikwatula',
          'Chiluwa',
          'Domasi',
          'Katerera',
          'Likangala',
          'Makande',
          'Matenje',
          'Mkwinda',
          'Mtunthama',
          'Muona',
          'Nkanakhothi',
          'Nkhamenya',
          'Nkhate',
        ],
        note: '13 names known from AES-2003-2010 records have no polygon in this 2013-vintage layer (newer splits e.g. Chiluwa; retired merges e.g. Likangala→Mpokwe). Full list with sources in mw_epa_name_registry.json.',
      },
      filePath: 'data/custom-layers/MW/mw_epa.geojson',
      propertyMapping: {
        idKey: 'id',
        nameKey: 'name',
        extraKeys: ['district'],
      },
      featureFilter: {
        property: 'unit_type',
        equals: 'epa',
      },
    },
    {
      id: 'mw_planning_units',
      countryCode: 'MW',
      name: 'Planning Units (all types)',
      category: 'agriculture',
      description:
        'Wall-to-wall MASDAP planning units: EPAs plus forest reserves, national parks, game reserves, towns/bomas/cities and other non-EPA units. Use the unit_type property (epa, forest_reserve, national_park, other) to distinguish.',
      citation: {
        sourceName: 'Malawi Spatial Data Portal (MASDAP) / Ministry of Agriculture',
        sourceUrl: 'https://www.masdap.mw/catalogue/#/dataset/119',
        retrievalDate: '2026-10-22',
        details:
          'Full planning-unit dataset (catalogue vintage 2013-11-18, retrieved 2026-10-22) published by the Department of Surveys and Department of Agricultural Extension Services (DAES); unfiltered source also containing reserves, parks and urban areas alongside EPAs.',
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
    ({ id, countryCode: cc, name, category, description, citation, coverage }) => ({
      id,
      countryCode: cc,
      name,
      category,
      description,
      citation,
      ...(coverage ? { coverage } : {}),
    }),
  );
}
