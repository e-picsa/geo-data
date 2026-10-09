// Slippy-map tile math (mirrors api/src/utils/tiles.ts) + offline-pack estimates.

export function tile2lon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Tile index range covering a bbox at a zoom (unbuffered, clamped). */
export function getTileRangeForBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  zoom: number,
): TileRange {
  const limit = Math.pow(2, zoom) - 1;
  return {
    minX: Math.max(0, lon2tile(minLon, zoom)),
    maxX: Math.min(limit, lon2tile(maxLon, zoom)),
    minY: Math.max(0, lat2tile(maxLat, zoom)),
    maxY: Math.min(limit, lat2tile(minLat, zoom)),
  };
}

/** Expand a tile range by `bufferTiles` in every direction, clamped to the grid. */
export function expandTileRange(range: TileRange, zoom: number, bufferTiles: number): TileRange {
  if (!Number.isFinite(bufferTiles) || bufferTiles <= 0) return range;
  const b = Math.floor(bufferTiles);
  const limit = Math.pow(2, zoom) - 1;
  return {
    minX: Math.max(0, range.minX - b),
    maxX: Math.min(limit, range.maxX + b),
    minY: Math.max(0, range.minY - b),
    maxY: Math.min(limit, range.maxY + b),
  };
}

/**
 * Geographic bbox of the outer edges of the buffered tile cover at `zoom`.
 * Exactly matches what the export contains at that zoom — the honest preview
 * of a discrete tile buffer (which in degrees varies by zoom).
 */
export function getBufferedBboxForZoom(
  bbox: [number, number, number, number],
  bufferTiles: number,
  zoom: number,
): [number, number, number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const range = expandTileRange(
    getTileRangeForBbox(minLon, minLat, maxLon, maxLat, zoom),
    zoom,
    bufferTiles,
  );
  return [
    tile2lon(range.minX, zoom),
    tile2lat(range.maxY + 1, zoom),
    tile2lon(range.maxX + 1, zoom),
    tile2lat(range.minY, zoom),
  ];
}

/** Bbox of a GeoJSON FeatureCollection ([minLon, minLat, maxLon, maxLat]) or null if empty. */
export function bboxForFeatures(
  geoJson: { features?: Array<{ geometry?: unknown }> } | null | undefined,
): [number, number, number, number] | null {
  if (!geoJson?.features?.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown) => {
    const arr = coords as number[] | undefined;
    if (Array.isArray(arr) && typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      const lon = arr[0];
      const lat = arr[1];
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
      return;
    }
    if (Array.isArray(coords)) {
      for (const c of coords) visit(c);
    }
  };
  for (const f of geoJson.features) {
    visit((f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates);
  }
  if (!Number.isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

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
  bufferTiles = 0,
): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const range = expandTileRange(
      getTileRangeForBbox(minLon, minLat, maxLon, maxLat, z),
      z,
      bufferTiles,
    );
    if (range.maxX >= range.minX && range.maxY >= range.minY) {
      total += (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
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
  bufferTiles = 0,
): { tileCount: number; bytes: number; seconds: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  let tileCount = 0;
  let bytes = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const range = expandTileRange(
      getTileRangeForBbox(minLon, minLat, maxLon, maxLat, z),
      z,
      bufferTiles,
    );
    if (range.maxX >= range.minX && range.maxY >= range.minY) {
      const n = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
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
