/**
 * Warm the derived boundary cache for the small subset of countries that
 * actually gets used (see PREWARM_COUNTRIES).
 *
 * Executed by the `prewarm-boundaries` CI workflow, which triggers on pushes
 * to main that change the boundary pipeline (extraction, conversion, cache
 * I/O, dependencies). It checks out the same commit it warms, so the cache
 * keys it writes are exactly the ones the newly deployed Cloud Run revision
 * reads (no rollout-timing dependency, no request timeouts: it writes to GCS
 * directly rather than going through HTTP).
 *
 * Must run with cwd=api so the throwaway local PBF workspace lands in
 * api/.cache (GCS holds the persistent warmed output via CACHE_BUCKET).
 */
import { getBoundariesTopojson } from '../src/services/admin-boundaries.ts';
import { PREWARM_COUNTRIES } from '../src/services/geofabrik/url-mapping.ts';

const failures: string[] = [];

for (const countryCode of PREWARM_COUNTRIES) {
  try {
    console.log(`Prewarming boundaries for ${countryCode}...`);
    const { source } = await getBoundariesTopojson(countryCode);
    console.log(`  ${countryCode}: ${source}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${countryCode} FAILED: ${message}`);
    failures.push(countryCode);
  }
}

if (failures.length > 0) {
  console.error(`Prewarm incomplete, failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log(`Prewarm complete for: ${PREWARM_COUNTRIES.join(', ')}`);
