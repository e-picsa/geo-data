import { getAuthHeaders } from './google-auth.ts';
import type { CacheProvider } from './cache.ts';

export class GCSCacheProvider implements CacheProvider {
  private bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const headers = await getAuthHeaders();
      const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucketName)}/o/${encodeURIComponent(key)}?alt=media`;

      const res = await fetch(url, { headers });

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`GCS GET failed: ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as T;
    } catch (error) {
      console.error(`Failed to read from GCS cache (${key}):`, error);
      return null;
    }
  }

  async set(key: string, data: any): Promise<void> {
    try {
      const headers = await getAuthHeaders();
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucketName)}/o?uploadType=media&name=${encodeURIComponent(key)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        throw new Error(`GCS PUT failed: ${res.status} ${res.statusText}`);
      }

      console.log(`Successfully saved to GCS cache: ${key}`);
    } catch (error) {
      console.error(`Failed to save to GCS cache (${key}):`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      console.log(`Starting clear operation for GCS bucket ${this.bucketName}...`);
      let nextPageToken: string | null = null;
      const headers = await getAuthHeaders();
      let deletedCount = 0;

      do {
        let listUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucketName)}/o`;
        if (nextPageToken) listUrl += `?pageToken=${encodeURIComponent(nextPageToken)}`;

        const listRes = await fetch(listUrl, { headers });
        if (!listRes.ok) throw new Error(`GCS LIST failed: ${listRes.status}`);

        const listData = (await listRes.json()) as any;
        const items = listData.items || [];

        const BATCH_SIZE = 100; // A reasonable batch size to avoid rate limits.
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map(async (item: any) => {
              const delUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucketName)}/o/${encodeURIComponent(item.name)}`;
              const delRes = await fetch(delUrl, { method: 'DELETE', headers });
              if (!delRes.ok) console.error(`Failed to delete ${item.name}`);
              else deletedCount++;
            }),
          );
        }

        nextPageToken = listData.nextPageToken || null;
      } while (nextPageToken);

      console.log(
        `Successfully deleted ${deletedCount} objects from GCS bucket ${this.bucketName}`,
      );
    } catch (error) {
      console.error(`Failed to clear GCS cache bucket ${this.bucketName}:`, error);
      throw error;
    }
  }
}
