import type { CacheProvider } from './cache.types.ts';

export class NoOpCacheProvider implements CacheProvider {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  }
  async set(_key: string, _data: any): Promise<void> {}
  async clear(): Promise<void> {}
  async clearPrefix(_prefix: string): Promise<void> {}
}
