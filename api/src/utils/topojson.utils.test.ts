import { expect, test } from 'bun:test';
import { stringifyTopojsonReadable, stripCentersFromTopojson } from './topojson.utils.ts';

const topo = {
  type: 'Topology',
  bbox: [32.668, -17.129, 35.92, -9.364],
  transform: { scale: [0.001, 0.001], translate: [32.0, -18.0] },
  custom_layers: [
    {
      id: 'mw_epa',
      citation: { sourceName: 'MASDAP' },
    },
  ],
  objects: {
    input: {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'MultiPolygon',
          properties: { name: 'Dowa', center: [33.79, -13.59] },
          arcs: [[[0, 1]], [[2, 3]]],
        },
      ],
    },
  },
  arcs: [[[0, 0]], [[5, 5]]],
};

test('stringifyTopojsonReadable - value arrays are single-line except top-level arcs', () => {
  const text = stringifyTopojsonReadable(topo as any);
  // Still valid JSON with the same content
  expect(JSON.parse(text)).toEqual(topo);

  const lines = text.split('\n');
  const lineFor = (needle: string) => lines.find((l) => l.includes(needle));

  // bbox, transform members and center points stay inline
  expect(lineFor('"bbox"')).toContain('[32.668,-17.129,35.92,-9.364]');
  expect(lineFor('"scale"')).toContain('[0.001,0.001]');
  expect(lineFor('"translate"')).toContain('[32,-18]');
  expect(lineFor('"center"')).toContain('[33.79,-13.59]');

  // Arrays of objects stay expanded for readability
  expect(lineFor('"geometries"')).toContain('[');
  expect(lineFor('"custom_layers"')).toContain('[');
  expect(text).toContain('"id": "mw_epa"');

  // Nested geometry arcs collapse inline…
  expect(lineFor('"arcs": [[[0,1]],[[2,3]]]')).toBeDefined();

  // …while each top-level arc gets its own line
  expect(text).toContain('"arcs": [\n    [[0,0]],\n    [[5,5]]\n  ]');
});

test('stringifyTopojsonReadable - preserves key order and survives center stripping', () => {
  const text = stringifyTopojsonReadable(topo as any);
  expect(text.indexOf('"custom_layers"')).toBeLessThan(text.indexOf('"objects"'));
  expect(text.indexOf('"objects"')).toBeLessThan(text.indexOf('"arcs": ['));

  const stripped = stripCentersFromTopojson(JSON.parse(text));
  expect(JSON.parse(stringifyTopojsonReadable(stripped))).toEqual({
    ...topo,
    objects: {
      input: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', properties: { name: 'Dowa' }, arcs: [[[0, 1]], [[2, 3]]] },
        ],
      },
    },
  });
});
