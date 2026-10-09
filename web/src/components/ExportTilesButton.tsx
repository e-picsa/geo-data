import { useMemo, useState } from 'react';
import { CloudArrowDownIcon } from '@heroicons/react/20/solid';
import { estimateExport, formatBytes, formatDuration } from '../utils/tiles';

interface ExportTilesButtonProps {
  countryCode: string;
  /** Raw (unpadded) bbox for the selected admin level. Sent as-is; backend applies `buffer`. */
  bbox: number[];
  /** Discrete tile buffer — N extra tiles in every direction at each zoom. */
  buffer: number;
  onBufferChange: (buffer: number) => void;
  apiUrl: string;
  maxZoom: number;
  onMaxZoomChange: (maxZoom: number) => void;
}

const ZOOM_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** Above this many tiles the export gets slow — ask for confirmation. */
const LARGE_EXPORT_TILES = 2500;

export function ExportTilesButton({
  countryCode,
  bbox,
  buffer,
  onBufferChange,
  apiUrl,
  maxZoom,
  onMaxZoomChange,
}: ExportTilesButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tuple = bbox.length >= 4 ? (bbox.slice(0, 4) as [number, number, number, number]) : null;
  const estimate = useMemo(
    () => (tuple ? estimateExport(tuple, 0, maxZoom, buffer) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tuple?.[0], tuple?.[1], tuple?.[2], tuple?.[3], maxZoom, buffer],
  );

  const handleExport = async () => {
    setDownloading(true);
    setError(null);

    try {
      if (estimate && estimate.tileCount > LARGE_EXPORT_TILES) {
        const ok = confirm(
          `Large export: ~${estimate.tileCount.toLocaleString()} tiles, ~${formatBytes(estimate.bytes)}, taking ${formatDuration(estimate.seconds)}.\n\nKeep this tab open until the download starts. Continue?`,
        );
        if (!ok) {
          setDownloading(false);
          return;
        }
      }

      const res = await fetch(`${apiUrl}/export-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country_code: countryCode,
          bbox,
          buffer,
          minZoom: 0,
          maxZoom,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed with status ${res.status}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Get filename from Content-Disposition if available, or fallback
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = `${countryCode}_tiles.tar.gz`;
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }

      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export tiles:', err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
        <span title="Extra tiles around the selected admin level bounds, in every direction at each zoom. The grey box shows the exact tile cover at max zoom (low zooms cover more).">
          Tile buffer
        </span>
        <input
          type="number"
          value={buffer}
          min={0}
          max={8}
          step={1}
          onChange={(e) => {
            const v = Math.floor(Number(e.target.value));
            onBufferChange(Number.isFinite(v) ? Math.min(8, Math.max(0, v)) : 0);
          }}
          disabled={downloading}
          className="ml-2 w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          title="Extra tiles in every direction at each zoom (0 = exact cover)"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
        <span>Offline pack max zoom</span>
        <select
          value={maxZoom}
          onChange={(e) => onMaxZoomChange(Number(e.target.value))}
          disabled={downloading}
          className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          title="Highest zoom included in the offline pack"
        >
          {ZOOM_OPTIONS.map((z) => (
            <option key={z} value={z}>
              z{z}
              {z === 8 ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      {estimate && (
        <p className="text-xs text-slate-500">
          ~{estimate.tileCount.toLocaleString()} tiles · ~{formatBytes(estimate.bytes)} ·{' '}
          {formatDuration(estimate.seconds)}
          {estimate.tileCount > LARGE_EXPORT_TILES && (
            <span className="text-amber-700 font-medium"> — large export, keep tab open</span>
          )}
        </p>
      )}
      <button
        onClick={handleExport}
        disabled={downloading || !bbox || bbox.length < 4}
        className="w-full flex justify-center items-center gap-2 bg-indigo-50 text-indigo-700 font-medium py-2 px-4 rounded-md shadow-sm border border-indigo-200 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
      >
        {downloading ? (
          <>
            <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            Compressing & Downloading...
          </>
        ) : (
          <>
            <CloudArrowDownIcon className="h-5 w-5" />
            Export Offline Map Tiles (WebP)
          </>
        )}
      </button>
      {error && <div className="text-red-600 text-xs mt-1">{error}</div>}
    </div>
  );
}
