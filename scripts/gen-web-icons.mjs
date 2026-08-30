// gen-web-icons.mjs — produce PWA web icons (192/512) from the placeholder art.
// Run: node scripts/gen-web-icons.mjs
import sharp from 'sharp';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'assets', 'icon-only.png');
const outDir = resolve(root, 'icons');
mkdirSync(outDir, { recursive: true });

if (!existsSync(src)) {
  console.error('Source art missing: run `node scripts/gen-assets.mjs` first.');
  process.exit(1);
}

for (const size of [192, 512]) {
  await sharp(src).resize(size, size).png().toFile(resolve(outDir, `icon-${size}.png`));
  console.log(`  + icons/icon-${size}.png`);
}
console.log('Web icons generated.');
