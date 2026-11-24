/**
 * Standard citation metadata for external geospatial datasets.
 */
export interface LayerCitation {
  /** Name of the providing entity / source catalog */
  sourceName: string;
  /** Direct URL or landing page for the source dataset */
  sourceUrl: string;
  /** Date the dataset was originally published / produced by the source */
  publicationDate?: string;
  /** Date the dataset was retrieved / archived (provenance, not the data vintage) */
  retrievalDate: string;
  /** Detailed attribution, publication context, or ministry notice */
  details: string;
  /** License or usage terms, if specified */
  license?: string;
}

/**
 * Coverage transparency for a custom layer: which vintage the polygons
 * represent and which known names have no polygon (yet).
 */
export interface CustomLayerCoverage {
  /** Catalogue vintage of the polygon geometries (not the retrieval date) */
  vintage: string;
  /** Number of features with polygons in this layer */
  featureCount: number;
  /** Known names with no polygon in this layer (see name registry) */
  omitted: string[];
  /** Human-readable note, surfaced in API responses and the web UI */
  note: string;
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
  /** Coverage transparency (vintage + names known to lack polygons) */
  coverage?: CustomLayerCoverage;
  /** Path to the source GeoJSON file (relative to api root or absolute) */
  filePath: string;
  /**
   * Optional row filter applied to source features before normalization.
   * Useful when one source file backs several layers (e.g. an EPA-only
   * layer and a wall-to-wall layer sharing the same MASDAP file).
   */
  featureFilter?: {
    /** Source property to match on (e.g. "unit_type") */
    property: string;
    /** Keep features whose property equals one of these values */
    equals: string | string[];
  };
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
  coverage?: CustomLayerCoverage;
}
