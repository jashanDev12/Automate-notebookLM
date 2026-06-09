import { spawn } from 'node:child_process';

/** Launch WXT's isolated dev Chrome (sign into Google once — session persists in .wxt/chrome-data). */
const child = spawn('npx', ['wxt'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, WXT_OPEN_BROWSER: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
