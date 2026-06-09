import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

/** Set WXT_OPEN_BROWSER=1 to let WXT launch its own Chrome (separate profile — sign in once in .wxt/chrome-data). */
const openDevBrowser = process.env.WXT_OPEN_BROWSER === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  runner: {
    // Default: do not auto-open Chrome — load the extension in your real profile (where Gmail is signed in).
    disabled: !openDevBrowser,
    chromiumProfile: resolve('.wxt/chrome-data'),
    keepProfileChanges: true,
    chromiumArgs: ['--exclude-switches=enable-automation'],
    startUrls: ['https://notebooklm.google.com/'],
  },
  vite: () => ({
    // @ffmpeg/ffmpeg spawns a module worker via import.meta.url — Vite's dep optimizer breaks that path.
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    worker: {
      format: 'es',
    },
  }),
  manifest: {
    name: 'NotebookLM Mega Uploader',
    description:
      'Upload large PDF, text, video, and Markdown files to NotebookLM. Local compress/split for video over 200MB.',
    permissions: ['cookies', 'storage', 'sidePanel', 'tabs', 'scripting'],
    host_permissions: [
      'https://notebooklm.google.com/*',
      'https://*.google.com/*',
    ],
    action: {
      default_title: 'NotebookLM Mega Uploader',
    },
    web_accessible_resources: [
      {
        resources: ['ffmpeg/*'],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
