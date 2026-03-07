let StorageClass: any = null;
let storageInstance: any = null;

export async function getStorageClient() {
  if (!storageInstance) {
    if (Deno.env.get("DENO_ENV") === "test") {
      storageInstance = {
        bucket: () => ({
          file: () => ({
            exists: async () => [false],
            download: async () => [new Uint8Array()],
            save: async () => {},
          }),
        }),
      };
      return storageInstance;
    }
    const storageModule = await import("@google-cloud/storage");
    StorageClass = storageModule.Storage;
    storageInstance = new StorageClass();
  }
  return storageInstance;
}

/**
 * Retrieves a JSON object from the cache bucket.
 * @param bucketName The name of the GCS bucket.
 * @param key The cache key / file path.
 * @returns Parsed JSON data or null if the file does not exist.
 */
export async function getFromCache(
  bucketName: string,
  key: string,
): Promise<any | null> {
  if (!bucketName) {
    return null;
  }

  try {
    const storage = await getStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(key);

    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }

    const [contents] = await file.download();
    return JSON.parse(contents.toString("utf-8"));
  } catch (error) {
    console.error(`Failed to read from cache (${key}):`, error);
    return null; // Fail gracefully so we just fetch from source
  }
}

/**
 * Saves a JSON object to the cache bucket.
 * @param bucketName The name of the GCS bucket.
 * @param key The cache key / file path.
 * @param data The JSON data to cache.
 */
export async function saveToCache(
  bucketName: string,
  key: string,
  data: any,
): Promise<void> {
  if (!bucketName) {
    return; // caching disabled if no bucket
  }

  try {
    const storage = await getStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(key);

    const contents = JSON.stringify(data);
    await file.save(contents, {
      contentType: "application/json",
      resumable: false,
    } as any);

    console.log(`Successfully saved to cache: ${key}`);
  } catch (error) {
    console.error(`Failed to save to cache (${key}):`, error);
    // Fail gracefully
  }
}
