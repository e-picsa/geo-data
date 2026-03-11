import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import sharp from 'sharp';
import { getTilesForBbox } from '../utils/tiles.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getBboxForCountry } from './overpass.ts';

const TILES_DIR = path.join(process.cwd(), '.cache', 'tiles');

/** Hard limit — never generate tiles above this zoom level. */
const MAX_ZOOM = 8;

interface ExportTilesParams {
  country_code: string;
  minZoom: number;
  maxZoom: number;
}

export async function exportTiles(
  params: ExportTilesParams,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const { country_code, minZoom } = params;

  const maxZoom = Math.min(params.maxZoom, MAX_ZOOM);

  // Derive bbox from country boundary (admin_level 2)
  console.log(`Looking up bounding box for ${country_code}...`);
  const [minLon, minLat, maxLon, maxLat] = await getBboxForCountry(country_code, signal);
  console.log(`Bounding box for ${country_code}: [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`);

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
            signal,
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
  return new ReadableStream({
    start(controller) {
      console.log(`Creating tar.gz archive for ${country_code}...`);

      const tarStream = tar.c(
        {
          gzip: true,
          cwd: countryDir,
        },
        ['.'],
      );

      tarStream.on('data', (data) => {
        controller.enqueue(new Uint8Array(data));
      });

      tarStream.on('end', () => {
        console.log(`Tar archive created successfully for ${country_code}`);
        controller.close();
      });

      tarStream.on('error', (err) => {
        controller.error(err);
      });
    },
  });
}
