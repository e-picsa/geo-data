import { useMemo, useState } from 'react';
import { CloudArrowDownIcon } from '@heroicons/react/20/solid';
import { countTilesForBbox, formatBytes } from '../utils/tiles';

interface ExportPmtilesButtonProps {
  countryCode: string;
  /** World bbox for GLOBAL, country boundary bbox otherwise. */
  bbox: [number, number, number, number] | null;
  apiUrl: string;
}

const PMTILES_GLOBAL_MIN_ZOOM = 0;
const PMTILES_GLOBAL_ZOOMS = [0, 1, 2, 3, 4, 5, 6];
const PMTILES_GLOBAL_DEFAULT_ZOOM = 4;
const PMTILES_COUNTRY_MIN_ZOOM = 4;
const PMTILES_COUNTRY_ZOOMS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const PMTILES_COUNTRY_DEFAULT_ZOOM = 8;

/** Shared Southern Africa top-up for composite global bases (mirrors the API). */
const SOUTHERN_AFRICA_BBOX: [number, number, number, number] = [21.5, -23.0, 36.5, -8.0];
const SOUTHERN_AFRICA_MIN_ZOOM = 4;
const SOUTHERN_AFRICA_MAX_ZOOM = 6;

/** Above this many tiles the export gets slow — ask for confirmation. */
const LARGE_EXPORT_TILES = 2500;

/**
 * Rough gzipped-PBF bytes/tile by zoom, calibrated from measured OpenFreeMap
 * planet extracts (world z0 ~80KB, z1 ~200KB, z2–4 ~170KB avg with a z2 peak
 * as whole continents pack into few tiles; Malawi z7 ~64KB falling to z10
 * ~11KB as tiles get smaller). Dense countries run larger — rough on purpose.
 */
function bytesPerVectorTile(z: number): number {
  if (z <= 1) return 150 * 1024;
  if (z <= 4) return 170 * 1024;
  if (z <= 6) return 40 * 1024;
  if (z <= 8) return 45 * 1024;
  if (z <= 10) return 15 * 1024;
  return 25 * 1024;
}

export function ExportPmtilesButton({ countryCode, bbox, apiUrl }: ExportPmtilesButtonProps) {
  const isGlobal = countryCode.toUpperCase() === 'GLOBAL';
  const zoomOptions = isGlobal ? PMTILES_GLOBAL_ZOOMS : PMTILES_COUNTRY_ZOOMS;
  const [minZoom, setMinZoom] = useState(
    isGlobal ? PMTILES_GLOBAL_MIN_ZOOM : PMTILES_COUNTRY_MIN_ZOOM,
  );
  const [maxZoom, setMaxZoom] = useState(
    isGlobal ? PMTILES_GLOBAL_DEFAULT_ZOOM : PMTILES_COUNTRY_DEFAULT_ZOOM,
  );
  // The app consumes one preset: mobile packs only. The API still accepts
  // full/minimal, but this UI offers no other choice.
  const layers = 'mobile' as const;
  // GLOBAL only: union the Southern Africa z4–6 top-up into a composite base.
  const [includeRegions, setIncludeRegions] = useState(isGlobal);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const estimate = useMemo(() => {
    if (!bbox) return null;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const tileCount = countTilesForBbox(minLon, minLat, maxLon, maxLat, minZoom, maxZoom, 0);
    let bytes = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      bytes += countTilesForBbox(minLon, minLat, maxLon, maxLat, z, z, 0) * bytesPerVectorTile(z);
    }
    if (isGlobal && includeRegions) {
      const [rLon1, rLat1, rLon2, rLat2] = SOUTHERN_AFRICA_BBOX;
      for (let z = SOUTHERN_AFRICA_MIN_ZOOM; z <= SOUTHERN_AFRICA_MAX_ZOOM; z++) {
        bytes += countTilesForBbox(rLon1, rLat1, rLon2, rLat2, z, z, 0) * bytesPerVectorTile(z);
      }
    }
    // Mobile preset (the only one this UI offers): threshold-aligned filtering
    // plus per-layer allowlists (measured ~0.42–0.83x of minimal across z4–z10).
    bytes = Math.round(bytes * (maxZoom <= 6 ? 0.3 : 0.45));
    // PMTiles dedups byte-identical tiles (common for ocean/low-zoom): measured
    // ~0.55x for global packs, ~0.7x for Malawi.
    bytes = Math.round(bytes * (isGlobal ? 0.55 : 0.7));
    // Polygon masking trims ~25–40% of bbox tiles outside the country border.
    if (!isGlobal) bytes = Math.round(bytes * 0.7);
    return { tileCount, bytes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3], minZoom, maxZoom, layers, includeRegions]);

  const handleExport = async () => {
    if (!bbox) return;
    setDownloading(true);
    setError(null);

    try {
      if (estimate && estimate.tileCount > LARGE_EXPORT_TILES) {
        const ok = confirm(
          `Large export: ~${estimate.tileCount.toLocaleString()} vector tiles.` +
            `\n\nKeep this tab open until the download starts. Continue?`,
        );
        if (!ok) {
          setDownloading(false);
          return;
        }
      }

      const body: Record<string, unknown> = { country_code: countryCode, maxZoom, layers };
      if (!isGlobal) {
        body.bbox = bbox;
        body.minZoom = minZoom;
      } else if (includeRegions) {
        body.regions = [
          {
            bbox: SOUTHERN_AFRICA_BBOX,
            minZoom: SOUTHERN_AFRICA_MIN_ZOOM,
            maxZoom: SOUTHERN_AFRICA_MAX_ZOOM,
          },
        ];
      }

      const res = await fetch(`${apiUrl}/export-pmtiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed with status ${res.status}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = `${countryCode}_z${minZoom}-${maxZoom}_${layers}.pmtiles`;
      if (contentDisposition) {
        const m = contentDisposition.match(/filename="?([^"]+)"?/);
        if (m && m[1]) filename = m[1];
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export pmtiles:', err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!isGlobal && (
        <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
          <span title="Country packs can start at z7+ when layered over a composite base that owns the low zooms">
            Vector min zoom
          </span>
          <select
            value={minZoom}
            onChange={(e) => {
              const z = Number(e.target.value);
              setMinZoom(z);
              if (z > maxZoom) setMaxZoom(z);
            }}
            disabled={downloading}
            className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            title="Lowest zoom included in the vector pack"
          >
            {zoomOptions
              .filter((z) => z <= maxZoom)
              .map((z) => (
                <option key={z} value={z}>
                  z{z}
                  {z === PMTILES_COUNTRY_MIN_ZOOM ? ' (default)' : ''}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
        <span
          title={
            isGlobal
              ? 'Global base owns zooms 0–3 (country packs start at z4, or z7+ over a composite base)'
              : 'Country detail — pair with the global base (z0–3) or composite base (z0–6/7)'
          }
        >
          Vector max zoom (from z{minZoom})
        </span>
        <select
          value={maxZoom}
          onChange={(e) => setMaxZoom(Number(e.target.value))}
          disabled={downloading}
          className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          title="Highest zoom included in the vector pack"
        >
          {(isGlobal ? zoomOptions : zoomOptions.filter((z) => z >= minZoom)).map((z) => (
            <option key={z} value={z}>
              z{z}
              {z === (isGlobal ? PMTILES_GLOBAL_DEFAULT_ZOOM : PMTILES_COUNTRY_DEFAULT_ZOOM)
                ? ' (default)'
                : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-slate-500">
        Mobile offline pack (threshold-aligned filtering, masked to the border). Same style as the
        online map — only the tile source differs.
      </p>
      {isGlobal && (
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeRegions}
            onChange={(e) => setIncludeRegions(e.target.checked)}
            disabled={downloading}
            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span
            className="text-xs font-medium text-slate-700"
            title="Unions Southern Africa z4–6 into the world base so MW/ZM/ZW packs can start at z7 with zero duplication"
          >
            Include Southern Africa top-up (z4–6)
          </span>
        </label>
      )}
      {estimate && (
        <p className="text-xs text-slate-500">
          ~{estimate.tileCount.toLocaleString()} vector tiles · ~{formatBytes(estimate.bytes)}
          {estimate.tileCount > LARGE_EXPORT_TILES && (
            <span className="text-amber-700 font-medium"> — large export, keep tab open</span>
          )}
        </p>
      )}
      <button
        onClick={handleExport}
        disabled={downloading || !bbox}
        className="w-full flex justify-center items-center gap-2 bg-emerald-50 text-emerald-700 font-medium py-2 px-4 rounded-md shadow-sm border border-emerald-200 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
      >
        {downloading ? (
          <>
            <div className="w-4 h-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
            Fetching & Packing Vectors...
          </>
        ) : (
          <>
            <CloudArrowDownIcon className="h-5 w-5" />
            Export Vector Tiles (PMTiles)
          </>
        )}
      </button>
      {error && <div className="text-red-600 text-xs mt-1">{error}</div>}
    </div>
  );
}
