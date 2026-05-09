import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchWithRetry } from '../../utils/fetch.ts';
import { getGeofabrikUrl } from './url-mapping.ts';

const MIN_VALID_PBF_BYTES = 50_000;

export function rawPbfPath(countryCode: string, cacheVersion: number): string {
  return `.cache/geofabrik/v${cacheVersion}/raw/${countryCode}.pbf`;
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
    throw new Error(`No Geofabrik URL for country code: ${countryCode}`);
  }

  console.log(`Downloading PBF from Geofabrik for ${countryCode}...`);
  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download PBF: HTTP ${response.status}`);
  }

  await mkdir(dirname(pbfPath), { recursive: true });
  await Bun.write(pbfPath, response);

  return pbfPath;
}
