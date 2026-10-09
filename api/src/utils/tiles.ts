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

/** Tile index range covering a bbox at a zoom (unbuffered, clamped). Pure. */
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
    // Latitude is inverted in slippy tiles (higher y is further north, meaning smaller y is larger latitude)
    // Max latitude -> smallest Y tile
    // Min latitude -> largest Y tile
    minY: Math.max(0, lat2tile(maxLat, zoom)),
    maxY: Math.min(limit, lat2tile(minLat, zoom)),
  };
}

/** Expand a tile range by `bufferTiles` in every direction, clamped to the grid. Pure. */
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

export function getTilesForBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  zoom: number,
  bufferTiles = 0,
): { x: number; y: number; z: number }[] {
  const range = expandTileRange(
    getTileRangeForBbox(minLon, minLat, maxLon, maxLat, zoom),
    zoom,
    bufferTiles,
  );

  const tiles = [];
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

/**
 * Geographic bbox of the outer edges of the buffered tile cover at `zoom`.
 * This is exactly what the export contains at that zoom, so it is the honest
 * preview of a discrete tile buffer (which in degrees varies by zoom).
 * Returns [minLon, minLat, maxLon, maxLat]. Pure — safe to unit test.
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

/**
 * Mercator-correct center of a slippy tile (half-tile offset in tile space,
 * not a naive average of corner latitudes which drifts off-center).
 */
export function tileCenterLon(x: number, z: number): number {
  return ((x + 0.5) / Math.pow(2, z)) * 360 - 180;
}

export function tileCenterLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
