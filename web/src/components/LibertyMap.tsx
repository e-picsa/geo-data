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

interface LibertyMapProps {
  /** Country bbox [minLon, minLat, maxLon, maxLat] — map fits to it on change. */
  bbox: [number, number, number, number] | null;
  /** Boundary features for the selected admin level (rendered as an overlay). */
  geoJsonData: GeoJSON.FeatureCollection | null;
  onZoomChange: (zoom: number) => void;
}

/** Pure MapLibre GL map: live Liberty vector style + boundary overlay. */
export function LibertyMap({ bbox, geoJsonData, onZoomChange }: LibertyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
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
    // (The zoomend snap below stays as a safety net, e.g. for touch pinch.)
    map.scrollZoom.disable();
    let lastStep = 0;
    const WHEEL_COOLDOWN_MS = 250;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = Date.now();
      if (now - lastStep < WHEEL_COOLDOWN_MS) return;
      lastStep = now;
      if (e.deltaY > 0) map.zoomOut();
      else map.zoomIn();
    };
    const container = containerRef.current;
    container.addEventListener('wheel', onWheel, { passive: false });
    // Leaflet parity: keep the map on discrete zoom levels. easeTo re-fires
    // zoomend, but the snapped value is integral so this terminates.
    const snapZoom = () => {
      const z = map.getZoom();
      const snapped = Math.round(z);
      if (Math.abs(snapped - z) > 1e-6) map.easeTo({ zoom: snapped, duration: 150 });
    };
    map.on('moveend', reportZoom);
    map.on('zoomend', snapZoom);
    map.on('load', reportZoom);

    return () => {
      container.removeEventListener('wheel', onWheel);
      map.off('moveend', reportZoom);
      map.off('zoomend', snapZoom);
      map.remove();
      mapRef.current = null;
    };
  }, []);

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

  return <div ref={containerRef} className="h-full w-full" />;
}
