import type { CacheProvider } from './cache.types.ts';
import { GCSCacheProvider } from './google-storage.ts';
import { LocalCacheProvider } from './local-storage.ts';
import { NoOpCacheProvider } from './noop.provider.ts';

let cacheInstance: CacheProvider;

export function getCache(): CacheProvider {
  if (cacheInstance) return cacheInstance;

  const provider = process.env.CACHE_PROVIDER || (process.env.CACHE_BUCKET ? 'gcs' : 'local');

  if (provider === 'local') {
    const dir = process.env.LOCAL_CACHE_DIR || './.cache';
    cacheInstance = new LocalCacheProvider(dir);
    console.log(`Initialized local cache provider at ${dir}`);
  } else if (provider === 'gcs') {
    const bucket = process.env.CACHE_BUCKET;
    if (bucket && bucket.trim().length > 0) {
      cacheInstance = new GCSCacheProvider(bucket);
      console.log(`Initialized GCS cache provider for bucket ${bucket}`);
    } else {
      cacheInstance = new NoOpCacheProvider();
      console.log('No cache provider initialized (bucket missing)');
    }
  } else {
    cacheInstance = new NoOpCacheProvider();
    console.warn(`Unknown cache provider: ${provider}, using NoOp cache.`);
  }

  return cacheInstance;
}
