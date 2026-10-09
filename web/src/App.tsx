import { useState, useMemo, useCallback, useEffect } from 'react';
import * as topojsonClient from 'topojson-client';
import { CountrySelect } from './components/CountrySelect';
import { AdminLevelSelect } from './components/AdminLevelSelect';
import { ExportTilesButton } from './components/ExportTilesButton';
import { LibertyMap } from './components/LibertyMap';
import { ZoomBadge } from './components/ZoomBadge';
import { TrashIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';
import { getCountryOsmLevels } from './data/osm-admin-levels';

interface BoundaryResponse {
  country_code: string;
  source: string;
  size_kb: number;
  feature_count: number;
  bbox: number[];
  /** topojson stringified already */
  topojson: string;
}

function App() {
  const [countryCode, setCountryCode] = useState('MW');
  const [selectedAdminLevel, setSelectedAdminLevel] = useState<number>(2);
  const [tileMaxZoom, setTileMaxZoom] = useState(8);
  const [mapZoom, setMapZoom] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BoundaryResponse | null>(null);

  const API_URL = import.meta.env.VITE_API_URL || '/api';

  // Fire-and-forget: warm the server tile cache (z0–8) as soon as we know a
  // country is needed, so a later export mostly serves cached tiles.
  // Render calls serialize server-side; failures are only logged.
  const prewarmTiles = useCallback(
    (country_code: string, bbox: number[]) => {
      if (!bbox || bbox.length < 4) return;
      fetch(`${API_URL}/prewarm-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_code, bbox }),
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
    const osmInfo = getCountryOsmLevels(countryCode);
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

  const handleCountryChange = useCallback(
    async (newCode: string) => {
      setCountryCode(newCode);
      setLoading(true);
      setError(null);
      setData(null);

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ country_code: newCode }),
        });

        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to fetch boundaries');
        }

        const payload: BoundaryResponse = await res.json();
        setData(payload);
        prewarmTiles(payload.country_code, payload.bbox);
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
    [API_URL, prewarmTiles],
  );

  useEffect(() => {
    let ignore = false;

    async function loadInitial() {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ country_code: 'MW' }),
        });

        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to fetch boundaries');
        }

        const payload: BoundaryResponse = await res.json();
        if (!ignore) {
          setData(payload);
          prewarmTiles(payload.country_code, payload.bbox);
        }
      } catch (err: any) {
        if (!ignore) {
          setError(
            err instanceof Error
              ? err.message
              : 'An unexpected error occurred while fetching boundaries.',
          );
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadInitial();
    return () => {
      ignore = true;
    };
  }, [API_URL, prewarmTiles]);

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
            <CountrySelect value={countryCode} onChange={handleCountryChange} />
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
              countryCode={countryCode}
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
              bbox={data.bbox as [number, number, number, number]}
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
          onZoomChange={setMapZoom}
        />
        <ZoomBadge zoom={mapZoom} />

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
