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
