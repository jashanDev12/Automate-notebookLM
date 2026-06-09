# NotebookLM Mega Uploader

A Manifest V3 Chrome extension built with [WXT](https://wxt.dev), React 18, and Tailwind CSS. Upload large local files (PDF, TXT, Markdown, MP4/video) to Google NotebookLM. Documents are byte-split under 200MB; oversized videos are **compressed** or **time-split** locally via FFmpeg.wasm before upload.

**Privacy:** All processing happens locally in your browser. The only network traffic goes to official `notebooklm.google.com` endpoints.

**Configuration:** No `.env` file or API keys required. Authentication uses your existing Google session in Chrome.

## Features

- **Session auth** — Uses your signed-in NotebookLM tab (no separate extension login)
- **200MB chunking** — Documents split with `Blob.slice()` as `OriginalName_Part1.pdf`, `Part2`, etc.
- **Video prep** — FFmpeg.wasm compresses or time-splits oversized videos into valid MP4 parts
- **Sequential queue** — One chunk uploads at a time; Part 2 starts only after Part 1 succeeds
- **Resumable upload** — Google's Scotty resumable-upload handshake (modeled on [notebooklm-py](../notebooklm-py))
- **RPC client** — TypeScript `batchexecute` client for `list_notebooks` and `add_source_file`

## Prerequisites

- [Node.js](https://nodejs.org) 18+ (includes `npm`)
- Google Chrome (or another Chromium browser with extension support)
- A Google account with access to [NotebookLM](https://notebooklm.google.com)

## Developer quickstart

### 1. Clone and install

```bash
git clone <your-repo-url>
cd notebooklm-mega-uploader
npm install
```

`npm install` runs a postinstall step that:

- Generates WXT types (`.wxt/`)
- Copies FFmpeg WASM binaries into `public/ffmpeg/` (~32 MB, gitignored — required for video compress/split)

### 2. Start dev mode

```bash
npm run dev
```

This watches your code and rebuilds the extension. **It does not open Chrome** — on purpose. WXT’s auto-opened browser uses a **separate empty profile** (no Gmail login), which breaks NotebookLM auth.

### 3. Load the extension in your real Chrome (where Gmail is signed in)

1. Open your **normal** Chrome window (the one you use every day)
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked**
5. Select: `notebooklm-mega-uploader/.output/chrome-mv3-dev` (created by `npm run dev`)

For a one-off production build, use `.output/chrome-mv3` after `npm run build`.

**Optional:** `npm run dev:browser` opens WXT’s own Chrome with a persistent profile in `.wxt/chrome-data`. Sign into Google there once; the session is remembered. This is separate from your daily Chrome profile.

### 4. Open the side panel

1. Click the **puzzle piece** icon in Chrome's toolbar → **pin** NotebookLM Mega Uploader
2. Click the extension icon to open the **side panel**

> The UI lives in the **side panel**, not on `localhost:3000`. Keep `npm run dev` running in a terminal while you develop; reload the extension at `chrome://extensions` after changes (or when WXT rebuilds).

### 5. Sign in

The extension does not have its own login page. It reads cookies from your Chrome profile.

1. In the side panel, click **Open NotebookLM**
2. Sign in with Google in that tab (use a **normal** window — not Incognito)
3. Confirm you see your notebooks on notebooklm.google.com
4. Return to the side panel and click **Refresh**

### 6. Upload

1. Select a target notebook from the dropdown
2. Drag & drop or browse for a file (PDF, TXT, Markdown, MP4, WebM, MOV, MKV)
3. Click **Start Upload**

After code changes, reload the extension at `chrome://extensions` (click the reload icon on the extension card), or keep `npm run dev` running for hot reload.

## Usage details

### Documents (PDF, TXT, Markdown)

Files over 200MB are byte-split locally (`_Part1`, `_Part2`, …) and uploaded sequentially.

### Videos (MP4, WebM, MOV, MKV)

- **Under 200MB** — uploaded directly
- **Over 200MB** — you are always asked to choose:
  - **Split into parts** — fast stream-copy by time; valid MP4 parts (`_Part1`, `_Part2`, …)
  - **Compress to one file** — slower re-encode; single source under 200MB
- **1–2GB** — warning shown (high memory use)
- **Over 2GB** — blocked (browser memory limit)

## Build for production

```bash
npm run build    # output: .output/chrome-mv3/
npm run zip        # distributable .zip for Chrome Web Store or manual install
```

Load `.output/chrome-mv3` the same way as in the quickstart (Load unpacked).

## Project layout

```
notebooklm-mega-uploader/
├── entrypoints/
│   ├── background.ts       # Side panel on icon click
│   └── sidepanel/          # React UI
├── components/             # FileDropZone, VideoPrepDialog, etc.
├── lib/
│   ├── auth.ts             # chrome.cookies + session token extraction
│   ├── rpc.ts              # batchexecute client
│   ├── upload.ts           # Resumable upload handshake
│   ├── chunker.ts          # Document byte-split + video prep routing
│   ├── queue.ts            # Sequential upload orchestration
│   └── video/ffmpeg.ts     # FFmpeg.wasm compress & split
├── public/ffmpeg/            # Generated by npm install (do not commit)
├── scripts/copy-ffmpeg-core.mjs
└── wxt.config.ts
```

## Git: what to commit

| Commit | Ignore |
|--------|--------|
| Source (`lib/`, `components/`, `entrypoints/`) | `node_modules/` |
| `package.json`, `package-lock.json` | `.output/` |
| Config (`wxt.config.ts`, `tsconfig.json`, …) | `.wxt/` |
| `scripts/`, `README.md` | `public/ffmpeg/` (~32 MB, recreated on install) |

## Permissions

| Permission | Why |
|------------|-----|
| `cookies` | Read Google session cookies for NotebookLM API calls |
| `storage` | Persist UI preferences |
| `sidePanel` | Side panel UI |
| `tabs` | Open notebooklm.google.com for sign-in |
| `host_permissions` | `notebooklm.google.com` and `*.google.com` API/upload endpoints |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm` not recognized | Install [Node.js 18+](https://nodejs.org), restart your terminal |
| No Google session cookies | Click **Open NotebookLM** in the side panel, sign in, then **Refresh** |
| Signed in but still fails | Use the same Chrome profile (not Incognito); reload extension at `chrome://extensions` |
| `npm run dev` opened Chrome with no Gmail | Use your normal Chrome instead: `npm run dev` + Load unpacked from `.output/chrome-mv3-dev` |
| Video prep fails | Re-run `npm install` to restore `public/ffmpeg/` |
| `Missing field moduleType` (dev) | Ensure `@wxt-dev/module-react` is pinned to `1.1.2` and `vite` override is `6.4.3` in `package.json` |
| Changes not appearing | Reload extension at `chrome://extensions` or restart `npm run dev` |

### Debug logs

When something fails, the extension writes structured logs prefixed with `[NLM:scope]` (auth, rpc, upload, ffmpeg, etc.). Secrets (CSRF, session IDs, cookies) are redacted automatically.

1. **Side panel console** — Right-click the side panel → **Inspect** → **Console**, filter by `[NLM]`.
2. **Service worker console** — `chrome://extensions` → your extension → **Service worker** → **Inspect** (logs are mirrored here too).
3. **Copy debug log** — After an error, click **Copy debug log** in the red error box (last ~250 entries).
4. **Verbose mode** — In the side panel console, run `localStorage.setItem('nlm-debug','1')` and reload the side panel for `debug`-level logs and stack traces.

`npm run dev` terminal only shows build output — not upload/split logs.

## Related projects

- [notebooklm-py](../notebooklm-py) — Python library this extension's upload/RPC logic is based on
- [notebooklm-uploader](../notebooklm-uploader) — CLI uploader with Markdown conversion and word-based chunking
