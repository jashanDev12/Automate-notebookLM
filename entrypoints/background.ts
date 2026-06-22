import { ensureTabBridge, isNotebookLmUrl } from '../lib/tab-proxy';
import { setPendingPageImport } from '../lib/import-session';

const IMPORT_MENU_ID = 'nlm-import-page';

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

  const registerContextMenus = () => {
    void chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: IMPORT_MENU_ID,
        title: 'Import to NotebookLM',
        contexts: ['page', 'link'],
      });
    });
  };

  chrome.runtime.onInstalled.addListener(() => {
    registerContextMenus();
    void chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id && isNotebookLmUrl(tab.url)) onNotebookLmTabReady(tab.id);
      }
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    registerContextMenus();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== IMPORT_MENU_ID || !tab?.id) return;

    const url = info.linkUrl || info.pageUrl;
    if (!url) return;
    if (isNotebookLmUrl(url)) return;

    void (async () => {
      await setPendingPageImport({
        url,
        title: tab.title,
        tabId: tab.id,
      });

      if (tab.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
          // side panel may already be open
        });
      }

      void chrome.runtime.sendMessage({ type: 'PENDING_PAGE_IMPORT' }).catch(() => {
        // side panel may be closed
      });
    })();
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete') return;
    if (!isNotebookLmUrl(tab.url)) return;
    onNotebookLmTabReady(tabId);
  });
});
