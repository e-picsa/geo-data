/**
 * Pretty-prints a TopoJSON object with compact serializations for:
 *   - the top-level `arcs` array (placed at the end, one arc per line)
 *   - every nested `arcs` field (collapsed inline)
 *   - every `coordinates` field (collapsed inline)
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

  const shouldCompact = (key: string, value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    if (key === 'arcs') return true;
    if (key === 'coordinates') return true;
    return false;
  };

  const replacer = (key: string, value: unknown) => {
    if (shouldCompact(key, value)) {
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
