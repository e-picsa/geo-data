/**
 * Pretty-prints a TopoJSON object, collapsing every value array (bbox,
 * transform scale/translate, per-geometry arcs, center points, ...) onto a
 * single line inline — except the top-level `arcs` array, which is placed at
 * the end with one arc per line. Arrays of objects (e.g. `geometries`,
 * `custom_layers`) stay expanded so the file remains readable.
 *
 * Produces valid JSON.
 */
export function stringifyTopojsonReadable(topo: Record<string, unknown>): string {
  if (!topo || typeof topo !== 'object') {
    return JSON.stringify(topo, null, 2);
  }

  const { arcs: topArcs, ...rest } = topo;

  const placeholders: string[] = [];
  const PLACEHOLDER_PREFIX = '__COMPACT_PLACEHOLDER_';
  const PLACEHOLDER_SUFFIX = '__';

  const isPlainObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const replacer = (_key: string, value: unknown) => {
    if (Array.isArray(value) && !value.some(isPlainObject)) {
      const idx = placeholders.length;
      placeholders.push(JSON.stringify(value));
      return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
    }
    return value;
  };

  let prettyRest = JSON.stringify(rest, replacer, 2);

  prettyRest = prettyRest.replace(
    new RegExp(`"${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}"`, 'g'),
    (match, idxStr) => {
      const idx = Number(idxStr);
      return placeholders[idx] ?? match;
    },
  );

  // Top-level arcs: one arc per line.
  const arcsBlock =
    Array.isArray(topArcs) && topArcs.length > 0
      ? '[\n' + topArcs.map((a: any) => '    ' + JSON.stringify(a)).join(',\n') + '\n  ]'
      : '[]';

  const trimmed = prettyRest.replace(/\}\s*$/, '').trimEnd();
  const sep = trimmed.endsWith('{') ? '' : ',';

  return `${trimmed}${sep}\n  "arcs": ${arcsBlock}\n}\n`;
}

/**
 * Removes `center` and `center_source` from geometry properties in all TopoJSON objects.
 */
export function stripCentersFromTopojson(topo: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(topo));
  for (const objKey of Object.keys(cloned.objects || {})) {
    const obj = cloned.objects[objKey] as Record<string, unknown> | undefined;
    if (obj?.geometries && Array.isArray(obj.geometries)) {
      for (const geom of obj.geometries) {
        if (geom?.properties) {
          delete geom.properties.center;
          delete geom.properties.center_source;
        }
      }
    }
  }
  return cloned;
}

type TopojsonSummary = {
  size_kb: number;
  feature_count: number;
  bbox: unknown[];
};

export function summarizeTopojson(topojson: Record<string, unknown>): TopojsonSummary {
  const topojsonString = JSON.stringify(topojson);
  const bytes = new TextEncoder().encode(topojsonString).length;
  const size_kb = Math.round(bytes / 1024);

  const feature_count = Object.values(topojson.objects || {}).reduce(
    (sum: number, obj: Record<string, unknown>) => {
      if (Array.isArray(obj?.geometries)) {
        return sum + obj.geometries.length;
      }
      if (obj?.type) {
        return sum + 1;
      }
      return sum;
    },
    0,
  );

  const bbox = Array.isArray(topojson.bbox) ? topojson.bbox : [];

  return {
    size_kb,
    feature_count,
    bbox,
  };
}
