#!/usr/bin/env node
/**
 * Liberty tile renderer sidecar (runs under Node.js, NOT Bun).
 *
 * Why a sidecar: `@maplibre/maplibre-gl-native` is a NAN-based native module
 * (V8 internals) and cannot be dlopen'd by the Bun runtime. The Bun API spawns
 * this script per export; it renders OpenFreeMap Liberty raster tiles via
 * MapLibre Native (vector tiles, fonts, sprites fetched remotely from
 * tiles.openfreemap.org) and writes `{z}/{x}/{y}.webp` files with sharp.
 *
 * Usage:
 *   node render-liberty-tiles.mjs --tiles tiles.json --out-dir <dir> [--quality 80]
 *
 * tiles.json: { "styleUrl": string, "tiles": [{ "x": number, "y": number, "z": number }] }
 * Emits a single JSON summary line on stdout on completion.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mbgl = require('@maplibre/maplibre-gl-native');
const sharp = require('sharp');

const TILE_SIZE = 256;

// Mercator-correct tile centers (half-tile offset in tile space).
// Mirrors tileCenterLon/tileCenterLat in ../utils/tiles.ts — kept duplicated
// so this script runs under plain Node with zero build step.
function tileCenterLon(x, z) {
  return ((x + 0.5) / Math.pow(2, z)) * 360 - 180;
}

function tileCenterLat(y, z) {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { tiles: tilesPath, outDir, quality = '80' } = parseArgs(process.argv);
  if (!tilesPath || !outDir) {
    console.error(
      'Usage: node render-liberty-tiles.mjs --tiles tiles.json --out-dir <dir> [--quality 80]',
    );
    process.exit(2);
  }
  const webpQuality = Math.max(1, Math.min(100, parseInt(quality, 10) || 80));
  const { styleUrl, tiles } = JSON.parse(readFileSync(tilesPath, 'utf8'));

  const styleRes = await fetch(styleUrl);
  if (!styleRes.ok) throw new Error(`Failed to fetch style ${styleUrl}: ${styleRes.status}`);
  const style = await styleRes.json();

  const map = new mbgl.Map({ ratio: 1 });
  map.load(style);

  const rendered = [];
  const failed = [];
  for (const { x, y, z } of tiles) {
    const tilePath = path.join(outDir, String(z), String(x), `${y}.webp`);
    try {
      const buffer = await new Promise((resolve, reject) => {
        map.render(
          {
            zoom: z,
            center: [tileCenterLon(x, z), tileCenterLat(y, z)],
            width: TILE_SIZE,
            height: TILE_SIZE,
          },
          (err, buf) => (err ? reject(err) : resolve(buf)),
        );
      });
      mkdirSync(path.dirname(tilePath), { recursive: true });
      await sharp(Buffer.from(buffer), {
        raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
      })
        .webp({ quality: webpQuality })
        .toFile(tilePath);
      rendered.push({ x, y, z });
    } catch (err) {
      console.error(`[renderer] failed tile ${z}/${x}/${y}: ${err?.message ?? err}`);
      failed.push({ x, y, z });
    }
  }
  map.release();

  console.log(JSON.stringify({ rendered: rendered.length, failed }));
}

main().catch((err) => {
  console.error(`[renderer] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
