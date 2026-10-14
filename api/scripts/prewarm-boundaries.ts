/**
 * Warm the derived boundary cache for the small subset of countries that
 * actually gets used (see PREWARM_COUNTRIES).
 *
 * Run after deploy or cache-version bumps so end users never pay
 * first-generation cost (PBF download + extract + Mapshaper, minutes):
 *
 *   cd api && bun run prewarm
 *
 * Writes through getCache(), so it warms GCS when CACHE_BUCKET is set and
 * the local .cache dir otherwise. Must run with cwd=api so the local cache
 * lands where the dev server reads it.
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
