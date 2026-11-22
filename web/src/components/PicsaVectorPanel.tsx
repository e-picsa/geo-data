import { useCallback, useEffect, useState } from 'react';
import { CubeTransparentIcon } from '@heroicons/react/20/solid';
import type { QaInspectedFeature } from './LibertyMap';
import { formatBytes } from '../utils/tiles';

export interface QaPackManifest {
  file: string;
  minZoom: number;
  maxZoom: number;
  layers: string;
  masked: boolean;
  strippedNames?: boolean;
  dataDate?: string;
  fileSizeBytes: number;
  tileCount: number;
  sha256?: string;
  featureStats?: Record<string, Record<string, { kept: number; dropped: number }>>;
}

interface QaPackEntry {
  manifest: QaPackManifest;
  local: boolean;
  gcs: boolean;
}

interface PicsaVectorPanelProps {
  apiUrl: string;
  mapZoom: number;
  qaPack: QaPackManifest | null;
  onSelectPack: (manifest: QaPackManifest) => void;
  onClearPack: () => void;
  inspected: QaInspectedFeature[];
  onClearInspected: () => void;
}

/** pmtiles:// URLs must be absolute — resolve relative API bases against origin. */
export function pmtilesPackUrl(apiUrl: string, file: string): string {
  const path = `${apiUrl.replace(/\/$/, '')}/pmtiles/${file}`;
  const absolute = /^https?:\/\//i.test(path)
    ? path
    : `${window.location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
  return `pmtiles://${absolute}`;
}

export function PicsaVectorPanel({
  apiUrl,
  mapZoom,
  qaPack,
  onSelectPack,
  onClearPack,
  inspected,
  onClearInspected,
}: PicsaVectorPanelProps) {
  const [packs, setPacks] = useState<QaPackEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/pmtiles`);
      if (!res.ok) throw new Error(`Pack list failed with status ${res.status}`);
      const data = (await res.json()) as { packs?: QaPackEntry[] };
      setPacks(data.packs ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load pack list.');
    }
  }, [apiUrl]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stats = qaPack?.featureStats?.[String(mapZoom)];
  const statRows = stats
    ? Object.entries(stats)
        .map(([layer, v]) => ({ layer, ...v, total: v.kept + v.dropped }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.dropped - a.dropped)
        .slice(0, 8)
    : null;
  const statTotals = statRows?.reduce(
    (acc, r) => ({ kept: acc.kept + r.kept, dropped: acc.dropped + r.dropped }),
    { kept: 0, dropped: 0 },
  );

  const inRange = qaPack ? mapZoom >= qaPack.minZoom && mapZoom <= qaPack.maxZoom : false;

  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-slate-900 text-sm inline-flex items-center gap-1.5">
          <CubeTransparentIcon className="h-4 w-4 text-indigo-600" aria-hidden="true" />
          PICSA Vector QA
        </h4>
        <button
          type="button"
          onClick={refresh}
          className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
          title="Reload the pack list from the API"
        >
          Refresh
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Renders a locally served pack with debug layers. Click the map to inspect features; the
        table shows per-layer kept vs omitted counts at the current zoom.
      </p>

      {listError && <div className="text-red-600 text-xs">{listError}</div>}

      {packs && packs.length === 0 && (
        <p className="text-xs text-slate-400 italic">
          No packs on the server yet — export one above or run prewarm.
        </p>
      )}

      {packs && packs.length > 0 && (
        <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
          {packs.map((p) => {
            const m = p.manifest;
            const active = qaPack?.file === m.file;
            return (
              <div
                key={m.file}
                className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs ${
                  active ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white'
                }`}
              >
                <div className="min-w-0">
                  <div className="font-mono font-medium text-slate-800 truncate" title={m.file}>
                    {m.file}
                  </div>
                  <div className="text-slate-500">
                    z{m.minZoom}–{m.maxZoom} · {m.layers}
                    {m.masked ? ' · masked' : ''} · {formatBytes(m.fileSizeBytes)}
                  </div>
                </div>
                {active ? (
                  <button
                    type="button"
                    onClick={onClearPack}
                    className="shrink-0 text-xs font-medium text-slate-500 hover:text-red-600"
                  >
                    Unload
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelectPack(m)}
                    className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                  >
                    Preview
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {qaPack && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 text-xs flex flex-col gap-1.5">
          <div className="flex justify-between text-slate-700">
            <span>
              Coverage z{qaPack.minZoom}–{qaPack.maxZoom} · map z{mapZoom}
            </span>
            <span
              className={
                inRange ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'
              }
            >
              {inRange
                ? 'served by pack'
                : mapZoom < qaPack.minZoom
                  ? 'below pack (base)'
                  : 'above pack (overzoom)'}
            </span>
          </div>

          {statRows && statTotals ? (
            <table className="w-full text-[11px] text-slate-600">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="font-medium py-0.5">layer @z{mapZoom}</th>
                  <th className="font-medium text-right">kept</th>
                  <th className="font-medium text-right">omitted</th>
                </tr>
              </thead>
              <tbody>
                {statRows.map((r) => (
                  <tr key={r.layer} className="border-t border-indigo-100">
                    <td className="py-0.5 font-mono">{r.layer}</td>
                    <td className="text-right">{r.kept.toLocaleString()}</td>
                    <td className="text-right text-amber-700">{r.dropped.toLocaleString()}</td>
                  </tr>
                ))}
                <tr className="border-t border-indigo-200 font-semibold text-slate-700">
                  <td className="py-0.5">total</td>
                  <td className="text-right">{statTotals.kept.toLocaleString()}</td>
                  <td className="text-right">{statTotals.dropped.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-slate-400 italic">
              {qaPack.featureStats
                ? `No feature stats recorded for z${mapZoom} (pack covers z${qaPack.minZoom}–${qaPack.maxZoom}).`
                : 'This pack has no feature stats (full preset or built before stats).'}
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-slate-500">
              {inspected.length > 0
                ? `${inspected.length} feature${inspected.length === 1 ? '' : 's'} under cursor`
                : 'Click the map to inspect pack features'}
            </span>
            {inspected.length > 0 && (
              <button
                type="button"
                onClick={onClearInspected}
                className="text-slate-500 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>
          {inspected.length > 0 && (
            <ul className="flex flex-col gap-0.5 max-h-28 overflow-y-auto">
              {inspected.map((f, i) => (
                <li key={i} className="font-mono text-[11px] text-slate-700">
                  <span className="text-indigo-700">{f.sourceLayer || f.layer}</span>
                  {f.class ? ` · ${f.class}` : ''}
                  {f.name ? ` · “${f.name}”` : ''} · {f.type}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
