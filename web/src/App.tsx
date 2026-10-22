import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as topojsonClient from 'topojson-client';
import { CountrySelect } from './components/CountrySelect';
import { AdminLevelSelect } from './components/AdminLevelSelect';
import { CustomLayerSelect } from './components/CustomLayerSelect';
import { LayerControls, type LayerAttributionInfo } from './components/LayerControls';
import { ExportTilesButton } from './components/ExportTilesButton';
import { ExportPmtilesButton } from './components/ExportPmtilesButton';
import { LibertyMap, type BaseMode } from './components/LibertyMap';
import { ZoomBadge } from './components/ZoomBadge';
import { TrashIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';
import { getCountryOsmLevels, type CustomLayerInfo } from './data/osm-admin-levels';
import { bboxForFeatures, getBufferedBboxForZoom } from './utils/tiles';
import {
  DEFAULT_ADMIN_LAYER_COLOR,
  DEFAULT_ADMIN_FILL_OPACITY,
  DEFAULT_CUSTOM_LAYER_COLOR,
  DEFAULT_CUSTOM_FILL_OPACITY,
  getLayerPreferences,
  saveLayerPreferences,
  type LayerPreferences,
} from './utils/layerPreferences';

interface BoundaryResponse {
  country_code: string;
  source: string;
  size_kb: number;
  feature_count: number;
  bbox: number[];
  /** topojson stringified already */
  topojson: string;
  custom_layers?: CustomLayerInfo[];
}

const OSM_ADMIN_ATTRIBUTION: LayerAttributionInfo = {
  sourceName: 'OpenStreetMap (OSM) via Geofabrik',
  sourceUrl:
    'https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries',
  license: 'Open Database License (ODbL)',
  details:
    'Administrative boundary relations extracted from OpenStreetMap Geofabrik country extracts and topologically processed using Mapshaper.',
};

/** Path prefix the app is served from (supports Vite base-path deploys). */
function appBasePath(): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** Country code from the URL path (`/MW`), or null on the root `/`. */
function getCountryCodeFromUrl(): string | null {
  let path = window.location.pathname;
  const base = appBasePath();
  if (base !== '/' && path.toLowerCase().startsWith(base.toLowerCase().replace(/\/$/, ''))) {
    path = path.slice(base.replace(/\/$/, '').length) || '/';
  }
  const seg = path.split('/').filter(Boolean)[0];
  if (seg && /^[A-Za-z]{2}$/.test(seg)) return seg.toUpperCase();
  return null;
}

function countryUrl(code: string): string {
  if (code.toUpperCase() === 'GLOBAL') return appBasePath();
  return `${appBasePath()}${code.toUpperCase()}`;
}

/** World cover for the global vector base layer (no buffer concept). */
const WORLD_BBOX: [number, number, number, number] = [-180, -85.0511, 180, 85.0511];

function App() {
  // Global is the default country (root `/` with no code in the URL).
  const [countryCode, setCountryCode] = useState<string>(() => getCountryCodeFromUrl() ?? 'GLOBAL');
  const [selectedAdminLevel, setSelectedAdminLevel] = useState<number>(2);
  const [selectedCustomLayer, setSelectedCustomLayer] = useState<string | null>(null);

  // Administrative layer preferences (visibility, color, fillOpacity, labels)
  const [adminLayerPrefs, setAdminLayerPrefs] = useState<LayerPreferences>(() =>
    getLayerPreferences('admin', DEFAULT_ADMIN_LAYER_COLOR, DEFAULT_ADMIN_FILL_OPACITY, true),
  );

  // Custom layer preferences (visibility, color, fillOpacity, labels)
  const [customLayerPrefs, setCustomLayerPrefs] = useState<LayerPreferences>(() =>
    getLayerPreferences(
      selectedCustomLayer || 'default',
      DEFAULT_CUSTOM_LAYER_COLOR,
      DEFAULT_CUSTOM_FILL_OPACITY,
      true,
    ),
  );

  const [tileMaxZoom, setTileMaxZoom] = useState(8);
  const [tileBuffer, setTileBuffer] = useState(1);
  const [mapZoom, setMapZoom] = useState(2);
  // Base-layer preview mode — the sidebar shows matching export options only
  // (vector pack in vector mode, raster pack in raster mode).
  const [baseMode, setBaseMode] = useState<BaseMode>('vector');
  const [includeCenters, setIncludeCenters] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BoundaryResponse | null>(null);
  const [downloadingTopo, setDownloadingTopo] = useState<boolean>(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const API_URL = import.meta.env.VITE_API_URL || '/api';

  // Country code mirror for popstate comparison (avoids stale closures).
  const countryCodeRef = useRef(countryCode);
  useEffect(() => {
    countryCodeRef.current = countryCode;
  }, [countryCode]);

  // Load preferences from localStorage when active custom layer changes
  useEffect(() => {
    if (selectedCustomLayer) {
      setCustomLayerPrefs(
        getLayerPreferences(
          selectedCustomLayer,
          DEFAULT_CUSTOM_LAYER_COLOR,
          DEFAULT_CUSTOM_FILL_OPACITY,
          true,
        ),
      );
    }
  }, [selectedCustomLayer]);

  // Admin layer preference handlers
  const handleAdminColorChange = (newColor: string) => {
    const updated: LayerPreferences = { ...adminLayerPrefs, color: newColor };
    setAdminLayerPrefs(updated);
    saveLayerPreferences('admin', updated);
  };

  const handleResetAdminColor = () => {
    const updated: LayerPreferences = {
      ...adminLayerPrefs,
      color: DEFAULT_ADMIN_LAYER_COLOR,
      fillOpacity: DEFAULT_ADMIN_FILL_OPACITY,
    };
    setAdminLayerPrefs(updated);
    saveLayerPreferences('admin', updated);
  };

  const handleAdminOpacityChange = (fillOpacity: number) => {
    const updated: LayerPreferences = { ...adminLayerPrefs, fillOpacity };
    setAdminLayerPrefs(updated);
    saveLayerPreferences('admin', updated);
  };

  const handleToggleAdminVisible = (visible: boolean) => {
    const updated: LayerPreferences = { ...adminLayerPrefs, visible };
    setAdminLayerPrefs(updated);
    saveLayerPreferences('admin', updated);
  };

  const handleToggleAdminLabels = (show: boolean) => {
    const updated: LayerPreferences = { ...adminLayerPrefs, showLabels: show };
    setAdminLayerPrefs(updated);
    saveLayerPreferences('admin', updated);
  };

  // Custom layer preference handlers
  const handleCustomColorChange = (newColor: string) => {
    if (!selectedCustomLayer) return;
    const updated: LayerPreferences = { ...customLayerPrefs, color: newColor };
    setCustomLayerPrefs(updated);
    saveLayerPreferences(selectedCustomLayer, updated);
  };

  const handleResetCustomColor = () => {
    if (!selectedCustomLayer) return;
    const updated: LayerPreferences = {
      ...customLayerPrefs,
      color: DEFAULT_CUSTOM_LAYER_COLOR,
      fillOpacity: DEFAULT_CUSTOM_FILL_OPACITY,
    };
    setCustomLayerPrefs(updated);
    saveLayerPreferences(selectedCustomLayer, updated);
  };

  const handleCustomOpacityChange = (fillOpacity: number) => {
    if (!selectedCustomLayer) return;
    const updated: LayerPreferences = { ...customLayerPrefs, fillOpacity };
    setCustomLayerPrefs(updated);
    saveLayerPreferences(selectedCustomLayer, updated);
  };

  const handleToggleCustomVisible = (visible: boolean) => {
    if (!selectedCustomLayer) return;
    const updated: LayerPreferences = { ...customLayerPrefs, visible };
    setCustomLayerPrefs(updated);
    saveLayerPreferences(selectedCustomLayer, updated);
  };

  const handleToggleCustomLabels = (show: boolean) => {
    if (!selectedCustomLayer) return;
    const updated: LayerPreferences = { ...customLayerPrefs, showLabels: show };
    setCustomLayerPrefs(updated);
    saveLayerPreferences(selectedCustomLayer, updated);
  };

  // Request the server render raster preview tiles into the cache for
  // zooms up to the preview cap (z8 by default, same as maxZoom initially).
  const prewarmTiles = useCallback(
    (country_code: string, bbox: number[] | undefined, buffer: number) => {
      if (!bbox || bbox.length < 4) return;
      const baseUrl = API_URL.replace(/\/$/, '');
      fetch(`${baseUrl}/prewarm-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_code, bbox, buffer }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const summary = await res.json().catch(() => null);
          console.log(`Tile prewarm for ${country_code}:`, summary);
        })
        .catch((err) => console.debug(`Tile prewarm skipped for ${country_code}:`, err));
    },
    [API_URL],
  );

  // Update GeoJSON whenever data changes
  const parsedTopojson = useMemo(() => {
    if (!data?.topojson) return null;
    try {
      return JSON.parse(data.topojson);
    } catch (e) {
      console.error('Failed to parse topojson', e);
      return null;
    }
  }, [data]);

  const fullGeoJson = useMemo(() => {
    if (!parsedTopojson?.objects) return null;
    const objectKey = Object.keys(parsedTopojson.objects)[0];
    if (!objectKey) return null;
    return topojsonClient.feature(parsedTopojson, parsedTopojson.objects[objectKey]) as any;
  }, [parsedTopojson]);

  const availableLevels = useMemo(() => {
    if (!fullGeoJson?.features) return [];
    const levels = new Set<number>();
    for (const f of fullGeoJson.features) {
      const lvl = Number(f.properties?.admin_level);
      if (!Number.isNaN(lvl)) {
        levels.add(lvl);
      }
    }
    return Array.from(levels).sort((a: number, b: number) => a - b);
  }, [fullGeoJson]);

  const availableCustomLayers = useMemo(() => {
    if (data?.custom_layers && data.custom_layers.length > 0) {
      return data.custom_layers;
    }
    return [];
  }, [data]);

  const availableCustomLayerIds = useMemo(() => {
    if (!fullGeoJson?.features) return [];
    const ids = new Set<string>();
    for (const f of fullGeoJson.features) {
      if (f.properties?.custom_layer) {
        ids.add(f.properties.custom_layer);
      }
    }
    return Array.from(ids);
  }, [fullGeoJson]);

  // Derive active admin level (strictly levels present in data/supported by country)
  const adminLevel = useMemo<number>(() => {
    const osmInfo = getCountryOsmLevels(countryCode ?? undefined);
    const isSupportedByCountry =
      !osmInfo?.levels || Boolean(osmInfo.levels[String(selectedAdminLevel)]);
    const isAvailableInData =
      !availableLevels.length || availableLevels.includes(selectedAdminLevel);

    if (isSupportedByCountry && isAvailableInData) {
      return selectedAdminLevel;
    }

    const candidates = [2, 3, 4, 5, 6].filter(
      (level) =>
        (!osmInfo?.levels || Boolean(osmInfo.levels[String(level)])) &&
        (!availableLevels.length || availableLevels.includes(level)),
    );

    if (candidates.length > 0) {
      return candidates[0];
    }

    return selectedAdminLevel;
  }, [countryCode, selectedAdminLevel, availableLevels]);

  const activeCustomLayer = useMemo(() => {
    if (!selectedCustomLayer) return null;
    return availableCustomLayers.find((l) => l.id === selectedCustomLayer) || null;
  }, [selectedCustomLayer, availableCustomLayers]);

  // Separate GeoJSON collections for Admin Boundaries and Custom Sectoral Layers
  const adminGeoJsonData = useMemo(() => {
    if (!fullGeoJson) return null;
    return {
      ...fullGeoJson,
      features: fullGeoJson.features.filter(
        (f: any) => Number(f.properties?.admin_level) === adminLevel,
      ),
    };
  }, [fullGeoJson, adminLevel]);

  const customGeoJsonData = useMemo(() => {
    if (!fullGeoJson || !selectedCustomLayer) return null;
    return {
      ...fullGeoJson,
      features: fullGeoJson.features.filter(
        (f: any) => f.properties?.custom_layer === selectedCustomLayer,
      ),
    };
  }, [fullGeoJson, selectedCustomLayer]);

  const centersStats = useMemo(() => {
    const fc = adminGeoJsonData;
    if (!fc?.features) return null;
    let adminCentre = 0;
    let fallback = 0;
    for (const f of fc.features) {
      const s = f.properties?.center_source;
      if (s === 'admin_centre') adminCentre++;
      else fallback++;
    }
    return { total: fc.features.length, adminCentre, fallback };
  }, [adminGeoJsonData]);

  // Country-wide bounding box for fitting the map view
  const countryBbox = useMemo<[number, number, number, number] | null>(() => {
    const isGlob = countryCode?.toUpperCase() === 'GLOBAL';
    if (isGlob) return WORLD_BBOX;
    if (data?.bbox && data.bbox.length >= 4) {
      return data.bbox.slice(0, 4) as [number, number, number, number];
    }
    const fromFull = bboxForFeatures(fullGeoJson);
    if (fromFull) return fromFull;
    const fromFiltered = bboxForFeatures(adminGeoJsonData);
    if (fromFiltered) return fromFiltered;
    return null;
  }, [countryCode, data?.bbox, fullGeoJson, adminGeoJsonData]);

  // Raw bounds for active layers (falls back to country bbox)
  const baseBbox = useMemo<[number, number, number, number] | null>(() => {
    if (countryCode?.toUpperCase() === 'GLOBAL') return WORLD_BBOX;
    const fromAdmin = bboxForFeatures(adminGeoJsonData);
    if (fromAdmin) return fromAdmin;
    const fromCustom = bboxForFeatures(customGeoJsonData);
    if (fromCustom) return fromCustom;
    if (data?.bbox && data.bbox.length >= 4) {
      return data.bbox.slice(0, 4) as [number, number, number, number];
    }
    return null;
  }, [adminGeoJsonData, customGeoJsonData, data, countryCode]);

  // Honest preview of discrete tile buffer
  const exportBbox = useMemo<[number, number, number, number] | null>(() => {
    if (!baseBbox) return null;
    return getBufferedBboxForZoom(baseBbox, tileBuffer, tileMaxZoom);
  }, [baseBbox, tileBuffer, tileMaxZoom]);

  const loadCountry = useCallback(
    async (code: string) => {
      const upper = code.toUpperCase();
      setCountryCode(upper);
      setLoading(true);
      setError(null);
      setData(null);

      // GLOBAL needs no boundary fetch — world cover only
      if (upper === 'GLOBAL') {
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ country_code: upper }),
          signal: AbortSignal.timeout(120000),
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          const retryHint =
            (errorData as any).retryable === true
              ? ' You can retry — boundary data is generated on first request and cached afterwards.'
              : '';
          throw new Error(
            `${(errorData as any).error || 'Failed to fetch boundaries'}${retryHint}`,
          );
        }

        const json: BoundaryResponse = await res.json();
        setData(json);

        // Prewarm raster tiles
        prewarmTiles(upper, json.bbox, tileBuffer);
      } catch (err: any) {
        if (err instanceof Error) {
          if (err.name === 'TimeoutError') {
            setError(
              'Request timed out while preparing boundary data. The dataset may still be generating — please retry in a few minutes.',
            );
          } else {
            setError(err.message);
          }
        } else {
          setError('An unexpected error occurred while fetching boundaries.');
        }
      } finally {
        setLoading(false);
      }
    },
    [API_URL, prewarmTiles, tileBuffer],
  );

  // Popstate sync
  useEffect(() => {
    const onPopState = () => {
      const fromUrl = getCountryCodeFromUrl() ?? 'GLOBAL';
      if (fromUrl !== countryCodeRef.current) {
        loadCountry(fromUrl);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [loadCountry]);

  // Initial load
  useEffect(() => {
    loadCountry(countryCode);
  }, []);

  const handleCountryChange = (code: string) => {
    const upper = code.toUpperCase();
    if (upper === countryCode) return;
    const url = countryUrl(upper);
    window.history.pushState({}, '', url);
    loadCountry(upper);
  };

  const downloadTopojson = async () => {
    if (!data?.country_code || downloadingTopo) return;
    setDownloadingTopo(true);
    setDownloadError(null);
    try {
      const baseUrl = API_URL.replace(/\/$/, '');
      const downloadUrl = `${baseUrl}/boundaries/${data.country_code}.topo.json?include_centers=${includeCenters}`;
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const retryHint =
          (errData as any).retryable === true
            ? ' You can retry — boundary data is generated on first request and cached afterwards.'
            : '';
        throw new Error(
          `${(errData as any).error || `Download failed with status ${res.status}`}${retryHint}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      let filename = `${data.country_code}.topo.json`;
      const contentDisposition = res.headers.get('Content-Disposition');
      if (contentDisposition) {
        const m = contentDisposition.match(/filename="?([^"]+)"?/);
        if (m && m[1]) filename = m[1];
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: any) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        setDownloadError(
          'Download timed out while boundary data was being prepared. Please retry in a few minutes.',
        );
      } else {
        setDownloadError(err instanceof Error ? err.message : 'Download failed.');
      }
    } finally {
      setDownloadingTopo(false);
    }
  };

  const isGlobal = countryCode.toUpperCase() === 'GLOBAL';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 font-sans text-slate-900">
      {/* Sidebar Controls */}
      <div className="w-80 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col h-full shadow-lg z-10">
        <div className="p-4 border-b border-slate-200 flex-shrink-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">E-PICSA Geo Data</h1>
          <p className="text-xs text-slate-500 mt-1">Country boundaries & offline tile packs</p>
        </div>

        {/* 50/50 Split Container: Both controls and results summary share 50% height and are independently scrollable */}
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Top 50%: Layer & Country Controls */}
          <div className="h-1/2 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Country
              </label>
              <CountrySelect value={countryCode} onChange={handleCountryChange} />
            </div>

            {!isGlobal && (
              <div className="space-y-4">
                {/* Administrative Layers Section */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      Administrative Level
                    </label>
                    <a
                      href="https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1"
                      title="View OSM admin levels definition for specific countries"
                    >
                      <span>OSM Guide</span>
                      <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
                  </div>
                  <AdminLevelSelect
                    value={adminLevel}
                    onChange={setSelectedAdminLevel}
                    countryCode={countryCode}
                    availableLevels={availableLevels}
                    disabled={loading}
                  />

                  {/* Administrative Layer Controls (Visibility, Colors, Opacity, Labels, Attribution Dropdown) */}
                  <LayerControls
                    visible={adminLayerPrefs.visible}
                    onToggleVisible={handleToggleAdminVisible}
                    color={adminLayerPrefs.color}
                    defaultColor={DEFAULT_ADMIN_LAYER_COLOR}
                    onColorChange={handleAdminColorChange}
                    onResetColor={handleResetAdminColor}
                    fillOpacity={adminLayerPrefs.fillOpacity}
                    onOpacityChange={handleAdminOpacityChange}
                    showLabels={adminLayerPrefs.showLabels}
                    onToggleLabels={handleToggleAdminLabels}
                    attribution={OSM_ADMIN_ATTRIBUTION}
                    disabled={loading || !adminGeoJsonData?.features?.length}
                  />
                </div>

                {/* Custom Sectoral Layers Section */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      Custom Layer
                    </label>
                    {availableCustomLayers.length > 0 && (
                      <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                        {availableCustomLayers.length} available
                      </span>
                    )}
                  </div>
                  <CustomLayerSelect
                    value={selectedCustomLayer}
                    onChange={setSelectedCustomLayer}
                    customLayers={availableCustomLayers}
                    availableCustomLayerIds={availableCustomLayerIds}
                    disabled={loading || availableCustomLayers.length === 0}
                  />

                  {/* Custom Layer Controls (Repeated component) */}
                  {activeCustomLayer && (
                    <LayerControls
                      visible={customLayerPrefs.visible}
                      onToggleVisible={handleToggleCustomVisible}
                      color={customLayerPrefs.color}
                      defaultColor={DEFAULT_CUSTOM_LAYER_COLOR}
                      onColorChange={handleCustomColorChange}
                      onResetColor={handleResetCustomColor}
                      fillOpacity={customLayerPrefs.fillOpacity}
                      onOpacityChange={handleCustomOpacityChange}
                      showLabels={customLayerPrefs.showLabels}
                      onToggleLabels={handleToggleCustomLabels}
                      attribution={activeCustomLayer.citation}
                      disabled={loading || !customGeoJsonData?.features?.length}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Bottom 50%: Results Summary & Exports */}
          <div className="h-1/2 min-h-0 overflow-y-auto border-t border-slate-200 flex flex-col bg-slate-50/30">
            {error && (
              <div className="m-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
                {error}
              </div>
            )}

            {data && (
              <div className="p-4 flex flex-col gap-3">
                <h3 className="font-semibold text-slate-900 text-sm">Results Summary</h3>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-slate-500">Source:</div>
                  <div className="font-medium text-right capitalize">{data.source}</div>

                  <div className="text-slate-500">Admin Features:</div>
                  <div className="font-medium text-right">
                    {adminGeoJsonData?.features?.length || 0}
                  </div>

                  {activeCustomLayer && (
                    <>
                      <div className="text-emerald-700 font-medium">Custom Features:</div>
                      <div className="font-semibold text-emerald-700 text-right">
                        {customGeoJsonData?.features?.length || 0}
                      </div>
                    </>
                  )}

                  <div className="text-slate-500">Size:</div>
                  <div className="font-medium text-right">{data.size_kb} KB</div>
                </div>

                <div className="pt-2 border-t border-slate-100 flex flex-col gap-1.5 text-xs text-slate-600">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeCenters}
                      onChange={(e) => setIncludeCenters(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs font-medium text-slate-700">Include Centers</span>
                  </label>

                  {includeCenters && centersStats && (
                    <div className="flex justify-between text-[11px] text-slate-500 pl-6">
                      <span
                        className="flex items-center gap-1.5"
                        title="OSM admin_centre relation member node"
                      >
                        <span className="w-2 h-2 rounded-full bg-blue-600 inline-block" />
                        admin_centre: {centersStats.adminCentre}
                      </span>
                      <span
                        className="flex items-center gap-1.5"
                        title="Geometric centroid fallback"
                      >
                        <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
                        fallback: {centersStats.fallback}
                      </span>
                    </div>
                  )}
                </div>

                <button
                  onClick={downloadTopojson}
                  disabled={downloadingTopo}
                  className="mt-2 w-full bg-white border border-slate-300 text-slate-700 font-medium py-2 px-4 rounded-md shadow-sm hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                >
                  {downloadingTopo ? (
                    <>
                      <div className="w-4 h-4 border-2 border-slate-600 border-t-transparent rounded-full animate-spin"></div>
                      Downloading...
                    </>
                  ) : (
                    'Download TopoJSON'
                  )}
                </button>
                {downloadError && <div className="text-red-600 text-xs mt-1">{downloadError}</div>}

                {baseMode === 'raster' ? (
                  <ExportTilesButton
                    countryCode={data.country_code}
                    bbox={(baseBbox ?? data.bbox) as [number, number, number, number]}
                    buffer={tileBuffer}
                    onBufferChange={setTileBuffer}
                    apiUrl={API_URL}
                    maxZoom={tileMaxZoom}
                    onMaxZoomChange={setTileMaxZoom}
                  />
                ) : (
                  <ExportPmtilesButton
                    countryCode={data.country_code}
                    bbox={(baseBbox ?? data.bbox) as [number, number, number, number]}
                    apiUrl={API_URL}
                  />
                )}
              </div>
            )}

            {isGlobal && !loading && (
              <div className="p-4 flex flex-col gap-3">
                <h3 className="font-semibold text-slate-900 text-sm">Global Base Layer</h3>
                {baseMode === 'vector' ? (
                  <>
                    <p className="text-xs text-slate-500">
                      Worldwide vector base (zooms 0–6, no tile buffer). Country packs start at z7
                      and layer over this base.
                    </p>

                    <ExportPmtilesButton countryCode="GLOBAL" bbox={WORLD_BBOX} apiUrl={API_URL} />
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    Raster packs are per-country — select a country to export WebP tiles (the map
                    preview above still shows the server-rendered raster for comparison).
                  </p>
                )}
              </div>
            )}

            {!data && !loading && !error && !isGlobal && (
              <div className="p-4 text-xs text-slate-400 italic">
                Select a country and layer to view results summary.
              </div>
            )}
          </div>
        </div>

        {/* Admin Tools - Dev Only */}
        {import.meta.env.DEV && (
          <div className="p-3 border-t border-slate-200 flex-shrink-0 bg-white">
            <button
              onClick={async () => {
                if (!confirm('Are you sure you want to clear the server cache?')) return;
                try {
                  const baseUrl = API_URL.replace(/\/$/, '');
                  const res = await fetch(`${baseUrl}/admin/clear-cache`, {
                    method: 'POST',
                  });
                  if (!res.ok) throw new Error('Failed to clear cache');
                  alert('Cache cleared successfully!');
                  loadCountry(countryCode);
                } catch (err: any) {
                  alert(`Error: ${err.message}`);
                }
              }}
              className="text-xs text-slate-400 hover:text-red-600 flex items-center gap-1 transition-colors"
            >
              <TrashIcon className="w-3.5 h-3.5" />
              <span>Clear Boundary Cache</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Map View */}
      <div className="flex-1 relative h-full">
        <LibertyMap
          bbox={countryBbox}
          adminGeoJsonData={adminLayerPrefs.visible ? adminGeoJsonData : null}
          adminLayerColor={adminLayerPrefs.color}
          adminFillOpacity={adminLayerPrefs.fillOpacity}
          showAdminLabels={adminLayerPrefs.visible && adminLayerPrefs.showLabels}
          customGeoJsonData={customLayerPrefs.visible ? customGeoJsonData : null}
          customLayerColor={customLayerPrefs.color}
          customFillOpacity={customLayerPrefs.fillOpacity}
          showCustomLabels={customLayerPrefs.visible && customLayerPrefs.showLabels}
          exportBbox={exportBbox}
          onZoomChange={setMapZoom}
          apiUrl={API_URL}
          baseMode={baseMode}
          onBaseModeChange={setBaseMode}
          showCenters={includeCenters}
        />

        <ZoomBadge zoom={mapZoom} />

        {loading && (
          <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="bg-white p-4 rounded-lg shadow-xl border border-slate-200 flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm font-medium text-slate-700">Loading boundaries...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
