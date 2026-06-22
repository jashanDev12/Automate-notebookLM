export const PENDING_IMPORT_STORAGE_KEY = 'pendingPageImport';

export interface PendingPageImport {
  url: string;
  title?: string;
  tabId?: number;
}

export async function setPendingPageImport(payload: PendingPageImport): Promise<void> {
  await chrome.storage.session.set({ [PENDING_IMPORT_STORAGE_KEY]: payload });
}

export async function consumePendingPageImport(): Promise<PendingPageImport | null> {
  const result = await chrome.storage.session.get(PENDING_IMPORT_STORAGE_KEY);
  const pending = result[PENDING_IMPORT_STORAGE_KEY] as PendingPageImport | undefined;
  if (!pending?.url) return null;
  await chrome.storage.session.remove(PENDING_IMPORT_STORAGE_KEY);
  return pending;
}
