import { describe, expect, test } from 'bun:test';
import {
  getPolygonCentroid,
  pointInPolygonGeometry,
  isCentroidInsideGeometry,
} from './geometry.utils.ts';

describe('geometry.utils', () => {
  test('computes centroid and verifies interior for convex rectangle', () => {
    const rect = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };

    const centroid = getPolygonCentroid(rect);
    expect(centroid).toBeDefined();
    expect(centroid![0]).toBeCloseTo(1, 5);
    expect(centroid![1]).toBeCloseTo(1, 5);

    expect(pointInPolygonGeometry(centroid!, rect)).toBe(true);
    expect(isCentroidInsideGeometry(rect)).toBe(true);
  });

  test('detects centroid outside boundary for concave C-shaped polygon', () => {
    // C-shaped polygon where opening is on the right
    const cShape = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 1],
          [1, 1],
          [1, 3],
          [4, 3],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    };

    const centroid = getPolygonCentroid(cShape);
    expect(centroid).toBeDefined();
    // Centroid x will be ~1.7, y will be 2.0 (inside the cutout between [1,1] and [4,3])
    expect(pointInPolygonGeometry(centroid!, cShape)).toBe(false);
    expect(isCentroidInsideGeometry(cShape)).toBe(false);
  });

  test('handles MultiPolygon with disjoint components', () => {
    // Two separate squares
    const multi = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [10, 0],
            [11, 0],
            [11, 1],
            [10, 1],
            [10, 0],
          ],
        ],
      ],
    };

    const centroid = getPolygonCentroid(multi);
    expect(centroid).toBeDefined();
    // Centroid should be around [5.5, 0.5] (empty space between the two squares)
    expect(centroid![0]).toBeCloseTo(5.5, 1);
    expect(pointInPolygonGeometry(centroid!, multi)).toBe(false);
    expect(isCentroidInsideGeometry(multi)).toBe(false);
  });

  test('handles polygons with holes', () => {
    // Square with a central hole
    const donut = {
      type: 'Polygon',
      coordinates: [
        // Outer ring
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        // Hole
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
          [1, 1],
        ],
      ],
    };

    // Point in hole is not in polygon
    expect(pointInPolygonGeometry([2, 2], donut)).toBe(false);
    // Point in body is in polygon
    expect(pointInPolygonGeometry([0.5, 0.5], donut)).toBe(true);
  });
});
