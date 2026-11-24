import { useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
// Explicit worker URL: Vite prebundling breaks maplibre's relative worker
// resolution, which silently kills all vector rendering (raster/shading
// still shows, labels and roads never appear).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DEFAULT_ADMIN_LAYER_COLOR,
  DEFAULT_ADMIN_FILL_OPACITY,
  DEFAULT_ADMIN_LINE_OPACITY,
  DEFAULT_CUSTOM_LAYER_COLOR,
  DEFAULT_CUSTOM_FILL_OPACITY,
  DEFAULT_CUSTOM_LINE_OPACITY,
} from '../utils/layerPreferences';
import { offlineTileTemplate } from '../utils/tiles';

maplibregl.config.WORKER_URL = maplibreWorkerUrl;

const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Administrative boundary layers
const ADMIN_SOURCE_ID = 'admin-boundaries';
const ADMIN_FILL_LAYER_ID = 'admin-boundaries-fill';
const ADMIN_LINE_LAYER_ID = 'admin-boundaries-line';
const ADMIN_LABELS_SOURCE_ID = 'admin-labels-source';
const ADMIN_LABELS_LAYER_ID = 'admin-boundaries-labels';

// Custom sectoral layers
const CUSTOM_SOURCE_ID = 'custom-boundaries';
const CUSTOM_FILL_LAYER_ID = 'custom-boundaries-fill';
const CUSTOM_LINE_LAYER_ID = 'custom-boundaries-line';
const CUSTOM_LABELS_SOURCE_ID = 'custom-labels-source';
const CUSTOM_LABELS_LAYER_ID = 'custom-boundaries-labels';

// Center markers
const CENTERS_SOURCE_ID = 'admin-centers';
const CENTERS_CIRCLE_LAYER_ID = 'admin-centers-circle';

// Export bbox
const EXPORT_BBOX_SOURCE_ID = 'export-bbox';
const EXPORT_BBOX_LAYER_ID = 'export-bbox-line';

// Base raster
const RASTER_SOURCE_ID = 'liberty-raster-preview';
const RASTER_LAYER_ID = 'liberty-raster-preview-layer';

/** Base layer mode, lifted to App so the sidebar shows matching export options. */
export type BaseMode = 'vector' | 'raster' | 'offline';

/** Liberty style's vector source id (OpenMapTiles schema). */
const LIBERTY_VECTOR_SOURCE_ID = 'openmaptiles';
/** Upstream planet TileJSON (the Liberty style's openmaptiles source). Kept in
 * one place so offline mode can restore the exact live source afterwards. */
const LIBERTY_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

function whenStyleReady(map: maplibregl.Map, fn: () => void): () => void {
  if (map.isStyleLoaded()) {
    fn();
    return () => {};
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    map.off('style.load', run);
    map.off('idle', run);
    fn();
  };
  map.once('style.load', run);
  map.once('idle', run);
  return () => {
    done = true;
    map.off('style.load', run);
    map.off('idle', run);
  };
}

type OverlayLayerSpec = Omit<maplibregl.LayerSpecification, 'id' | 'source'>;

/**
 * Shared GeoJSON overlay management — every overlay (admin, custom, labels,
 * centers, export bbox) goes through these so layers behave identically.
 * Ensures the source exists with fresh data, (re-)creates any missing layer,
 * and forces a repaint so newly shown content never waits for the next
 * map interaction to appear.
 */
function upsertGeoJsonOverlay(
  map: maplibregl.Map,
  sourceId: string,
  data: GeoJSON.FeatureCollection,
  layers: Array<{ id: string; spec: OverlayLayerSpec }>,
): void {
  const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
  } else {
    map.addSource(sourceId, { type: 'geojson', data });
  }
  for (const { id, spec } of layers) {
    if (!map.getLayer(id)) {
      map.addLayer({ id, source: sourceId, ...spec } as maplibregl.LayerSpecification);
    }
  }
  // Newly added sources paint on the worker round-trip, but a forced repaint
  // covers every path (cached data, style already idle) — content must show
  // immediately, not on the next pan/zoom.
  map.triggerRepaint();
}

function removeGeoJsonOverlay(map: maplibregl.Map, sourceId: string, layerIds: string[]): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** Glyph stack guaranteed by the Liberty style (its only text-font stacks). */
const LABEL_FONT: [string] = ['Noto Sans Regular'];

function bboxToPolygon(bbox: [number, number, number, number]): GeoJSON.FeatureCollection {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [minLon, minLat],
              [maxLon, minLat],
              [maxLon, maxLat],
              [minLon, maxLat],
              [minLon, minLat],
            ],
          ],
        },
      },
    ],
  };
}

interface LibertyMapProps {
  /** Country bbox [minLon, minLat, maxLon, maxLat] — map fits to it on change. */
  bbox: [number, number, number, number] | null;
  /** Administrative boundary features for the selected admin level. */
  adminGeoJsonData?: GeoJSON.FeatureCollection | null;
  /** Active admin layer stroke/fill color. */
  adminLayerColor?: string;
  /** Active admin layer fill opacity (0.0 to 1.0). Border outline stays opaque. */
  adminFillOpacity?: number;
  /** Active admin layer outline/line opacity (0.0 to 1.0). */
  adminLineOpacity?: number;
  /** Toggle rendering of labels for the administrative layer. */
  showAdminLabels?: boolean;
  /** Custom layer features (e.g. EPAs, rendered in customLayerColor). */
  customGeoJsonData?: GeoJSON.FeatureCollection | null;
  /** Active custom layer stroke/fill color. */
  customLayerColor?: string;
  /** Active custom layer fill opacity (0.0 to 1.0). Border outline stays opaque. */
  customFillOpacity?: number;
  /** Active custom layer outline/line opacity (0.0 to 1.0). */
  customLineOpacity?: number;
  /** Toggle rendering of labels for the custom layer. */
  showCustomLabels?: boolean;
  /** Display name for the active custom layer (per-feature layer_name was deduped). */
  customLayerName?: string | null;
  /** Citation for the active custom layer (per-feature citation was deduped). */
  customLayerCitation?: string | null;
  /** Legacy single geoJsonData prop for backwards-compatibility. */
  geoJsonData?: GeoJSON.FeatureCollection | null;
  /** Tile-snapped export bbox at max zoom — drawn as a subtle grey outline. */
  exportBbox?: [number, number, number, number] | null;
  onZoomChange: (zoom: number) => void;
  /** Base for preview tile URLs (`/tiles/liberty/{z}/{x}/{y}.webp`). */
  apiUrl: string;
  /** Controlled base-mode toggle (drives matching sidebar export options). */
  baseMode: BaseMode;
  onBaseModeChange: (mode: BaseMode) => void;
  /** Toggle rendering of district/admin center markers */
  showCenters?: boolean;
  /** ISO country code for the offline tile source (`?country=` selector). */
  countryCode?: string | null;
}

/**
 * MapLibre GL map with support for concurrent Administrative Boundaries
 * and Custom Sectoral Layers with independent colors, fill opacities, visibility, labels, and center points.
 */
export function LibertyMap({
  bbox,
  adminGeoJsonData,
  adminLayerColor = DEFAULT_ADMIN_LAYER_COLOR,
  adminFillOpacity = DEFAULT_ADMIN_FILL_OPACITY,
  adminLineOpacity = DEFAULT_ADMIN_LINE_OPACITY,
  showAdminLabels = true,
  customGeoJsonData,
  customLayerColor = DEFAULT_CUSTOM_LAYER_COLOR,
  customFillOpacity = DEFAULT_CUSTOM_FILL_OPACITY,
  customLineOpacity = DEFAULT_CUSTOM_LINE_OPACITY,
  showCustomLabels = true,
  customLayerName = null,
  customLayerCitation = null,
  geoJsonData,
  exportBbox,
  onZoomChange,
  apiUrl,
  baseMode,
  onBaseModeChange,
  showCenters = false,
  countryCode = null,
}: LibertyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const baseLayerIdsRef = useRef<string[]>([]);
  const apiUrlRef = useRef(apiUrl);
  useEffect(() => {
    apiUrlRef.current = apiUrl;
  }, [apiUrl]);
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);
  // Backward compatibility: if adminGeoJsonData is omitted, use geoJsonData
  const effectiveAdminData = adminGeoJsonData !== undefined ? adminGeoJsonData : geoJsonData;

  // Aggregate centers from active admin and custom layers
  const centersData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!showCenters) return null;
    const features: GeoJSON.Feature[] = [];

    const addFeatures = (fc?: GeoJSON.FeatureCollection | null, isCustom = false) => {
      if (!fc?.features) return;
      for (const f of fc.features) {
        const props = (f.properties || {}) as any;
        if (props.center && Array.isArray(props.center) && props.center.length === 2) {
          features.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: props.center,
            },
            properties: {
              id: props.id,
              name: props.name || '',
              admin_level: props.admin_level,
              custom_layer: isCustom ? props.custom_layer || 'custom' : undefined,
              layer_name:
                props.layer_name || (isCustom ? (customLayerName ?? undefined) : undefined),
              district: props.district,
              citation:
                props.citation || (isCustom ? (customLayerCitation ?? undefined) : undefined),
              center_source: props.center_source || 'centroid',
            },
          });
        }
      }
    };

    addFeatures(effectiveAdminData, false);
    addFeatures(customGeoJsonData, true);

    if (features.length === 0) return null;
    return {
      type: 'FeatureCollection',
      features,
    };
  }, [effectiveAdminData, customGeoJsonData, showCenters, customLayerName, customLayerCitation]);

  // Points specifically for administrative layer text labels
  const adminLabelsData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!effectiveAdminData?.features || !showAdminLabels) return null;
    const features: GeoJSON.Feature[] = [];
    for (const f of effectiveAdminData.features) {
      const props = (f.properties || {}) as any;
      if (props.center && Array.isArray(props.center) && props.center.length === 2) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: props.center,
          },
          properties: {
            name: props.name || '',
          },
        });
      }
    }
    return {
      type: 'FeatureCollection',
      features,
    };
  }, [effectiveAdminData, showAdminLabels]);

  // Points specifically for custom layer text labels
  const customLabelsData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!customGeoJsonData?.features || !showCustomLabels) return null;
    const features: GeoJSON.Feature[] = [];
    for (const f of customGeoJsonData.features) {
      const props = (f.properties || {}) as any;
      if (props.center && Array.isArray(props.center) && props.center.length === 2) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: props.center,
          },
          properties: {
            name: props.name || '',
            district: props.district || '',
          },
        });
      }
    }
    return {
      type: 'FeatureCollection',
      features,
    };
  }, [customGeoJsonData, showCustomLabels]);

  // Create map once (StrictMode-safe)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: LIBERTY_STYLE_URL,
      center: [0, 0],
      zoom: 2,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    mapRef.current = map;
    if (import.meta.env.DEV) {
      // QA escape hatch: lets headless checks (and devtools) inspect the live
      // style, sources and tile caches. Never used by the app itself.
      (window as unknown as { __geoMap?: maplibregl.Map }).__geoMap = map;
    }

    const reportZoom = () => onZoomChangeRef.current(Math.round(map.getZoom()));
    map.scrollZoom.disable();
    let lastStep = 0;
    let targetZoom: number | null = null;
    const WHEEL_COOLDOWN_MS = 250;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = Date.now();
      if (now - lastStep < WHEEL_COOLDOWN_MS) return;
      lastStep = now;
      const rect = container.getBoundingClientRect();
      const around = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      const base = targetZoom ?? Math.round(map.getZoom());
      targetZoom = Math.min(
        map.getMaxZoom(),
        Math.max(map.getMinZoom(), base + (e.deltaY > 0 ? -1 : 1)),
      );
      map.easeTo({ zoom: targetZoom, around, duration: 250 });
    };
    const container = containerRef.current;
    container.addEventListener('wheel', onWheel, { passive: false });
    const snapZoom = () => {
      targetZoom = null;
      const z = map.getZoom();
      const snapped = Math.round(z);
      if (Math.abs(snapped - z) > 1e-6) map.easeTo({ zoom: snapped, duration: 150 });
    };
    map.on('moveend', reportZoom);
    map.on('zoomend', snapZoom);
    map.on('load', reportZoom);

    const cancelCapture = whenStyleReady(map, () => {
      baseLayerIdsRef.current = (map.getStyle()?.layers ?? []).map((l: any) => l.id);
    });

    return () => {
      cancelCapture();
      container.removeEventListener('wheel', onWheel);
      map.off('moveend', reportZoom);
      map.off('zoomend', snapZoom);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Offline mode: point the Liberty vector source at the local pack server.
  // setTiles/setUrl are the source's own reload path, so tiles refetch with
  // no layer juggling and no style reload; toggling back restores the exact
  // TileJSON source. Same style, glyphs and sprites throughout.
  const offlineActiveRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(LIBERTY_VECTOR_SOURCE_ID) as
        | maplibregl.VectorTileSource
        | undefined;
      if (!src || typeof src.setTiles !== 'function' || typeof src.setUrl !== 'function') return;
      if (baseMode === 'offline') {
        src.setTiles([offlineTileTemplate(apiUrlRef.current, countryCode ?? 'GLOBAL')]);
        offlineActiveRef.current = true;
      } else if (offlineActiveRef.current) {
        src.setUrl(LIBERTY_TILEJSON_URL);
        offlineActiveRef.current = false;
      }
    };
    return whenStyleReady(map, apply);
  }, [baseMode, countryCode]);

  // Vector / raster base toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getSource(RASTER_SOURCE_ID)) {
        const base = apiUrlRef.current.replace(/\/$/, '');
        map.addSource(RASTER_SOURCE_ID, {
          type: 'raster',
          tiles: [`${base}/tiles/liberty/{z}/{x}/{y}.webp`],
          tileSize: 256,
          maxzoom: 12,
        });
        const before = [ADMIN_FILL_LAYER_ID, CUSTOM_FILL_LAYER_ID, EXPORT_BBOX_LAYER_ID].find(
          (id) => map.getLayer(id),
        );
        map.addLayer({ id: RASTER_LAYER_ID, type: 'raster', source: RASTER_SOURCE_ID }, before);
      }
      const showRaster = baseMode === 'raster';
      map.setLayoutProperty(RASTER_LAYER_ID, 'visibility', showRaster ? 'visible' : 'none');
      for (const id of baseLayerIdsRef.current) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', showRaster ? 'none' : 'visible');
        }
      }
    };
    return whenStyleReady(map, apply);
  }, [baseMode]);

  // Administrative Boundary overlay (fill transparency configurable, border outline opaque)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!effectiveAdminData) {
      removeGeoJsonOverlay(map, ADMIN_SOURCE_ID, [ADMIN_LINE_LAYER_ID, ADMIN_FILL_LAYER_ID]);
      return;
    }
    const apply = () => {
      upsertGeoJsonOverlay(map, ADMIN_SOURCE_ID, effectiveAdminData, [
        {
          id: ADMIN_FILL_LAYER_ID,
          spec: {
            type: 'fill',
            paint: { 'fill-color': adminLayerColor, 'fill-opacity': adminFillOpacity },
          },
        },
        {
          id: ADMIN_LINE_LAYER_ID,
          spec: {
            type: 'line',
            paint: {
              'line-color': adminLayerColor,
              'line-width': 2,
              'line-opacity': adminLineOpacity,
            },
          },
        },
      ]);
      if (map.getLayer(ADMIN_FILL_LAYER_ID)) {
        map.setPaintProperty(ADMIN_FILL_LAYER_ID, 'fill-color', adminLayerColor);
        map.setPaintProperty(ADMIN_FILL_LAYER_ID, 'fill-opacity', adminFillOpacity);
      }
      if (map.getLayer(ADMIN_LINE_LAYER_ID)) {
        map.setPaintProperty(ADMIN_LINE_LAYER_ID, 'line-color', adminLayerColor);
        map.setPaintProperty(ADMIN_LINE_LAYER_ID, 'line-opacity', adminLineOpacity);
      }
    };
    return whenStyleReady(map, apply);
  }, [effectiveAdminData, adminLayerColor, adminFillOpacity, adminLineOpacity]);

  // Administrative Boundary Text Labels
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!adminLabelsData || adminLabelsData.features.length === 0) {
      removeGeoJsonOverlay(map, ADMIN_LABELS_SOURCE_ID, [ADMIN_LABELS_LAYER_ID]);
      return;
    }

    const apply = () => {
      upsertGeoJsonOverlay(map, ADMIN_LABELS_SOURCE_ID, adminLabelsData, [
        {
          id: ADMIN_LABELS_LAYER_ID,
          spec: {
            type: 'symbol',
            layout: {
              'text-field': ['get', 'name'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 12, 12, 14],
              'text-font': LABEL_FONT,
              'text-anchor': 'center',
              'text-optional': true,
            } as any,
            paint: {
              'text-color': adminLayerColor,
              'text-halo-color': '#ffffff',
              'text-halo-width': 2,
            },
          },
        },
      ]);
      if (map.getLayer(ADMIN_LABELS_LAYER_ID)) {
        map.setPaintProperty(ADMIN_LABELS_LAYER_ID, 'text-color', adminLayerColor);
      }
    };
    return whenStyleReady(map, apply);
  }, [adminLabelsData, adminLayerColor]);

  // Custom Layer overlay (fill transparency configurable, border outline opaque)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!customGeoJsonData) {
      removeGeoJsonOverlay(map, CUSTOM_SOURCE_ID, [CUSTOM_LINE_LAYER_ID, CUSTOM_FILL_LAYER_ID]);
      return;
    }
    const apply = () => {
      upsertGeoJsonOverlay(map, CUSTOM_SOURCE_ID, customGeoJsonData, [
        {
          id: CUSTOM_FILL_LAYER_ID,
          spec: {
            type: 'fill',
            paint: { 'fill-color': customLayerColor, 'fill-opacity': customFillOpacity },
          },
        },
        {
          id: CUSTOM_LINE_LAYER_ID,
          spec: {
            type: 'line',
            paint: {
              'line-color': customLayerColor,
              'line-width': 2,
              'line-opacity': customLineOpacity,
            },
          },
        },
      ]);
      if (map.getLayer(CUSTOM_FILL_LAYER_ID)) {
        map.setPaintProperty(CUSTOM_FILL_LAYER_ID, 'fill-color', customLayerColor);
        map.setPaintProperty(CUSTOM_FILL_LAYER_ID, 'fill-opacity', customFillOpacity);
      }
      if (map.getLayer(CUSTOM_LINE_LAYER_ID)) {
        map.setPaintProperty(CUSTOM_LINE_LAYER_ID, 'line-color', customLayerColor);
        map.setPaintProperty(CUSTOM_LINE_LAYER_ID, 'line-opacity', customLineOpacity);
      }
    };
    return whenStyleReady(map, apply);
  }, [customGeoJsonData, customLayerColor, customFillOpacity, customLineOpacity]);

  // Custom Layer Text Labels
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!customLabelsData || customLabelsData.features.length === 0) {
      removeGeoJsonOverlay(map, CUSTOM_LABELS_SOURCE_ID, [CUSTOM_LABELS_LAYER_ID]);
      return;
    }

    const apply = () => {
      upsertGeoJsonOverlay(map, CUSTOM_LABELS_SOURCE_ID, customLabelsData, [
        {
          id: CUSTOM_LABELS_LAYER_ID,
          spec: {
            type: 'symbol',
            layout: {
              'text-field': ['get', 'name'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 12, 12, 14],
              'text-font': LABEL_FONT,
              'text-anchor': 'center',
              'text-optional': true,
            } as any,
            paint: {
              'text-color': customLayerColor,
              'text-halo-color': '#ffffff',
              'text-halo-width': 2,
            },
          },
        },
      ]);
      if (map.getLayer(CUSTOM_LABELS_LAYER_ID)) {
        map.setPaintProperty(CUSTOM_LABELS_LAYER_ID, 'text-color', customLayerColor);
      }
    };
    return whenStyleReady(map, apply);
  }, [customLabelsData, customLayerColor]);

  // District / admin / custom centers overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!centersData || centersData.features.length === 0) {
      removeGeoJsonOverlay(map, CENTERS_SOURCE_ID, [CENTERS_CIRCLE_LAYER_ID]);
      return;
    }

    const apply = () => {
      const isNew = !map.getLayer(CENTERS_CIRCLE_LAYER_ID);
      upsertGeoJsonOverlay(map, CENTERS_SOURCE_ID, centersData, [
        {
          id: CENTERS_CIRCLE_LAYER_ID,
          spec: {
            type: 'circle',
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 7],
              'circle-color': [
                'case',
                ['has', 'custom_layer'],
                customLayerColor,
                [
                  'match',
                  ['get', 'center_source'],
                  'admin_centre',
                  adminLayerColor,
                  'label',
                  '#0d9488', // Teal
                  'centroid',
                  '#64748b', // Slate
                  'point_on_surface',
                  '#64748b', // Slate
                  '#64748b', // Slate
                ],
              ] as any,
              'circle-opacity': 0.8,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5,
              'circle-stroke-opacity': 0.9,
            },
          },
        },
      ]);

      if (!isNew) return;

      map.on('click', CENTERS_CIRCLE_LAYER_ID, (e: any) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const coords = (feature.geometry as any).coordinates.slice();
        const { name, admin_level, custom_layer, layer_name, district, citation, center_source } =
          feature.properties as any;

        let content =
          `<div style="font-family: sans-serif; font-size: 13px; line-height: 1.4; color: #1e293b;">` +
          `<strong style="font-size: 14px; display: block; margin-bottom: 4px;">${name || 'Unnamed Unit'}</strong>`;

        if (custom_layer) {
          content += `<div><strong>Layer:</strong> ${layer_name || custom_layer}</div>`;
          if (district) {
            content += `<div><strong>District:</strong> ${district}</div>`;
          }
          if (citation) {
            content += `<div><strong>Source:</strong> <span style="font-size: 11px; color: #475569;">${citation}</span></div>`;
          }
        } else {
          content += `<div><strong>Admin Level:</strong> ${admin_level}</div>`;
        }

        content +=
          `<div><strong>Center Calculation:</strong> <span style="font-family: monospace; font-size: 11px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px;">${center_source}</span></div>` +
          `<div><strong>Coords:</strong> ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}</div>` +
          `</div>`;

        new maplibregl.Popup({ offset: 10 }).setLngLat(coords).setHTML(content).addTo(map);
      });

      map.on('mouseenter', CENTERS_CIRCLE_LAYER_ID, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', CENTERS_CIRCLE_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
      });
    };

    return whenStyleReady(map, apply);
  }, [centersData, adminLayerColor, customLayerColor]);

  // Export bbox overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!exportBbox) {
      removeGeoJsonOverlay(map, EXPORT_BBOX_SOURCE_ID, [EXPORT_BBOX_LAYER_ID]);
      return;
    }
    const data = bboxToPolygon(exportBbox);
    const apply = () => {
      upsertGeoJsonOverlay(map, EXPORT_BBOX_SOURCE_ID, data, [
        {
          id: EXPORT_BBOX_LAYER_ID,
          spec: {
            type: 'line',
            paint: {
              'line-color': '#9ca3af',
              'line-width': 1.5,
              'line-opacity': 0.9,
              'line-dasharray': [5, 3],
            },
          },
        },
      ]);
    };
    return whenStyleReady(map, apply);
  }, [exportBbox]);

  // Fit to country bounds when the country changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bbox || bbox.length < 4) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (
      !Number.isFinite(minLon) ||
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLon) ||
      !Number.isFinite(maxLat)
    ) {
      return;
    }
    const fit = () => {
      try {
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 40, maxZoom: 12, duration: 800 },
        );
      } catch (err) {
        console.error('[LibertyMap] fitBounds failed:', err);
      }
    };
    return whenStyleReady(map, fit);
  }, [bbox]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 z-[500] flex rounded-full shadow-md border border-slate-200 bg-white/95 backdrop-blur overflow-hidden text-xs font-semibold"
        role="group"
        aria-label="Base layer"
      >
        {(['vector', 'raster', 'offline'] as BaseMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onBaseModeChange(m)}
            aria-pressed={baseMode === m}
            title={
              m === 'vector'
                ? 'Live Liberty vector style (crisp at any zoom)'
                : m === 'raster'
                  ? 'Server-rendered WebP tiles — exactly what the offline pack contains (renders on demand, zooms 0–12)'
                  : 'Same Liberty style, vector tiles served from local packs (global base + country pack)'
            }
            className={`px-3 py-1.5 capitalize transition-colors ${
              baseMode === m ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
