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

export function getTilesForBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  zoom: number,
): { x: number; y: number; z: number }[] {
  const minX = Math.max(0, lon2tile(minLon, zoom));
  const maxX = Math.min(Math.pow(2, zoom) - 1, lon2tile(maxLon, zoom));

  // Latitude is inverted in slippy tiles (higher y is further north, meaning smaller y is larger latitude)
  // Max latitude -> smallest Y tile
  // Min latitude -> largest Y tile
  const minY = Math.max(0, lat2tile(maxLat, zoom));
  const maxY = Math.min(Math.pow(2, zoom) - 1, lat2tile(minLat, zoom));

  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}
