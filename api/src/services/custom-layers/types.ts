/**
 * Standard citation metadata for external geospatial datasets.
 */
export interface LayerCitation {
  /** Name of the providing entity / source catalog */
  sourceName: string;
  /** Direct URL or landing page for the source dataset */
  sourceUrl: string;
  /** Date the dataset was retrieved / archived */
  retrievalDate: string;
  /** Detailed attribution, publication context, or ministry notice */
  details: string;
  /** License or usage terms, if specified */
  license?: string;
}

/**
 * Definition of a country-specific custom boundary layer.
 */
export interface CustomLayerDefinition {
  /** Unique layer identifier (e.g. "mw_epa") */
  id: string;
  /** 2-letter ISO country code (e.g. "MW") */
  countryCode: string;
  /** Human-readable layer title */
  name: string;
  /** Functional category */
  category: 'agriculture' | 'environment' | 'health' | 'statistical';
  /** Short description of the administrative or operational purpose */
  description: string;
  /** Source attribution and citation info */
  citation: LayerCitation;
  /** Path to the source GeoJSON file (relative to api root or absolute) */
  filePath: string;
  /** Property mapping from source features to canonical output properties */
  propertyMapping: {
    idKey: string;
    nameKey: string;
    extraKeys?: string[];
  };
}

/**
 * Public metadata info exposed in API responses (without internal file paths).
 */
export interface CustomLayerInfo {
  id: string;
  countryCode: string;
  name: string;
  category: 'agriculture' | 'environment' | 'health' | 'statistical';
  description: string;
  citation: LayerCitation;
}
