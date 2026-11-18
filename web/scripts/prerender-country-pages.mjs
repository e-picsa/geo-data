/**
 * GitHub Pages has no SPA rewrite support: a direct visit to `/MW` looks for
 * `/MW` or `/MW/index.html` and otherwise serves a 404.
 *
 * The app routes on the first path segment (`getCountryCodeFromUrl` accepts any
 * two-letter code), so we pre-render a static copy of the built `index.html`
 * for every possible code. Each copy boots the same SPA, which then reads the
 * country from `window.location.pathname` as usual.
 *
 * A `404.html` copy is also written as a catch-all (lowercase URLs, typos,
 * future codes) — Pages serves it for any unmatched path.
 *
 * Runs after `vite build` (see `build` script in `web/package.json`).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, '..', 'dist');
const index = join(dist, 'index.html');

let count = 0;
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a) + String.fromCharCode(b);
    const dir = join(dist, code);
    mkdirSync(dir, { recursive: true });
    copyFileSync(index, join(dir, 'index.html'));
    count++;
  }
}

// Catch-all for anything else (e.g. `/mw`, typos).
copyFileSync(index, join(dist, '404.html'));

console.log(`Prerendered ${count} country pages + 404.html`);
