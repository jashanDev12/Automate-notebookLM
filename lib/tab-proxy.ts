import { createLogger, previewText } from './logger';

const log = createLogger('tab-proxy');

/** Transfer large blobs to the NotebookLM tab in 8 MB pieces (Chrome message size limits). */
const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;

export const NOTEBOOKLM_TAB_URLS = [
  'https://notebooklm.google.com/*',
  'https://notebooklm.google.com/',
  'https://notebooklm.cloud.google.com/*',
  'https://notebooklm.cloud.google.com/',
] as const;

export function isNotebookLmUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'notebooklm.google.com' ||
      hostname.endsWith('.notebooklm.google.com') ||
      hostname === 'notebooklm.cloud.google.com'
    );
  } catch {
    return false;
  }
}

/** Find NotebookLM tabs across all windows (URL filter alone can miss some tabs). */
export async function findNotebookLmTabs(): Promise<chrome.tabs.Tab[]> {
  const byPattern = await chrome.tabs.query({ url: [...NOTEBOOKLM_TAB_URLS] });
  const all = await chrome.tabs.query({});
  const seen = new Set<number>();
  const merged: chrome.tabs.Tab[] = [];

  log.debug('Scanning for NotebookLM tabs', {
    byPattern: byPattern.length,
    allTabs: all.length,
  });

  for (const tab of [...byPattern, ...all]) {
    if (!tab.id || seen.has(tab.id) || !isNotebookLmUrl(tab.url)) continue;
    seen.add(tab.id);
    merged.push(tab);
  }

  log.debug('NotebookLM tabs found', {
    count: merged.length,
    urls: merged.map((t) => t.url),
  });
  return merged;
}

export const NOT_SIGNED_IN_HELP = `Not signed into Google in this Chrome profile.

The cookies listed in diagnostics (AEC, NID, OTZ, etc.) are anonymous — they do not mean you are logged in. Session cookies (SID) only appear after a successful Google sign-in.

Do this in a normal Chrome window (not Incognito):
1. Go to https://accounts.google.com and sign in
2. Open https://notebooklm.google.com and confirm you see your notebooks
3. Leave that NotebookLM tab open
4. Click Refresh in this extension

If Google shows "Couldn't sign you in": turn off ad/tracker blockers for google.com, allow cookies, try signing in at accounts.google.com first, or try another network/VPN off.`;

export const TAB_REQUIRED_HELP = `No NotebookLM tab is open right now.

The extension must talk to an open notebooklm.google.com tab — it cannot connect on its own.

Click "Connect to NotebookLM" below. That opens NotebookLM, waits for it to load, then connects automatically.

Important: keep the NotebookLM tab open in this Chrome window. Do not close it before uploading.`;

interface TabResponse {
  error?: string;
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lastError = chrome.runtime.lastError?.message ?? '';
  const combined = `${msg} ${lastError}`;
  return (
    combined.includes('Receiving end does not exist') ||
    combined.includes('Could not establish connection')
  );
}

function getBridgeScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const files = new Set<string>();
  for (const entry of manifest.content_scripts ?? []) {
    const matchesNotebookLm = entry.matches?.some((m) => m.includes('notebooklm.google.com'));
    if (!matchesNotebookLm) continue;
    for (const js of entry.js ?? []) {
      files.add(js);
    }
  }
  return [...files];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inject the NotebookLM bridge content script if the tab was opened before the extension loaded. */
export async function ensureTabBridge(tabId: number): Promise<void> {
  try {
    const ping = (await chrome.tabs.sendMessage(tabId, { type: 'NLM_PING' })) as
      | { ok?: boolean }
      | undefined;
    if (ping?.ok) {
      log.debug('Tab bridge already connected', { tabId });
      return;
    }
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    log.debug('Tab bridge ping failed — injecting', { tabId });
  }

  const files = getBridgeScriptFiles();
  if (files.length === 0) {
    throw new Error('Extension bridge script missing. Run npm run build and reload the extension.');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });

  await delay(100);

  try {
    const ping = (await chrome.tabs.sendMessage(tabId, { type: 'NLM_PING' })) as
      | { ok?: boolean }
      | undefined;
    if (ping?.ok) {
      log.info('Tab bridge injected and connected', { tabId, files });
      return;
    }
  } catch (err) {
    if (isConnectionError(err)) {
      log.error('Tab bridge injection failed', err, { tabId, files });
      throw new Error(
        'Could not connect to the NotebookLM tab. Refresh that tab (F5), then click Refresh here.',
      );
    }
    throw err;
  }
}

async function sendToTab<T extends TabResponse>(tabId: number, message: unknown): Promise<T> {
  await ensureTabBridge(tabId);

  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as T | undefined;
    if (!response) {
      throw new Error(
        'NotebookLM tab did not respond. Refresh the NotebookLM tab (F5), then click Refresh here.',
      );
    }
    if (response.error) {
      throw new Error(response.error);
    }
    return response;
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(
        'Could not connect to the NotebookLM tab. Refresh that tab (F5), then click Refresh here.',
      );
    }
    throw err;
  }
}

export async function findNotebookLmTabId(): Promise<number | null> {
  const tabs = await findNotebookLmTabs();
  return tabs.find((t) => t.id)?.id ?? null;
}

export async function requireNotebookLmTabId(): Promise<number> {
  const tabId = await findNotebookLmTabId();
  if (!tabId) {
    throw new Error(TAB_REQUIRED_HELP);
  }
  return tabId;
}

export { readTabSession as getSessionFromTab } from './tab-session';
export type { TabSession } from './tab-session';

export interface TabFetchResult extends TabResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function tabProxyFetch(
  tabId: number,
  url: string,
  init: { method: string; headers: Record<string, string>; bodyText?: string },
): Promise<TabFetchResult> {
  log.debug('tabProxyFetch', {
    tabId,
    method: init.method,
    url: url.split('?')[0],
    bodyLen: init.bodyText?.length ?? 0,
  });
  const result = await sendToTab<TabFetchResult>(tabId, {
    type: 'NLM_FETCH',
    url,
    method: init.method,
    headers: init.headers,
    bodyText: init.bodyText,
  });
  log.debug('tabProxyFetch response', {
    tabId,
    ok: result.ok,
    status: result.status,
    bodyPreview: previewText(result.body, 200),
  });
  return result;
}

export async function tabProxyBlobUpload(
  tabId: number,
  url: string,
  headers: Record<string, string>,
  blob: Blob,
): Promise<{ ok: boolean; status: number; body: string }> {
  const uploadId = crypto.randomUUID();
  log.info('tabProxyBlobUpload start', {
    tabId,
    uploadId,
    bytes: blob.size,
    chunkPieces: Math.ceil(blob.size / TRANSFER_CHUNK_BYTES),
  });
  await sendToTab(tabId, { type: 'NLM_UPLOAD_INIT', uploadId });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) {
    const end = Math.min(offset + TRANSFER_CHUNK_BYTES, bytes.length);
    await sendToTab(tabId, {
      type: 'NLM_UPLOAD_CHUNK',
      uploadId,
      data: Array.from(bytes.subarray(offset, end)),
    });
  }

  const result = await sendToTab<{ ok: boolean; status: number; body: string }>(tabId, {
    type: 'NLM_UPLOAD_FINALIZE',
    uploadId,
    url,
    method: 'POST',
    headers,
  });
  log.info('tabProxyBlobUpload done', {
    tabId,
    uploadId,
    ok: result.ok,
    status: result.status,
  });
  return result;
}
