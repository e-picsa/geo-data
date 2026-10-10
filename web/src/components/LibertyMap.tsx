import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
// Explicit worker URL: Vite prebundling breaks maplibre's relative worker
// resolution, which silently kills all vector rendering (raster/shading
// still shows, labels and roads never appear).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.config.WORKER_URL = maplibreWorkerUrl;

const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BOUNDARY_SOURCE_ID = 'admin-boundaries';
const BOUNDARY_FILL_LAYER_ID = 'admin-boundaries-fill';
const BOUNDARY_LINE_LAYER_ID = 'admin-boundaries-line';
const EXPORT_BBOX_SOURCE_ID = 'export-bbox';
const EXPORT_BBOX_LAYER_ID = 'export-bbox-line';
const RASTER_SOURCE_ID = 'liberty-raster-preview';
const RASTER_LAYER_ID = 'liberty-raster-preview-layer';

/** Base layer mode, lifted to App so the sidebar shows matching export options. */
export type BaseMode = 'vector' | 'raster';

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
  /** Boundary features for the selected admin level (rendered as an overlay). */
  geoJsonData: GeoJSON.FeatureCollection | null;
  /** Tile-snapped export bbox at max zoom — drawn as a subtle grey outline. */
  exportBbox?: [number, number, number, number] | null;
  onZoomChange: (zoom: number) => void;
  /** Base for preview tile URLs (`/tiles/liberty/{z}/{x}/{y}.webp`). */
  apiUrl: string;
  /** Controlled base-mode toggle (drives matching sidebar export options). */
  baseMode: BaseMode;
  onBaseModeChange: (mode: BaseMode) => void;
}

/**
 * MapLibre GL map with a vector/raster base toggle: live Liberty vector style
 * vs the server-rendered WebP preview tiles (exactly what `/export-tiles`
 * bakes). Boundary + export-bbox overlays stay on in both modes.
 */
export function LibertyMap({
  bbox,
  geoJsonData,
  exportBbox,
  onZoomChange,
  apiUrl,
  baseMode,
  onBaseModeChange,
}: LibertyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  /** Ids of the Liberty style's own layers (captured on load, before overlays). */
  const baseLayerIdsRef = useRef<string[]>([]);
  const apiUrlRef = useRef(apiUrl);
  useEffect(() => {
    apiUrlRef.current = apiUrl;
  }, [apiUrl]);
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  // Create once (StrictMode-safe via cleanup).
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

    const reportZoom = () => onZoomChangeRef.current(Math.round(map.getZoom()));
    // Leaflet parity: discrete wheel zoom. MapLibre scroll-zooms continuously
    // with no snap option, so drive integer steps ourselves: one level per
    // wheel tick, with a cooldown so trackpad event floods don't skip levels.
    // `around` keeps the point under the cursor stationary, like Leaflet's
    // scrollWheelZoom (MapLibre zoomIn()/zoomOut() would use the map center).
    // (The zoomend snap below stays as a safety net, e.g. for touch pinch.)
    map.scrollZoom.disable();
    let lastStep = 0;
    // In-flight step target: successive ticks during an animation step from
    // the target, not the mid-flight camera, so levels can't be skipped.
    let targetZoom: number | null = null;
    const WHEEL_COOLDOWN_MS = 250;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = Date.now();
      if (now - lastStep < WHEEL_COOLDOWN_MS) return;
      lastStep = now;
      const rect = container.getBoundingClientRect();
      // easeTo `around` takes geographic coordinates, not screen pixels.
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
    // Leaflet parity: keep the map on discrete zoom levels. easeTo re-fires
    // zoomend, but the snapped value is integral so this terminates.
    const snapZoom = () => {
      targetZoom = null;
      const z = map.getZoom();
      const snapped = Math.round(z);
      if (Math.abs(snapped - z) > 1e-6) map.easeTo({ zoom: snapped, duration: 150 });
    };
    map.on('moveend', reportZoom);
    map.on('zoomend', snapZoom);
    map.on('load', reportZoom);
    // Capture the Liberty style's own layer ids before any overlay is added
    // (effects below register their `load` handlers after this one).
    map.once('load', () => {
      baseLayerIdsRef.current = (map.getStyle()?.layers ?? []).map((l) => l.id);
    });

    return () => {
      container.removeEventListener('wheel', onWheel);
      map.off('moveend', reportZoom);
      map.off('zoomend', snapZoom);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Vector/raster base toggle: raster mode shows the server-rendered WebP
  // preview tiles (exactly what `/export-tiles` bakes) and hides the Liberty
  // style layers; overlays stay visible in both modes.
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
        // Slip beneath overlays if they already exist (later overlays append above anyway).
        const before = [BOUNDARY_FILL_LAYER_ID, EXPORT_BBOX_LAYER_ID].find((id) =>
          map.getLayer(id),
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
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [baseMode]);

  // Boundary overlay: create source/layers once data first arrives, then update.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!geoJsonData) {
      if (map.getSource(BOUNDARY_SOURCE_ID)) {
        if (map.getLayer(BOUNDARY_LINE_LAYER_ID)) map.removeLayer(BOUNDARY_LINE_LAYER_ID);
        if (map.getLayer(BOUNDARY_FILL_LAYER_ID)) map.removeLayer(BOUNDARY_FILL_LAYER_ID);
        map.removeSource(BOUNDARY_SOURCE_ID);
      }
      return;
    }
    const apply = () => {
      if (map.getSource(BOUNDARY_SOURCE_ID)) {
        (map.getSource(BOUNDARY_SOURCE_ID) as maplibregl.GeoJSONSource).setData(geoJsonData);
        return;
      }
      map.addSource(BOUNDARY_SOURCE_ID, { type: 'geojson', data: geoJsonData });
      map.addLayer({
        id: BOUNDARY_FILL_LAYER_ID,
        type: 'fill',
        source: BOUNDARY_SOURCE_ID,
        paint: { 'fill-color': '#818cf8', 'fill-opacity': 0.2 },
      });
      map.addLayer({
        id: BOUNDARY_LINE_LAYER_ID,
        type: 'line',
        source: BOUNDARY_SOURCE_ID,
        paint: { 'line-color': '#4f46e5', 'line-width': 2, 'line-opacity': 0.8 },
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [geoJsonData]);

  // Export bbox overlay: subtle grey outline of the buffered tile cover at
  // max zoom for the selected admin level (low zooms cover a larger area).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!exportBbox) {
      if (map.getSource(EXPORT_BBOX_SOURCE_ID)) {
        if (map.getLayer(EXPORT_BBOX_LAYER_ID)) map.removeLayer(EXPORT_BBOX_LAYER_ID);
        map.removeSource(EXPORT_BBOX_SOURCE_ID);
      }
      return;
    }
    const data = bboxToPolygon(exportBbox);
    const apply = () => {
      if (map.getSource(EXPORT_BBOX_SOURCE_ID)) {
        (map.getSource(EXPORT_BBOX_SOURCE_ID) as maplibregl.GeoJSONSource).setData(data);
        return;
      }
      map.addSource(EXPORT_BBOX_SOURCE_ID, { type: 'geojson', data });
      map.addLayer({
        id: EXPORT_BBOX_LAYER_ID,
        type: 'line',
        source: EXPORT_BBOX_SOURCE_ID,
        paint: {
          'line-color': '#9ca3af',
          'line-width': 1.5,
          'line-opacity': 0.9,
          'line-dasharray': [5, 3],
        },
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [exportBbox]);

  // Fit to country bounds when the country changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bbox) return;
    const fit = () => {
      try {
        map.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: 40, animate: false },
        );
      } catch (err) {
        console.error('[LibertyMap] fitBounds failed:', err);
      }
    };
    if (map.isStyleLoaded()) fit();
    else map.once('load', fit);
  }, [bbox]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 z-[500] flex rounded-full shadow-md border border-slate-200 bg-white/95 backdrop-blur overflow-hidden text-xs font-semibold"
        role="group"
        aria-label="Base layer"
      >
        {(['vector', 'raster'] as BaseMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onBaseModeChange(m)}
            aria-pressed={baseMode === m}
            title={
              m === 'vector'
                ? 'Live Liberty vector style (crisp at any zoom)'
                : 'Server-rendered WebP tiles — exactly what the offline pack contains (renders on demand, zooms 0–12)'
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
