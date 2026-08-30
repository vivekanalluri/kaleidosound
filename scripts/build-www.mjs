// build-www.mjs — assemble the Capacitor web directory.
//
// Capacitor copies a single "webDir" into each native app. We keep the source
// files at the project root (so the dev server and editing stay simple) and
// this script gathers just the shippable web assets into ./www, which is what
// capacitor.config.json points at. Run via `npm run build`.

import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
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

console.log(`Built ${out}`);
