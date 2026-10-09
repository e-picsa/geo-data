// Slippy-map tile math (mirrors api/src/utils/tiles.ts) + offline-pack estimates.

export function lon2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

export function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 -
      Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2) *
      Math.pow(2, zoom),
  );
}

export function countTilesForBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  minZoom: number,
  maxZoom: number,
): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const minX = Math.max(0, lon2tile(minLon, z));
    const maxX = Math.min(Math.pow(2, z) - 1, lon2tile(maxLon, z));
    const minY = Math.max(0, lat2tile(maxLat, z));
    const maxY = Math.min(Math.pow(2, z) - 1, lat2tile(minLat, z));
    if (maxX >= minX && maxY >= minY) {
      total += (maxX - minX + 1) * (maxY - minY + 1);
    }
  }
  return total;
}

// Rough per-tile WebP bytes by zoom, from measured Liberty renders
// (z4 ~12KB parks/labels, z6-8 ~1-6KB mixed, z10+ water-heavy ~0.3-2KB).
// Land-heavy high-zoom tiles run larger — this is a floor-biased estimate.
function bytesPerTile(z: number): number {
  if (z <= 4) return 10 * 1024;
  if (z <= 8) return 5 * 1024;
  return 8 * 1024;
}

/** Rough pack size/time estimate. Renders average ~0.35s/tile; workers mirror the API tiers (1/2/4). */
export function estimateExport(
  bbox: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
): { tileCount: number; bytes: number; seconds: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  let tileCount = 0;
  let bytes = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const minX = Math.max(0, lon2tile(minLon, z));
    const maxX = Math.min(Math.pow(2, z) - 1, lon2tile(maxLon, z));
    const minY = Math.max(0, lat2tile(maxLat, z));
    const maxY = Math.min(Math.pow(2, z) - 1, lat2tile(minLat, z));
    if (maxX >= minX && maxY >= minY) {
      const n = (maxX - minX + 1) * (maxY - minY + 1);
      tileCount += n;
      bytes += n * bytesPerTile(z);
    }
  }
  const workers = tileCount < 150 ? 1 : tileCount < 1000 ? 2 : 4;
  return { tileCount, bytes, seconds: Math.round((tileCount * 0.35) / workers) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `~${Math.max(5, totalSeconds)}s`;
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `~${mins} min`;
  return `~${Math.floor(mins / 60)}h ${mins % 60}m`;
}
