import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { getTilesForBbox } from '../utils/tiles.ts';
import { fetchWithRetry } from '../utils/fetch.ts';

const TILES_DIR = path.join(process.cwd(), '.cache', 'tiles');

interface ExportTilesParams {
  country_code: string;
  bbox: number[]; // [minLon, minLat, maxLon, maxLat]
  minZoom: number;
  maxZoom: number;
}

export async function exportTiles(params: ExportTilesParams): Promise<Buffer> {
  const { country_code, bbox, minZoom, maxZoom } = params;
  const minLon = bbox[0];
  const minLat = bbox[1];
  const maxLon = bbox[2];
  const maxLat = bbox[3];

  // Generate all required tiles
  const requiredTiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    requiredTiles.push(...getTilesForBbox(minLon, minLat, maxLon, maxLat, z));
  }

  console.log(`Need to fetch/convert ${requiredTiles.length} tiles for ${country_code}...`);

  // Ensure directories exist
  await fs.mkdir(TILES_DIR, { recursive: true });

  const countryDir = path.join(TILES_DIR, country_code);

  // Throttle fetching slightly to avoid upsetting OSM
  // We'll process in chunks of 5 parallel requests
  const CHUNK_SIZE = 5;
  for (let i = 0; i < requiredTiles.length; i += CHUNK_SIZE) {
    const chunk = requiredTiles.slice(i, i + CHUNK_SIZE);

    await Promise.all(
      chunk.map(async ({ x, y, z }) => {
        const tilePath = path.join(countryDir, z.toString(), x.toString(), `${y}.webp`);

        // Check if it already exists
        try {
          await fs.access(tilePath);
          return; // tile is already cached
        } catch {
          // file doesn't exist, proceed to fetch
        }

        await fs.mkdir(path.dirname(tilePath), { recursive: true });

        // Fetch from OSM
        // url formatting: https://tile.openstreetmap.org/{z}/{x}/{y}.png
        const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
        const res = await fetchWithRetry(
          url,
          {
            headers: {
              'User-Agent':
                'GeoBoundariesTopoJSON/1.0 (https://github.com/chris/geo-boundaries-topojson)',
            },
          },
          5,
          1000,
        );

        if (!res.ok) {
          console.warn(`Failed to fetch tile ${z}/${x}/${y}: ${res.statusText}`);
          return; // ignore failed tiles
        }

        const buffer = Buffer.from(await res.arrayBuffer());

        // Convert to webp using sharp
        const webpBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();

        // Write to disk
        await fs.writeFile(tilePath, webpBuffer);
      }),
    );

    // Tiny delay between chunks to respect OSM policy
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Now tar the directory
  return new Promise((resolve, reject) => {
    console.log(`Creating tar.gz archive for ${country_code}...`);
    // Create archive of the countryDir, but cd into it so the root of the tar is the zoom levels
    const child = spawn('tar', ['-czf', '-', '-C', countryDir, '.']);

    const chunks: Buffer[] = [];
    child.stdout.on('data', (data) => chunks.push(Buffer.from(data)));

    child.stderr.on('data', (data) => {
      console.warn('tar stderr:', data.toString());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar process exited with code ${code}`));
      } else {
        console.log(`Tar archive created successfully for ${country_code}`);
        resolve(Buffer.concat(chunks));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
