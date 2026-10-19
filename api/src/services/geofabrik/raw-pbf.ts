import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchWithRetry } from '../../utils/fetch.ts';
import { PREWARM_COUNTRIES, getGeofabrikUrl } from './url-mapping.ts';
import { BoundaryError } from '../boundary-errors.ts';

const MIN_VALID_PBF_BYTES = 50_000;

// PBF files can be 1GB+. Cloud Run ephemeral storage (/tmp) supports up to 10GiB
// by default. On Cloud Run, PBF cache is written to /tmp/.cache. On local dev,
// falls back to LOCAL_CACHE_DIR env var or ./cache relative to cwd.
// This is separate from getCache() — which caches TopoJSON results in GCS.
const isCloudRun = !!(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
const cacheDir = isCloudRun ? '/tmp/.cache' : (process.env.LOCAL_CACHE_DIR ?? './.cache');

export function rawPbfPath(countryCode: string, cacheVersion: number): string {
  return `${cacheDir}/geofabrik/v${cacheVersion}/raw/${countryCode}.pbf`;
}

export async function ensureRawPbf(
  countryCode: string,
  cacheVersion: number,
  signal: AbortSignal,
): Promise<string> {
  const pbfPath = rawPbfPath(countryCode, cacheVersion);
  const file = Bun.file(pbfPath);

  if (await file.exists()) {
    const size = file.size;
    if (size > MIN_VALID_PBF_BYTES) {
      console.log(`Using cached PBF for ${countryCode} (${size} bytes)`);
      return pbfPath;
    }
    console.warn(`Cached PBF for ${countryCode} is anomalously small (${size} bytes). Purging.`);
  }

  const url = getGeofabrikUrl(countryCode);
  if (!url) {
    throw new BoundaryError(
      'COUNTRY_NOT_SUPPORTED',
      `No boundary data source for country code "${countryCode}" (no Geofabrik extract configured). Instantly available: ${PREWARM_COUNTRIES.join(', ')}.`,
      404,
      false,
    );
  }

  console.log(`Downloading PBF from Geofabrik for ${countryCode}...`);
  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) {
    if (response.status === 504) {
      throw new BoundaryError(
        'GENERATION_TIMEOUT',
        `Boundary source for "${countryCode}" timed out (upstream HTTP 504). First-time generation can take several minutes — please retry shortly.`,
        504,
        true,
      );
    }
    throw new BoundaryError(
      'UPSTREAM_UNAVAILABLE',
      `Boundary source download failed for "${countryCode}" (upstream HTTP ${response.status}). Please retry in a few minutes.`,
      502,
      true,
    );
  }

  await mkdir(dirname(pbfPath), { recursive: true });
  await Bun.write(pbfPath, response);

  return pbfPath;
}
