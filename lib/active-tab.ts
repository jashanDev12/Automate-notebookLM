import { createLogger } from './logger';
import { isNotebookLmUrl } from './tab-proxy';

const log = createLogger('active-tab');

export interface ActiveTabInfo {
  tabId: number;
  url: string;
  title: string;
  favIconUrl?: string;
}

/** Read the active tab in the current window (requires `tabs` permission). */
export async function getActiveTab(): Promise<ActiveTabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    log.debug('No active tab with URL');
    return null;
  }

  if (isNotebookLmUrl(tab.url)) {
    log.debug('Active tab is NotebookLM — not a source page', { tabId: tab.id });
    return null;
  }

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title?.trim() || tab.url,
    favIconUrl: tab.favIconUrl,
  };
}

/**
 * Ensure the extension has host access to the given page's origin so it can
 * inject the text-extraction script. Broad host_permissions are withheld
 * ("on click") by Chrome, so we request the specific origin at runtime.
 *
 * MUST be called synchronously from a user gesture (no awaits before it) so
 * Chrome accepts the permission request.
 */
export async function ensureHostAccess(pageUrl: string): Promise<void> {
  let schemePattern: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http:// and https:// pages can be imported.');
    }
    // Must EXACTLY match an optional_host_permissions entry in the manifest.
    // Chrome rejects sub-patterns ("Only permissions specified in the manifest
    // may be requested"), so request the declared broad scheme pattern.
    schemePattern = `${parsed.protocol}//*/*`;
  } catch {
    throw new Error('Only http:// and https:// pages can be imported.');
  }

  // Call request() directly (no preceding await) so the user gesture survives.
  // Requesting an already-granted pattern resolves true without a prompt.
  const granted = await chrome.permissions.request({ origins: [schemePattern] });
  if (!granted) {
    log.warn('Host access denied by user', { schemePattern });
    throw new Error(
      'Permission to read web pages was denied. Click "Allow" when Chrome prompts, then try Import page text again.',
    );
  }
  log.debug('Host access granted', { schemePattern });
}
