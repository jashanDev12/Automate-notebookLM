import { ensureTabBridge, isNotebookLmUrl } from '../lib/tab-proxy';

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.runtime.onMessage.addListener((message: { type?: string; entry?: { scope: string; level: string; message: string; data?: unknown } }) => {
    if (message?.type !== 'NLM_LOG_MIRROR' || !message.entry) return;
    const { scope, level, message: text, data } = message.entry;
    const line = `[NLM:${scope}] ${text}`;
    if (level === 'error') console.error(line, data ?? '');
    else if (level === 'warn') console.warn(line, data ?? '');
    else console.info(line, data ?? '');
  });

  const onNotebookLmTabReady = (tabId: number) => {
    void ensureTabBridge(tabId).catch(() => {
      // tab may still be on sign-in or not injectable yet
    });
    void chrome.runtime.sendMessage({ type: 'NOTEBOOKLM_TAB_READY' }).catch(() => {
      // side panel may be closed
    });
  };

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id && isNotebookLmUrl(tab.url)) onNotebookLmTabReady(tab.id);
      }
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete') return;
    if (!isNotebookLmUrl(tab.url)) return;
    onNotebookLmTabReady(tabId);
  });
});
