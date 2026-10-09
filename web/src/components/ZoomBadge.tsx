interface ZoomBadgeProps {
  zoom: number;
}

/** Live zoom readout, overlaid on the map. */
export function ZoomBadge({ zoom }: ZoomBadgeProps) {
  return (
    <div className="absolute top-3 right-3 z-[500] pointer-events-none">
      <div
        className="px-3 py-1.5 rounded-full shadow-md border text-xs font-semibold backdrop-blur bg-white/95 text-slate-700 border-slate-200"
        title={`Current map zoom level: ${zoom}`}
      >
        Zoom {zoom}
      </div>
    </div>
  );
}
