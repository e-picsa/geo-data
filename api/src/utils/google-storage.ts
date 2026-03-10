import { getAuthHeaders } from "./google-auth.ts";




/**
 * Retrieves a JSON object from the cache bucket.
 */
export async function getFromCache(
  bucketName: string,
  key: string,
): Promise<any | null> {
  if (!bucketName) return null;

  try {
    const headers = await getAuthHeaders();
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(key)}?alt=media`;

    const res = await fetch(url, { headers });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GCS GET failed: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } catch (error) {
    console.error(`Failed to read from cache (${key}):`, error);
    return null;
  }
}

/**
 * Saves a JSON object to the cache bucket.
 */
export async function saveToCache(
  bucketName: string,
  key: string,
  data: any,
): Promise<void> {
  if (!bucketName) return;

  try {
    const headers = await getAuthHeaders();
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=media&name=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      throw new Error(`GCS PUT failed: ${res.status} ${res.statusText}`);
    }

    console.log(`Successfully saved to cache: ${key}`);
  } catch (error) {
    console.error(`Failed to save to cache (${key}):`, error);
  }
}