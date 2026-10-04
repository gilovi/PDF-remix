// Copies pdf.js runtime data (fonts, cmaps, wasm decoders, ICC profiles) into
// public/ so they are served from our own origin — no CDN requests, ever.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(process.cwd(), 'public', 'pdfjs');

mkdirSync(target, { recursive: true });
for (const dir of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  cpSync(join(pdfjsRoot, dir), join(target, dir), { recursive: true });
}
console.log(`pdf.js assets copied to ${target}`);
