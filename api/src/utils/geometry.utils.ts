/**
 * Utilities for geometric calculations on GeoJSON polygons and multipolygons.
 */

export function getRingAreaAndCentroid(ring: number[][]): { area: number; cx: number; cy: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p1 = ring[i];
    const p2 = ring[j];
    const f = p1[0] * p2[1] - p2[0] * p1[1];
    area += f;
    cx += (p1[0] + p2[0]) * f;
    cy += (p1[1] + p2[1]) * f;
  }
  area = area / 2;
  if (Math.abs(area) < 1e-12) {
    return { area: 0, cx: ring[0]?.[0] ?? 0, cy: ring[0]?.[1] ?? 0 };
  }
  return {
    area: Math.abs(area),
    cx: cx / (6 * area),
    cy: cy / (6 * area),
  };
}

/**
 * Calculates the geometric centroid (center of mass) of a GeoJSON Polygon or MultiPolygon.
 */
export function getPolygonCentroid(geometry: any): [number, number] | null {
  if (!geometry || !geometry.coordinates || !Array.isArray(geometry.coordinates)) {
    return null;
  }
  let totalArea = 0;
  let weightedX = 0;
  let weightedY = 0;

  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons)) return null;

  for (const poly of polygons) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0]) || poly[0].length === 0) continue;
    const outer = getRingAreaAndCentroid(poly[0]);
    if (outer.area > 0) {
      weightedX += outer.cx * outer.area;
      weightedY += outer.cy * outer.area;
      totalArea += outer.area;
    }
  }

  if (totalArea === 0) return null;
  return [weightedX / totalArea, weightedY / totalArea];
}

/**
 * Standard ray-casting test for whether a 2D point [x, y] is inside a polygon ring.
 */
export function pointInRing(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Checks whether a 2D point [x, y] lies inside a GeoJSON Polygon or MultiPolygon (accounting for holes).
 */
export function pointInPolygonGeometry(pt: [number, number], geometry: any): boolean {
  if (!geometry || !geometry.coordinates || !Array.isArray(geometry.coordinates)) {
    return false;
  }

  if (geometry.type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates[0])) return false;
    if (!pointInRing(pt, geometry.coordinates[0])) return false;
    // Check holes
    for (let k = 1; k < geometry.coordinates.length; k++) {
      if (pointInRing(pt, geometry.coordinates[k])) return false;
    }
    return true;
  }

  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
      if (pointInRing(pt, poly[0])) {
        let inHole = false;
        for (let k = 1; k < poly.length; k++) {
          if (pointInRing(pt, poly[k])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * Checks if the geometric centroid of a GeoJSON geometry is strictly inside its own polygon boundary.
 */
export function isCentroidInsideGeometry(geometry: any): boolean {
  const centroid = getPolygonCentroid(geometry);
  if (!centroid) return false;
  return pointInPolygonGeometry(centroid, geometry);
}
