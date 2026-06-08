import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'NotebookLM Mega Uploader',
    description:
      'Upload large PDF, text, video, and Markdown files to NotebookLM. Local compress/split for video over 200MB.',
    permissions: ['cookies', 'storage', 'sidePanel', 'tabs'],
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
