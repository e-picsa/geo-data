import { useState } from 'react';
import { CloudArrowDownIcon } from '@heroicons/react/20/solid';

interface ExportTilesButtonProps {
  countryCode: string;
  bbox: number[];
  apiUrl: string;
}

export function ExportTilesButton({ countryCode, bbox, apiUrl }: ExportTilesButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setDownloading(true);
    setError(null);

    try {
      const res = await fetch(`${apiUrl}/export-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country_code: countryCode,
          bbox,
          minZoom: 0,
          maxZoom: 8,
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
