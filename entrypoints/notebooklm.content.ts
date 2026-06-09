import { extractWizField, isSignInPageHtml } from '../lib/wiz';

const uploadBuffers = new Map<string, Uint8Array[]>();

type ContentMessage =
  | { type: 'NLM_PING' }
  | { type: 'NLM_GET_SESSION' }
  | {
      type: 'NLM_FETCH';
      url: string;
      method: string;
      headers: Record<string, string>;
      bodyText?: string;
    }
  | { type: 'NLM_UPLOAD_INIT'; uploadId: string }
  | { type: 'NLM_UPLOAD_CHUNK'; uploadId: string; data: number[] }
  | {
      type: 'NLM_UPLOAD_FINALIZE';
      uploadId: string;
      url: string;
      method?: string;
      headers: Record<string, string>;
    };

const BRIDGE_FLAG = '__notebooklmMegaUploaderBridge';

export default defineContentScript({
  matches: ['https://notebooklm.google.com/*', 'https://notebooklm.cloud.google.com/*'],
  runAt: 'document_idle',
  main() {
    if ((globalThis as Record<string, unknown>)[BRIDGE_FLAG]) return;
    (globalThis as Record<string, unknown>)[BRIDGE_FLAG] = true;

    chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
      void handleMessage(message)
        .then((result) => sendResponse(result))
        .catch((err: unknown) => {
          sendResponse({
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    });
  },
});

async function handleMessage(message: ContentMessage): Promise<unknown> {
  switch (message.type) {
    case 'NLM_PING':
      return { ok: true };

    case 'NLM_GET_SESSION': {
      const html = document.documentElement.innerHTML;
      if (isSignInPageHtml(html)) {
        return {
          signedIn: false,
          error:
            'NotebookLM tab shows Google sign-in. Complete sign-in on that tab, then click Refresh.',
        };
      }
      const csrfToken = extractWizField(html, 'SNlM0e');
      const sessionId = extractWizField(html, 'FdrFJe');
      if (!csrfToken || !sessionId) {
        return {
          signedIn: false,
          error:
            'NotebookLM is still loading. Wait until your notebooks appear on that tab, then click Refresh.',
        };
      }
      const authuser = new URLSearchParams(location.search).get('authuser') ?? undefined;
      return { signedIn: true, csrfToken, sessionId, authuser };
    }

    case 'NLM_FETCH': {
      const response = await fetch(message.url, {
        method: message.method,
        headers: message.headers,
        body: message.bodyText,
        credentials: 'include',
      });
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    }

    case 'NLM_UPLOAD_INIT': {
      uploadBuffers.set(message.uploadId, []);
      return { ok: true };
    }

    case 'NLM_UPLOAD_CHUNK': {
      const parts = uploadBuffers.get(message.uploadId);
      if (!parts) throw new Error('Upload session expired — try again.');
      parts.push(new Uint8Array(message.data));
      return { ok: true };
    }

    case 'NLM_UPLOAD_FINALIZE': {
      const parts = uploadBuffers.get(message.uploadId);
      if (!parts) throw new Error('Upload session expired — try again.');
      uploadBuffers.delete(message.uploadId);
      const blob = new Blob(parts);
      const response = await fetch(message.url, {
        method: message.method ?? 'POST',
        headers: message.headers,
        body: blob,
        credentials: 'include',
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text().catch(() => ''),
      };
    }

    default:
      throw new Error('Unknown message');
  }
}
