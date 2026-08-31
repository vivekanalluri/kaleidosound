// build-www.mjs — assemble the Capacitor / Pages web directory.
//
// Copies the shippable web assets into ./www, then applies a build version to
// the entry script, stylesheet, and every local JS import so browsers/CDNs
// always fetch fresh files after a deploy (no more stale-cache surprises).
// Run via `npm run build`.

import {
  rmSync, mkdirSync, cpSync, existsSync,
  readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

// Everything the running app needs at runtime (no node_modules, no tooling).
const ASSETS = ['index.html', 'styles.css', 'js', 'vendor', 'manifest.webmanifest', 'icons'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const item of ASSETS) {
  const src = join(root, item);
  if (!existsSync(src)) {
    console.error(`  ! missing asset: ${item}`);
    process.exitCode = 1;
    continue;
  }
  cpSync(src, join(out, item), { recursive: true });
  console.log(`  + ${item}`);
}

// ---- Cache-busting -------------------------------------------------------
// A per-build version string appended as ?v=<version> to the entry script,
// the stylesheet, and all local ES-module imports.
const VERSION = Date.now().toString(36);

const indexPath = join(out, 'index.html');
if (existsSync(indexPath)) {
  let html = readFileSync(indexPath, 'utf8');
  html = html.replace(/(src="js\/main\.js)"/g, `$1?v=${VERSION}"`);
  html = html.replace(/(href="styles\.css)"/g, `$1?v=${VERSION}"`);
  writeFileSync(indexPath, html);
}

// Append the version to every relative `.js` import specifier so the whole
// module graph is revalidated, not just the entry file.
function versionJsImports(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) versionJsImports(p);
    else if (p.endsWith('.js')) {
      const code = readFileSync(p, 'utf8');
      const next = code.replace(
        /(from\s+['"]\.\/[^'"]+?\.js)(['"])/g,
        `$1?v=${VERSION}$2`
      );
      if (next !== code) writeFileSync(p, next);
    }
  }
}
versionJsImports(join(out, 'js'));

console.log(`Built ${out} (cache-bust v=${VERSION})`);
