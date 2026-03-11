import { GCSCacheProvider } from './google-storage.ts';
import { LocalCacheProvider } from './local-storage.ts';

export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set(key: string, data: any): Promise<void>;
  clear(): Promise<void>;
}

export class NoOpCacheProvider implements CacheProvider {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  }
  async set(_key: string, _data: any): Promise<void> {}
  async clear(): Promise<void> {}
}

let cacheInstance: CacheProvider;

export function getCache(): CacheProvider {
  if (cacheInstance) return cacheInstance;

  const provider =
    process.env.CACHE_PROVIDER || (process.env.OVERPASS_CACHE_BUCKET ? 'gcs' : 'local');

  if (provider === 'local') {
    const dir = process.env.LOCAL_CACHE_DIR || './.cache';
    cacheInstance = new LocalCacheProvider(dir);
    console.log(`Initialized local cache provider at ${dir}`);
  } else if (provider === 'gcs') {
    const bucket = process.env.OVERPASS_CACHE_BUCKET;
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
