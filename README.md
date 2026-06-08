# NotebookLM Mega Uploader

A Manifest V3 Chrome extension built with [WXT](https://wxt.dev), React 18, and Tailwind CSS. Upload large local files (PDF, TXT, Markdown, MP4/video) to Google NotebookLM. Documents are byte-split under 200MB; oversized videos are **compressed** or **time-split** locally via FFmpeg.wasm before upload.

**Privacy:** All file splitting happens locally in your browser. The only network traffic goes to official `notebooklm.google.com` endpoints.

## Features

- **Session auth** — Uses your existing NotebookLM browser session via `chrome.cookies` (no separate login)
- **200MB chunking** — `Blob.slice()` splits oversized files as `OriginalName_Part1.pdf`, `Part2`, etc.
- **Sequential queue** — One chunk uploads at a time; Part 2 starts only after Part 1 succeeds
- **Resumable upload** — Implements Google's Scotty resumable-upload handshake (modeled on notebooklm-py)
- **RPC client** — TypeScript `batchexecute` client for `list_notebooks` and `add_source_file`

## Prerequisites

- Node.js 18+
- Google Chrome (or Chromium-based browser with extension support)
- Signed in at [notebooklm.google.com](https://notebooklm.google.com)

## Setup

```bash
cd notebooklm-mega-uploader
npm install          # runs `wxt prepare` via postinstall (optional; root tsconfig is self-contained)
npm run dev
```

Load the unpacked extension from `.output/chrome-mv3` (path shown in the WXT dev output).

> **Blank browser?** WXT opens Chrome with the extension loaded — it does **not** auto-open the UI. Click the **NotebookLM Mega Uploader** icon in the toolbar to open the **side panel**.

## Usage

1. Click the extension icon in the Chrome toolbar to open the **side panel**
2. Select a target notebook (fetched via RPC)
3. Drag & drop or browse for a PDF, TXT, or Markdown file
4. Click **Start Upload** — watch per-chunk progress bars

**Documents** over 200MB are byte-split locally (`_Part1`, `_Part2`, …).

**Videos** over 200MB: you are always asked to choose:
- **Split into parts** (fast, stream-copy by time — valid MP4 parts)
- **Compress to one file** (slower, single source under 200MB)

Source videos above 2GB are blocked; 1–2GB shows a warning.

## Build for production

```bash
npm run build
npm run zip
```

## Architecture

```
lib/
  auth.ts      # chrome.cookies + SNlM0e/FdrFJe token extraction
  rpc.ts       # batchexecute encode/decode + list_notebooks
  decoder.ts   # Response parsing (ported from notebooklm-py)
  upload.ts    # Resumable upload handshake + finalize
  chunker.ts   # Blob.slice() 200MB splitting + serial naming
  queue.ts     # Sequential one-at-a-time upload orchestration
entrypoints/
  sidepanel/   # React UI
  background.ts
```

## Permissions

| Permission | Why |
|------------|-----|
| `cookies` | Read Google session cookies for NotebookLM API calls |
| `storage` | Persist UI preferences |
| `sidePanel` | Side panel UI |
| `host_permissions` | `notebooklm.google.com` API and upload endpoints only |
