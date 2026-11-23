import fs from 'node:fs/promises';
import path from 'node:path';
import { getAuthHeaders } from '../utils/google-auth.ts';
import { PMTILES_DIR } from './pmtiles.ts';

/**
 * GCS backing for finished PMTiles packs (binary-safe, unlike the JSON-only
 * CacheProvider used for boundary TopoJSON).
 *
 * Local disk stays primary: exports write through to `pmtiles/<file>`, and
 * reads fall back to GCS on a cold instance (downloading into local disk, so
 * the local cache self-heals). Without CACHE_BUCKET everything is local-only.
 */

export const PMTILES_GCS_PREFIX = 'pmtiles/';

export function isGcsPmtilesEnabled(): boolean {
  const bucket = process.env.CACHE_BUCKET;
  return !!bucket && bucket.trim().length > 0;
}

function bucketName(): string {
  return process.env.CACHE_BUCKET!.trim();
}

function objectUrl(key: string, forUpload = false): string {
  const base = forUpload
    ? 'https://storage.googleapis.com/upload/storage/v1/b'
    : 'https://storage.googleapis.com/storage/v1/b';
  const suffix = forUpload
    ? `/o?uploadType=media&name=${encodeURIComponent(key)}`
    : `/o/${encodeURIComponent(key)}?alt=media`;
  return `${base}/${encodeURIComponent(bucketName())}${suffix}`;
}

/** Upload a finished pack + manifest; never throws (export must not fail on it). */
export async function uploadPmtilesToGcs(fileName: string): Promise<boolean> {
  if (!isGcsPmtilesEnabled()) return false;
  try {
    const headers = await getAuthHeaders();
    const pairs: [string, string][] = [
      [fileName, 'application/octet-stream'],
      [manifestNameFor(fileName), 'application/json'],
    ];
    for (const [key, contentType] of pairs) {
      const localPath = path.join(PMTILES_DIR, key);
      let body: Uint8Array;
      try {
        body = new Uint8Array(await fs.readFile(localPath));
      } catch {
        console.warn(`GCS pmtiles upload skipped (missing local file): ${key}`);
        return false;
      }
      const res = await fetch(objectUrl(PMTILES_GCS_PREFIX + key, true), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType },
        body,
      });
      if (!res.ok) throw new Error(`GCS PUT failed: ${res.status} ${res.statusText}`);
    }
    console.log(`PMTiles uploaded to GCS: ${PMTILES_GCS_PREFIX + fileName} (+manifest)`);
    return true;
  } catch (err) {
    console.error(`GCS pmtiles upload failed (${fileName}):`, err);
    return false;
  }
}

export function manifestNameFor(fileName: string): string {
  return fileName.replace(/\.pmtiles$/, '') + '.manifest.json';
}

/** Download a pack or manifest from GCS into local disk; null when absent. */
export async function downloadPmtilesFromGcs(key: string): Promise<number | null> {
  if (!isGcsPmtilesEnabled()) return null;
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(objectUrl(PMTILES_GCS_PREFIX + key), { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GCS GET failed: ${res.status} ${res.statusText}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const dest = path.join(PMTILES_DIR, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    return buf.length;
  } catch (err) {
    console.error(`GCS pmtiles download failed (${key}):`, err);
    return null;
  }
}

/** Byte-range fetch straight from GCS (used only when local disk lacks the file). */
export async function fetchPmtilesRangeFromGcs(
  key: string,
  start: number,
  end: number,
): Promise<{ status: number; body: Uint8Array; contentRange: string; size: number } | null> {
  if (!isGcsPmtilesEnabled()) return null;
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(objectUrl(PMTILES_GCS_PREFIX + key), {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
    });
    if (res.status === 404) return null;
    if (res.status !== 206 && !res.ok) {
      throw new Error(`GCS range GET failed: ${res.status} ${res.statusText}`);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const contentRange =
      res.headers.get('Content-Range') ?? `bytes ${start}-${start + body.length - 1}/*`;
    const size = parseInt(res.headers.get('X-Goog-Stored-Content-Length') ?? '', 10);
    return {
      status: res.status,
      body,
      contentRange,
      size: Number.isFinite(size) ? size : start + body.length,
    };
  } catch (err) {
    console.error(`GCS pmtiles range fetch failed (${key}):`, err);
    return null;
  }
}

export interface GcsPmtilesEntry {
  key: string;
  size: number;
  updated: string;
}

/** List pack objects under the pmtiles/ prefix (bounded page walk). */
export async function listGcsPmtiles(): Promise<GcsPmtilesEntry[]> {
  if (!isGcsPmtilesEnabled()) return [];
  try {
    const headers = await getAuthHeaders();
    const out: GcsPmtilesEntry[] = [];
    let pageToken: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      let url =
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName())}` +
        `/o?prefix=${encodeURIComponent(PMTILES_GCS_PREFIX)}&fields=items(name,size,updated),nextPageToken`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GCS LIST failed: ${res.status}`);
      const data = (await res.json()) as any;
      for (const item of data.items ?? []) {
        out.push({
          key: String(item.name).slice(PMTILES_GCS_PREFIX.length),
          size: Number(item.size ?? 0),
          updated: String(item.updated ?? ''),
        });
      }
      pageToken = data.nextPageToken ?? null;
      if (!pageToken) break;
    }
    return out;
  } catch (err) {
    console.error('GCS pmtiles list failed:', err);
    return [];
  }
}
