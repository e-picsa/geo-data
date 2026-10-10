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
const PMTILES_COUNTRY_MIN_ZOOM = 7;
const PMTILES_COUNTRY_ZOOMS = [7, 8, 9, 10, 11, 12];
const PMTILES_COUNTRY_DEFAULT_ZOOM = 10;

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
  const minZoom = isGlobal ? PMTILES_GLOBAL_MIN_ZOOM : PMTILES_COUNTRY_MIN_ZOOM;
  const zoomOptions = isGlobal ? PMTILES_GLOBAL_ZOOMS : PMTILES_COUNTRY_ZOOMS;
  const [maxZoom, setMaxZoom] = useState(
    isGlobal ? PMTILES_GLOBAL_DEFAULT_ZOOM : PMTILES_COUNTRY_DEFAULT_ZOOM,
  );
  const [layers, setLayers] = useState<'full' | 'minimal'>('full');
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
    // Minimal preset only strips z8+ bulk layers (aerodrome_label, aeroway,
    // poi); low zooms unchanged.
    if (layers === 'minimal' && maxZoom >= 10) bytes = Math.round(bytes * 0.75);
    // PMTiles dedups byte-identical tiles (common for ocean/low-zoom): measured
    // ~0.55x for global packs, ~0.7x for Malawi.
    bytes = Math.round(bytes * (isGlobal ? 0.55 : 0.7));
    return { tileCount, bytes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3], minZoom, maxZoom, layers]);

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
      if (!isGlobal) body.bbox = bbox;

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
      <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
        <span
          title={
            isGlobal
              ? 'Global base layer owns zooms 0–6 (country packs start at z7)'
              : 'Country detail starts at z7 — the global base owns z0–6'
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
          {zoomOptions.map((z) => (
            <option key={z} value={z}>
              z{z}
              {z === (isGlobal ? PMTILES_GLOBAL_DEFAULT_ZOOM : PMTILES_COUNTRY_DEFAULT_ZOOM)
                ? ' (default)'
                : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
        <span title="Full replicates the WebP map exactly. Minimal drops buildings/POIs/aeroways (only present at z10+) to shrink country packs.">
          Vector layers
        </span>
        <select
          value={layers}
          onChange={(e) => setLayers(e.target.value as 'full' | 'minimal')}
          disabled={downloading}
          className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          title="Full = byte-identical upstream tiles; minimal = strip z10+ bulk layers"
        >
          <option value="full">full (exact map)</option>
          <option value="minimal">minimal (smaller)</option>
        </select>
      </label>
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
