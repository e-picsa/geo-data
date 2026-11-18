/**
 * GitHub Pages has no SPA rewrite support: a direct visit to `/MW` looks for
 * `/MW` or `/MW/index.html` and otherwise serves a 404.
 *
 * The supported country codes live in a single masterlist
 * (`api/src/services/geofabrik/url-mapping.ts`, `GEOFABRIK_COUNTRIES`) — the
 * only codes the API can actually serve, and therefore the only deep links
 * worth a real `200`. We pre-render a static copy of the built `index.html`
 * for each of them. Each copy boots the same SPA, which then reads the
 * country from `window.location.pathname` as usual.
 *
 * A `404.html` copy is also written as a catch-all (unsupported codes,
 * lowercase URLs, typos, future codes) — Pages serves it for any unmatched
 * path, and the app still boots from it.
 *
 * Runs after `vite build` (see `build` script in `web/package.json`).
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, '..', 'dist');
const index = join(dist, 'index.html');

// Single source of truth — parse the keys out of `GEOFABRIK_COUNTRIES` so the
// prerendered set can never drift from what the API supports.
const mapping = readFileSync(
  join(root, '..', '..', 'api', 'src', 'services', 'geofabrik', 'url-mapping.ts'),
  'utf8',
);
const codes = [...mapping.matchAll(/^\s*([A-Z]{2}):\s*\{/gm)].map((m) => m[1]);
if (codes.length === 0) {
  throw new Error('No country codes found in url-mapping.ts — prerender aborted');
}

for (const code of codes) {
  const dir = join(dist, code);
  mkdirSync(dir, { recursive: true });
  copyFileSync(index, join(dir, 'index.html'));
}

// Catch-all for anything else (unsupported codes, `/mw`, typos).
copyFileSync(index, join(dist, '404.html'));

console.log(`Prerendered ${codes.length} country pages + 404.html`);
