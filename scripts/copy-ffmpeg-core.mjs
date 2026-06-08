import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const destDir = join(root, 'public', 'ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

await mkdir(destDir, { recursive: true });
for (const file of files) {
  await copyFile(join(srcDir, file), join(destDir, file));
}
console.log('Copied FFmpeg core to public/ffmpeg/');
