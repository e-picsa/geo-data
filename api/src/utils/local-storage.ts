import fs from 'node:fs/promises';
import path from 'node:path';
import type { CacheProvider } from './cache.ts';

export class LocalCacheProvider implements CacheProvider {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(process.cwd(), baseDir);
  }

  private getFilePath(key: string): string {
    const targetPath = path.resolve(this.baseDir, key);
    const relative = path.relative(this.baseDir, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid cache key: path traversal detected');
    }
    return targetPath;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const filePath = this.getFilePath(key);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error(`Failed to read from local cache (${key}):`, err);
      }
      return null;
    }
  }

  async set(key: string, data: any): Promise<void> {
    try {
      const filePath = this.getFilePath(key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
      console.log(`Successfully saved to local cache: ${key}`);
    } catch (err) {
      console.error(`Failed to save to local cache (${key}):`, err);
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.baseDir, { recursive: true, force: true });
      console.log(`Successfully cleared local cache at ${this.baseDir}`);
    } catch (err) {
      console.error(`Failed to clear local cache at ${this.baseDir}:`, err);
    }
  }
}
