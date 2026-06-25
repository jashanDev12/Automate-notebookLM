import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreSrcDir = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const workerSrc = join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'worker.js');
const destDir = join(root, 'public', 'ffmpeg');

const coreFiles = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

await mkdir(destDir, { recursive: true });
for (const file of coreFiles) {
  await copyFile(join(coreSrcDir, file), join(destDir, file));
}

// Bundle the FFmpeg class worker (inlines its ./const.js + ./errors.js imports) so it
// can be served directly from the extension (chrome-extension://.../ffmpeg/ffmpeg-worker.js)
// instead of the WXT dev server (http://localhost:3000). This keeps video prep working
// even when the dev server is stopped.
await build({
  entryPoints: [workerSrc],
  outfile: join(destDir, 'ffmpeg-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
});

console.log('Copied FFmpeg core + bundled worker to public/ffmpeg/');
