import mapshaper from 'mapshaper';

import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { validateBody } from '../utils/validation.ts';
import { getCache, type CacheProvider } from '../utils/cache/index.ts';
import { BOUNDARY_REQUEST_SCHEMA } from '../types/schema.ts';
import type { BoundaryRequestParams } from '../types/schema.ts';
import { fetchGeofabrikBoundaries } from './geofabrik';
import {
  loadCustomLayerFeaturesForCountry,
  getCustomLayerInfoForCountry,
} from './custom-layers/index.ts';
import {
  stringifyTopojsonReadable,
  stripCentersFromTopojson,
  summarizeTopojson,
} from '../utils/topojson.utils.ts';
import {
  isCentroidInsideGeometry,
  getPolygonCentroid,
  getRingAreaAndCentroid,
  pointInRing,
  pointInPolygonGeometry,
} from '../utils/geometry.utils.ts';
import { corsHeaders } from '../utils/cors.ts';
import { toBoundaryErrorResponse } from './boundary-errors.ts';
export { getCountryAdminLevels } from './geofabrik/url-mapping.ts';

/**
 * Bust cache if conversion or processing methods change.
 * GCS cache object lifecycle automatically deletes after 90 days.
 */
const CACHE_VERSION = 17;

type Source = 'cache' | 'generated';

type CachePaths = {
  prefix: string;
  geojson: string;
  topojson: string;
};

export async function getBoundariesTopojson(
  countryCode: string,
  signal?: AbortSignal,
): Promise<{ topojsonString: string; source: Source }> {
  const cache = getCache();
  const paths = buildCachePaths(countryCode);

  const cachedTopojson = await readCache<any>(cache, paths.topojson);
  if (cachedTopojson) {
    console.log(`TopoJSON cache hit for ${countryCode}.`);
    const serializedTopojson = stringifyTopojsonReadable(cachedTopojson);
    return { topojsonString: serializedTopojson, source: 'cache' };
  }

  console.log(`Attempting to fetch boundaries from Geofabrik for ${countryCode}...`);
  const osmData = await fetchGeofabrikBoundaries({
    countryCode,
    signal,
  });
  console.log(`Successfully fetched boundaries from Geofabrik for ${countryCode}`);

  const customFeatures = await loadCustomLayerFeaturesForCountry(countryCode);
  const combinedGeojson =
    customFeatures.length > 0
      ? {
          ...osmData,
          features: [...(osmData.features || []), ...customFeatures],
        }
      : osmData;

  // Geofabrik country extracts are cut with a buffer, so relations from
  // neighbouring countries (e.g. a Mozambican district in the Malawi extract)
  // can slip through the tag-based extractor filter when they lack ISO tags.
  // Drop anything whose representative point falls outside the country's own
  // admin_level=2 polygon. Shared borders are unaffected: the level-2 country
  // feature itself is always kept, so border arcs stay in the topology.
  const filteredGeojson = filterCrossBorderFeatures(combinedGeojson, countryCode);

  const topojsonString = await convertGeoJsonToTopojson(filteredGeojson, paths, countryCode);

  const serializedTopojson = stringifyTopojsonReadable(JSON.parse(topojsonString));
  await writeCache(cache, paths.topojson, serializedTopojson);

  return { topojsonString: serializedTopojson, source: 'generated' };
}

/**
 * Drops features that belong to neighbouring countries but leaked into this
 * country's Geofabrik extract (buffer overlap + missing ISO tags defeat the
 * tag-based extractor filter, e.g. Angónia district appearing in Malawi).
 *
 * A feature is kept when a representative interior point (or, for concave
 * shapes, a polygon vertex) lies strictly inside the country's admin_level=2
 * geometry — strictly, so shared-border vertices at distance 0 don't count.
 * Level-2 features tagged with a foreign ISO3166-1 code are dropped
 * outright. Custom-layer features are subject to the same containment check.
 *
 * The containment union only trusts level-2 polygons affirmatively tagged
 * with our ISO3166-1 code: a neighbour's whole country polygon can be fully
 * present in enclave cases (e.g. Lesotho inside the South Africa extract),
 * and an untagged one must not launder its districts through. If nothing is
 * tagged, the largest untagged level-2 polygon is used as a fallback (the
 * requested country's own polygon is always the largest fully present one);
 * if no level-2 geometry exists at all the input is returned unfiltered
 * (fail open) rather than wiping the dataset.
 */
export function filterCrossBorderFeatures(geojson: any, countryCode: string): any {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  if (features.length === 0) return geojson;

  const upper = countryCode.toUpperCase();
  const isoPrefix = `${upper}-`;
  const isCountryLevel = (f: any) =>
    Number(f?.properties?.admin_level) === 2 && !f?.properties?.custom_layer;

  // Only ISO-affirmed polygons join the containment union. An untagged
  // neighbour (e.g. Lesotho in the South Africa extract) must not launder
  // its districts through.
  const tagged = features.filter(
    (f: any) =>
      isCountryLevel(f) && String(f?.properties?.['ISO3166-1'] ?? '').toUpperCase() === upper,
  );

  let countryGeoms = tagged;
  if (countryGeoms.length === 0) {
    const untagged = features.filter(
      (f: any) => isCountryLevel(f) && !f?.properties?.['ISO3166-1'],
    );
    untagged.sort((a: any, b: any) => bboxArea(b?.geometry) - bboxArea(a?.geometry));
    countryGeoms = untagged.slice(0, 1);
    if (countryGeoms.length > 0) {
      console.warn(
        `No ISO3166-1-tagged admin_level=2 geometry for ${upper}; falling back to largest untagged polygon.`,
      );
    }
  }

  if (countryGeoms.length === 0) {
    console.warn(`No admin_level=2 geometry for ${upper}; skipping cross-border filter.`);
    return geojson;
  }

  const kept: any[] = [];
  const droppedNames: string[] = [];

  for (const f of features) {
    const props = f?.properties || {};
    if (!props.custom_layer && Number(props.admin_level) === 2) {
      const iso = props['ISO3166-1'];
      if (iso && String(iso).toUpperCase() !== upper) {
        droppedNames.push(props.name || props.id || 'unnamed level-2');
        continue;
      }
      // Untagged level-2 polygons are only kept when one was trusted into
      // the containment union (the fallback case); any other untagged
      // country polygon is a neighbour and must not ship in the export.
      if (!iso && !countryGeoms.includes(f)) {
        droppedNames.push(props.name || props.id || 'unnamed level-2');
        continue;
      }
      kept.push(f);
      continue;
    }

    // Affirmatively tagged as ours (e.g. Likoma district MW-LK) — keep
    // regardless of geometry quirks such as exclaves.
    const iso2 = props['ISO3166-2'];
    if (iso2 && String(iso2).toUpperCase().startsWith(isoPrefix)) {
      kept.push(f);
      continue;
    }

    const inside = isInsideCountry(f?.geometry, props, countryGeoms);

    if (inside) {
      kept.push(f);
    } else {
      droppedNames.push(props.name || props.id || 'unnamed feature');
    }
  }

  if (droppedNames.length > 0) {
    console.log(
      `Filtered ${droppedNames.length} cross-border features for ${upper}: ${droppedNames.slice(0, 10).join(', ')}${droppedNames.length > 10 ? ', …' : ''}`,
    );
  }

  return { ...geojson, features: kept };
}

/**
 * Candidate interior points for containment testing, most authoritative
 * first: tagged admin centre / label point, then the whole-geometry centroid
 * (only when it falls inside its own geometry — concave shapes like Chitipa
 * fail this), then each Polygon part's centroid (only when inside its own
 * part — island districts like Likoma have a combined centroid out in the
 * lake, but per-island centroids on land).
 */
function representativePoints(geometry: any, props: any): [number, number][] {
  const pts: [number, number][] = [];
  if (Array.isArray(props?.admin_centre)) pts.push(props.admin_centre as [number, number]);
  if (Array.isArray(props?.label_point)) pts.push(props.label_point as [number, number]);

  if (!geometry?.coordinates || !Array.isArray(geometry.coordinates)) return pts;

  if (isCentroidInsideGeometry(geometry)) {
    const c = getPolygonCentroid(geometry);
    if (c) pts.push(c);
  }

  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (Array.isArray(polys)) {
    for (const poly of polys) {
      if (!Array.isArray(poly) || !Array.isArray(poly[0]) || poly[0].length === 0) continue;
      const { cx, cy } = getRingAreaAndCentroid(poly[0]);
      const pt: [number, number] = [cx, cy];
      if (!pointInRing(pt, poly[0])) continue;
      if (poly.slice(1).some((hole: number[][]) => pointInRing(pt, hole))) continue;
      pts.push(pt);
    }
  }

  return pts;
}

/** Rough bbox area in square degrees, for ranking fallback polygons. */
function bboxArea(geometry: any): number {
  if (!geometry?.coordinates || !Array.isArray(geometry.coordinates)) return -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (pt: any) => {
    if (!Array.isArray(pt) || pt.length < 2) return;
    if (typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      for (const sub of pt) visit(sub);
      return;
    }
    if (pt[0] < minX) minX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] > maxY) maxY = pt[1];
  };
  visit(geometry.coordinates);
  if (!Number.isFinite(minX)) return -Infinity;
  return (maxX - minX) * (maxY - minY);
}

/**
 * Minimum distance in degrees below which a point counts as lying ON the
 * country boundary rather than inside it. Shared-border vertices are derived
 * from the same OSM nodes, so their distance is exactly 0; genuinely inland
 * points are orders of magnitude further away (OSM precision is ~1e-7).
 */
const BOUNDARY_EPSILON = 1e-9;

function pointToSegmentDistance(pt: [number, number], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq));
  }
  const ex = a[0] + t * dx - pt[0];
  const ey = a[1] + t * dy - pt[1];
  return Math.sqrt(ex * ex + ey * ey);
}

function distanceToBoundary(pt: [number, number], geometry: any): number {
  if (!geometry?.coordinates || !Array.isArray(geometry.coordinates)) return Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let min = Infinity;
  for (const poly of polys) {
    if (!Array.isArray(poly)) continue;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointToSegmentDistance(pt, ring[j], ring[i]);
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/** Strict containment: inside the ring(s) and not merely on the boundary. */
function strictlyInsideCountry(pt: [number, number], countryGeoms: any[]): boolean {
  return countryGeoms.some(
    (g: any) =>
      pointInPolygonGeometry(pt, g?.geometry) &&
      distanceToBoundary(pt, g?.geometry) > BOUNDARY_EPSILON,
  );
}

/**
 * Whether a feature overlaps the country: any interior candidate strictly
 * inside, else any polygon vertex strictly inside. The vertex fallback covers
 * concave features (Blantyre City, Thuma FR) whose area centroids fall
 * outside their own rings. The strictness (epsilon off the boundary) is what
 * keeps neighbours out: Angónia's only "inside"-testing points are its
 * shared-border vertices at distance 0.
 */
function isInsideCountry(geometry: any, props: any, countryGeoms: any[]): boolean {
  if (representativePoints(geometry, props).some((pt) => strictlyInsideCountry(pt, countryGeoms))) {
    return true;
  }

  if (!geometry?.coordinates || !Array.isArray(geometry.coordinates)) return false;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polys)) return false;

  for (const poly of polys) {
    if (!Array.isArray(poly)) continue;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        if (strictlyInsideCountry([pt[0], pt[1]], countryGeoms)) return true;
      }
    }
  }

  return false;
}

/**
 * Narrows a TopoJSON topology to just the rendered layers: every admin level
 * down to (and including) the requested one — e.g. `admin_level=4` keeps
 * levels 2, 3 and 4 — plus the requested custom layer(s). Used by the
 * download endpoint so exports contain what the map shows.
 *
 * Custom layers are opt-in: when no `customLayers` are given, all geometries
 * with a `custom_layer` property are dropped (e.g. Malawi EPAs are excluded
 * from downloads unless `?custom_layer=mw_epa` is passed). Admin levels are
 * opt-out: when no `adminLevels` are given, all admin geometries are kept.
 * The top-level `custom_layers` metadata member is narrowed the same way
 * (removed when nothing is requested).
 */
export function filterTopojsonGeometries(
  topo: Record<string, unknown>,
  opts: { adminLevels?: number[]; customLayers?: string[] },
): Record<string, unknown> {
  const { adminLevels, customLayers } = opts;
  const hasAdminFilter = !!adminLevels && adminLevels.length > 0;

  const finiteLevels = (adminLevels || []).map(Number).filter(Number.isFinite);
  // No admin filter → keep every admin level; otherwise keep levels down to the max requested.
  const maxAdminLevel =
    finiteLevels.length > 0 ? Math.max(...finiteLevels) : Number.POSITIVE_INFINITY;
  const customSet = new Set((customLayers || []).map((c) => c.toLowerCase()));
  const objects = (topo.objects || {}) as Record<string, any>;
  const filteredObjects: Record<string, any> = {};

  for (const [key, obj] of Object.entries(objects)) {
    if (!obj || !Array.isArray(obj.geometries)) {
      filteredObjects[key] = obj;
      continue;
    }
    filteredObjects[key] = {
      ...obj,
      geometries: obj.geometries.filter((g: any) => {
        if (g?.properties?.custom_layer) {
          return customSet.has(String(g.properties.custom_layer).toLowerCase());
        }
        if (!hasAdminFilter) return true;
        const lvl = Number(g?.properties?.admin_level);
        return Number.isFinite(lvl) && lvl <= maxAdminLevel;
      }),
    };
  }

  const result: Record<string, unknown> = { ...topo, objects: filteredObjects };
  if (Array.isArray((topo as any).custom_layers)) {
    if (customSet.size === 0) {
      delete (result as any).custom_layers;
    } else {
      (result as any).custom_layers = ((topo as any).custom_layers as any[]).filter((l: any) =>
        customSet.has(String(l?.id ?? '').toLowerCase()),
      );
    }
  }

  return result;
}

function parseListParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export const adminBoundaries = async (
  req: Request,
  overrideCountryCode?: string,
  rawTopojson?: boolean,
) => {
  try {
    let countryCode = overrideCountryCode;
    if (!countryCode) {
      if (req.method === 'GET') {
        const url = new URL(req.url);
        countryCode = url.searchParams.get('country_code') ?? undefined;
      } else {
        const params = await validateBody(req, BOUNDARY_REQUEST_SCHEMA);
        countryCode = params.country_code;
      }
    }

    if (!countryCode) {
      return ErrorResponse({ error: 'Missing country_code parameter' }, 400);
    }

    const validated = BOUNDARY_REQUEST_SCHEMA.safeParse({ country_code: countryCode });
    if (!validated.success) {
      return ErrorResponse(
        { error: validated.error.errors[0]?.message || 'Invalid country_code' },
        400,
      );
    }
    const validatedCode = validated.data.country_code;

    const { topojsonString, source } = await getBoundariesTopojson(validatedCode, req.signal);

    const url = new URL(req.url);
    const includeCentersParam =
      url.searchParams.get('include_centers') ?? url.searchParams.get('centers');

    // Narrow the export to the rendered layers: ?admin_level=4&custom_layer=mw_epa
    // (comma-separated lists supported). Custom layers are opt-in — raw
    // downloads exclude them unless explicitly requested, so plain
    // `/boundaries/MW.topo.json` never ships EPAs by accident.
    const adminLevelFilter = parseListParam(url.searchParams.get('admin_level'))
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const customLayerFilter = parseListParam(
      url.searchParams.get('custom_layer') ?? url.searchParams.get('custom_layers'),
    );

    let finalTopojsonString = topojsonString;
    // Raw downloads always narrow (default: all admin levels, no custom
    // layers). Envelope responses only narrow when filters are explicit, so
    // the web map keeps receiving the full dataset for client-side toggling.
    const needsFiltering =
      adminLevelFilter.length > 0 || customLayerFilter.length > 0 || rawTopojson;
    if (needsFiltering) {
      const filtered = filterTopojsonGeometries(JSON.parse(topojsonString), {
        adminLevels: adminLevelFilter,
        customLayers: customLayerFilter,
      });
      finalTopojsonString = stringifyTopojsonReadable(filtered);
    }
    // For raw TopoJSON downloads, default include_centers to false to match the web UI download default,
    // unless explicitly requested with include_centers=true / centers=true.
    // For JSON envelope responses (e.g. POST /), default include_centers to true so web UI and tests have centers.
    const shouldIncludeCenters = rawTopojson
      ? includeCentersParam === 'true'
      : includeCentersParam !== 'false';

    if (!shouldIncludeCenters) {
      const stripped = stripCentersFromTopojson(JSON.parse(finalTopojsonString));
      finalTopojsonString = stringifyTopojsonReadable(stripped);
    }

    if (rawTopojson) {
      const nameParts = [validatedCode];
      if (adminLevelFilter.length > 0) nameParts.push(`admin${adminLevelFilter.join('-')}`);
      if (customLayerFilter.length > 0) nameParts.push(customLayerFilter.join('-'));
      return new Response(finalTopojsonString, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${nameParts.join('_')}.topo.json"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return buildSuccessResponse({ country_code: validatedCode }, source, finalTopojsonString);
  } catch (error) {
    console.error(typeof error, error);
    // validateBody rejects with a ready-made Response — pass it through rather
    // than stringifying it into "[object Response]".
    if (error instanceof Response) return error;
    return toBoundaryErrorResponse(error, req.signal);
  }
};

function buildCachePaths(countryCode: string): CachePaths {
  const prefix = `derived/v${CACHE_VERSION}/country=${countryCode}`;
  return {
    prefix,
    geojson: `${prefix}/geojson.json`,
    topojson: `${prefix}/topojson.json`,
  };
}

async function readCache<T>(cache: CacheProvider, key: string): Promise<T | null> {
  try {
    return await cache.get<T>(key);
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheProvider, key: string, data: unknown): Promise<void> {
  try {
    await cache.set(key, data);
  } catch (err) {
    console.error(`Non-fatal error saving cache key "${key}":`, err);
  }
}

function buildMapshaperInputsAndCommands(geojson: any): {
  input: Record<string, unknown>;
  commands: string[];
} {
  // Pre-validate whether geometric centroids are strictly inside polygon boundaries
  if (geojson && Array.isArray(geojson.features)) {
    for (const feature of geojson.features) {
      if (feature?.properties) {
        if (!feature.properties.admin_centre && !feature.properties.label_point) {
          feature.properties._centroid_inside = isCentroidInsideGeometry(feature.geometry);
        }
      }
    }
  }

  const input: Record<string, unknown> = {
    'input.geojson': geojson,
  };

  const commands: string[] = [
    `-i input.geojson`,
    `-clean allow-overlaps`,
    `-simplify weighting=0.5 10%`,
    `-filter-islands min-area=10km2`,
    `-each '` +
      `var c = this.properties.admin_centre; ` +
      `var s = "admin_centre"; ` +
      `if (!c && this.properties.label_point) { c = this.properties.label_point; s = "label"; } ` +
      `if (!c) { ` +
      `  var hasCentroid = typeof this.centroidX === "number" && !isNaN(this.centroidX) && typeof this.centroidY === "number" && !isNaN(this.centroidY); ` +
      `  var hasInner = typeof this.innerX === "number" && !isNaN(this.innerX) && typeof this.innerY === "number" && !isNaN(this.innerY); ` +
      `  if (hasCentroid && this.properties._centroid_inside) { ` +
      `    c = [Math.round(this.centroidX * 1e5) / 1e5, Math.round(this.centroidY * 1e5) / 1e5]; ` +
      `    s = "centroid"; ` +
      `  } else if (hasInner) { ` +
      `    c = [Math.round(this.innerX * 1e5) / 1e5, Math.round(this.innerY * 1e5) / 1e5]; ` +
      `    s = "point_on_surface"; ` +
      `  } else if (hasCentroid) { ` +
      `    c = [Math.round(this.centroidX * 1e5) / 1e5, Math.round(this.centroidY * 1e5) / 1e5]; ` +
      `    s = "centroid"; ` +
      `  } ` +
      `} else { ` +
      `  c = [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]; ` +
      `} ` +
      `this.properties = { ` +
      `  id: this.properties.id || this.properties["@id"] || this.id, ` +
      `  name: this.properties.name || "", ` +
      `  admin_level: this.properties.admin_level, ` +
      `  custom_layer: this.properties.custom_layer, ` +
      `  district: this.properties.district, ` +
      `  center: c, ` +
      `  center_source: s ` +
      `}; '`,
    `-o format=topojson bbox output.topojson`,
  ];

  return { input, commands };
}

async function convertGeoJsonToTopojson(
  geojson: any,
  paths: CachePaths,
  countryCode: string,
): Promise<string> {
  const cache = getCache();

  // Optional/debug cache
  await writeCache(cache, paths.geojson, geojson);

  console.log('Optimizing with Mapshaper...');

  const { input, commands } = buildMapshaperInputsAndCommands(geojson);

  const rawTopojsonString = await new Promise<string>((resolve, reject) => {
    mapshaper.applyCommands(commands.join(' '), input, (err: Error | null, output: any) => {
      geojson = null as any;

      if (err) {
        reject(err);
        return;
      }

      try {
        resolve(output['output.topojson'].toString());
      } catch (parseError) {
        reject(parseError);
      }
    });
  });

  // Per-feature custom-layer metadata (layer_name, citation, unit_type) is
  // deliberately stripped above — TopoJSON has no property lookup, so the
  // layer info lives once at the topology level instead of ~300 duplicated
  // copies. topojson-client ignores foreign top-level members. It is placed
  // before `objects` so the metadata doesn't get buried under the geometry.
  const topo = JSON.parse(rawTopojsonString);
  const customLayers = getCustomLayerInfoForCountry(countryCode);
  if (customLayers.length > 0) {
    const { objects, ...head } = topo;
    return JSON.stringify({ ...head, custom_layers: customLayers, objects });
  }

  console.log('Mapshaper processing complete.');
  return JSON.stringify(topo);
}

function buildSuccessResponse(
  params: BoundaryRequestParams,
  source: Source,
  topojson: string,
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(JSON.parse(topojson));
  const customLayers = getCustomLayerInfoForCountry(params.country_code);

  return JSONResponse(
    {
      country_code: params.country_code,
      size_kb,
      feature_count,
      bbox,
      source,
      topojson,
      custom_layers: customLayers,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
