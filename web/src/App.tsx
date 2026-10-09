import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as topojsonClient from 'topojson-client';
import { CountrySelect } from './components/CountrySelect';
import { AdminLevelSelect } from './components/AdminLevelSelect';
import { ExportTilesButton } from './components/ExportTilesButton';
import { LibertyMap } from './components/LibertyMap';
import { ZoomBadge } from './components/ZoomBadge';
import { TrashIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';
import { getCountryOsmLevels } from './data/osm-admin-levels';
import { countries } from './data/countries';
import { bboxForFeatures, getBufferedBboxForZoom } from './utils/tiles';

interface BoundaryResponse {
  country_code: string;
  source: string;
  size_kb: number;
  feature_count: number;
  bbox: number[];
  /** topojson stringified already */
  topojson: string;
}

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
  return `${appBasePath()}${code.toUpperCase()}`;
}

function App() {
  const [countryCode, setCountryCode] = useState<string | null>(() => getCountryCodeFromUrl());
  const [selectedAdminLevel, setSelectedAdminLevel] = useState<number>(2);
  const [tileMaxZoom, setTileMaxZoom] = useState(8);
  const [tileBuffer, setTileBuffer] = useState(1);
  const [mapZoom, setMapZoom] = useState(2);
  const [loading, setLoading] = useState<boolean>(() => getCountryCodeFromUrl() !== null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BoundaryResponse | null>(null);

  // Mirror of countryCode for the popstate handler (avoids a stale closure).
  const countryCodeRef = useRef(countryCode);
  useEffect(() => {
    countryCodeRef.current = countryCode;
  }, [countryCode]);

  const API_URL = import.meta.env.VITE_API_URL || '/api';

  // Fire-and-forget: warm the server tile cache (z0–8) as soon as we know a
  // country is needed, so a later export mostly serves cached tiles.
  // Render calls serialize server-side; failures are only logged.
  const prewarmTiles = useCallback(
    (country_code: string, bbox: number[], buffer: number) => {
      if (!bbox || bbox.length < 4) return;
      fetch(`${API_URL}/prewarm-tiles`, {
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

  // Derive active admin level during render to avoid cascading renders
  const adminLevel = useMemo(() => {
    const osmInfo = getCountryOsmLevels(countryCode ?? undefined);
    const isSupportedByCountry =
      !osmInfo?.levels || Boolean(osmInfo.levels[String(selectedAdminLevel)]);
    const isAvailableInData =
      !availableLevels.length || availableLevels.includes(selectedAdminLevel);

    if (isSupportedByCountry && isAvailableInData) {
      return selectedAdminLevel;
    }

    const candidates = [2, 3, 4, 5, 6, 7, 8].filter(
      (level) =>
        (!osmInfo?.levels || Boolean(osmInfo.levels[String(level)])) &&
        (!availableLevels.length || availableLevels.includes(level)),
    );

    if (candidates.length > 0) {
      return candidates.includes(2) ? 2 : candidates[0];
    }
    if (availableLevels.length > 0) {
      return availableLevels[0];
    }
    return selectedAdminLevel;
  }, [countryCode, availableLevels, selectedAdminLevel]);

  const geoJsonData = useMemo(() => {
    if (!fullGeoJson) return null;
    return {
      ...fullGeoJson,
      features: fullGeoJson.features.filter(
        (f: any) => Number(f.properties.admin_level) === adminLevel,
      ),
    };
  }, [fullGeoJson, adminLevel]);

  // Raw bounds for the currently selected admin level (falls back to the
  // country bbox until features load), plus the tile-snapped box actually exported.
  const baseBbox = useMemo<[number, number, number, number] | null>(() => {
    const fromFeatures = bboxForFeatures(geoJsonData);
    if (fromFeatures) return fromFeatures;
    if (data?.bbox && data.bbox.length >= 4) {
      return data.bbox.slice(0, 4) as [number, number, number, number];
    }
    return null;
  }, [geoJsonData, data]);

  // Honest preview of the discrete tile buffer: outer edges of the buffered
  // tile cover at max zoom (low zooms cover a larger geographic area).
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

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ country_code: upper }),
        });

        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to fetch boundaries');
        }

        const payload: BoundaryResponse = await res.json();
        setData(payload);
        prewarmTiles(payload.country_code, payload.bbox, tileBuffer);
      } catch (err: any) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('An unexpected error occurred while fetching boundaries.');
        }
      } finally {
        setLoading(false);
      }
    },
    [API_URL, prewarmTiles, tileBuffer],
  );

  const handleCountryChange = useCallback(
    (newCode: string) => {
      const upper = newCode.toUpperCase();
      if (upper === countryCodeRef.current) return;
      window.history.pushState({ countryCode: upper }, '', countryUrl(upper));
      void loadCountry(upper);
    },
    [loadCountry],
  );

  // Initial load: country comes from the URL; the root `/` loads nothing.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    const initial = getCountryCodeFromUrl();
    if (!initial) {
      setLoading(false);
      return;
    }
    void loadCountry(initial);
  }, [loadCountry]);

  // Back/forward buttons: URL is the source of truth.
  useEffect(() => {
    const onPopState = () => {
      const code = getCountryCodeFromUrl();
      if (code === countryCodeRef.current) return;
      if (!code) {
        setCountryCode(null);
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      void loadCountry(code);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [loadCountry]);

  // Keep the tab title in sync with the selected country.
  useEffect(() => {
    if (!countryCode) {
      document.title = 'Geo Boundaries';
      return;
    }
    const label = countries.find((c) => c.code === countryCode)?.label ?? countryCode;
    document.title = `${label} · Geo Boundaries`;
  }, [countryCode]);

  const downloadTopojson = () => {
    if (!data?.topojson) return;
    const blob = new Blob([data.topojson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.country_code}.topo.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen w-screen flex-col md:flex-row bg-slate-50">
      {/* Sidebar Controls */}
      <div className="w-full md:w-80 bg-white border-r border-slate-200 p-6 flex flex-col gap-6 shadow-sm z-10 overflow-y-auto">
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Geo Boundaries</h1>
            <span className="text-xs text-slate-500 font-mono">
              v{import.meta.env.VITE_APP_VERSION}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">API Testing Interface</p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700">Country</label>
            <CountrySelect value={countryCode ?? ''} onChange={handleCountryChange} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Admin Level</label>
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
              countryCode={countryCode ?? undefined}
              availableLevels={availableLevels}
            />
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            {error}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-slate-200">
            <h3 className="font-semibold text-slate-900 text-sm">Results Summary</h3>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-slate-500">Source:</div>
              <div className="font-medium text-right capitalize">{data.source}</div>

              <div className="text-slate-500">Features:</div>
              <div className="font-medium text-right">{data.feature_count}</div>

              <div className="text-slate-500">Size:</div>
              <div className="font-medium text-right">{data.size_kb} KB</div>
            </div>

            <button
              onClick={downloadTopojson}
              className="mt-2 w-full bg-white border border-slate-300 text-slate-700 font-medium py-2 px-4 rounded-md shadow-sm hover:bg-slate-50 transition-colors"
            >
              Download TopoJSON
            </button>

            <ExportTilesButton
              countryCode={data.country_code}
              bbox={(baseBbox ?? data.bbox) as [number, number, number, number]}
              buffer={tileBuffer}
              onBufferChange={setTileBuffer}
              apiUrl={API_URL}
              maxZoom={tileMaxZoom}
              onMaxZoomChange={setTileMaxZoom}
            />
          </div>
        )}

        {/* Admin Tools - Dev Only */}
        {import.meta.env.DEV && (
          <div className="mt-auto pt-4 border-t border-slate-200">
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
                } catch (e: any) {
                  alert(e.message || 'Error clearing cache');
                }
              }}
              className="w-full flex justify-center items-center gap-2 bg-red-50 text-red-600 font-medium py-2 px-4 rounded-md shadow-sm border border-red-200 hover:bg-red-100 transition-colors text-sm"
            >
              <TrashIcon className="h-5 w-5" />
              Clear Server Cache (Dev)
            </button>
          </div>
        )}
      </div>

      {/* Map Area */}
      <div className="flex-1 relative z-0">
        {/* Live Liberty vector style (same style the raster packs render), so the
            preview always matches export output at any zoom — no tile cap here. */}
        <LibertyMap
          bbox={(data?.bbox as [number, number, number, number] | undefined) ?? null}
          geoJsonData={geoJsonData as GeoJSON.FeatureCollection | null}
          exportBbox={exportBbox}
          onZoomChange={setMapZoom}
        />
        <ZoomBadge zoom={mapZoom} />

        {/* Empty state on the root `/` (no country in the URL yet) */}
        {!loading && !data && !countryCode && (
          <div className="absolute inset-0 z-[400] flex items-center justify-center pointer-events-none">
            <div className="bg-white px-6 py-4 rounded-xl shadow-lg border border-slate-200 text-slate-600 text-sm max-w-xs text-center">
              Select a country to view its boundaries
            </div>
          </div>
        )}

        {/* Loading overlay for Map */}
        {loading && (
          <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-[400] flex items-center justify-center">
            <div className="bg-white px-6 py-3 rounded-full shadow-lg border border-slate-200 font-medium text-slate-700 flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-slate-600 border-t-transparent rounded-full animate-spin"></div>
              Processing Data...
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
