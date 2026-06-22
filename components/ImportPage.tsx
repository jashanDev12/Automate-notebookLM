import { useCallback, useEffect, useState } from 'react';
import { getActiveTab, type ActiveTabInfo } from '../lib/active-tab';
import { fetchAuthSession } from '../lib/auth';
import { consumePendingPageImport } from '../lib/import-session';
import { importTextToNotebook, importUrlToNotebook } from '../lib/import-url';
import { createLogger } from '../lib/logger';
import { extractPageContent } from '../lib/page-extract';
import { toUserErrorMessage } from '../lib/user-errors';
import { UrlImportValidationError, validateImportUrl } from '../lib/url-import';

const log = createLogger('import-ui');

export type ImportPhase = 'idle' | 'registering' | 'processing' | 'done' | 'error';

interface Props {
  notebookId: string;
  authed: boolean;
  disabled?: boolean;
}

export function ImportPage({ notebookId, authed, disabled = false }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTabInfo | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [truncationWarning, setTruncationWarning] = useState(false);

  const effectiveUrl = manualUrl.trim() || activeTab?.url || '';

  const refreshActiveTab = useCallback(async () => {
    try {
      const tab = await getActiveTab();
      setActiveTab(tab);
      if (tab && !manualUrl.trim()) {
        setError(null);
      }
    } catch (err) {
      log.warn('Failed to read active tab', err);
    }
  }, [manualUrl]);

  useEffect(() => {
    void refreshActiveTab();
  }, [refreshActiveTab]);

  useEffect(() => {
    const loadPending = () => {
      void consumePendingPageImport().then((pending) => {
        if (!pending?.url) return;
        log.info('Pending import from context menu', { url: pending.url.slice(0, 80) });
        setManualUrl(pending.url);
        if (pending.title) {
          setActiveTab({
            tabId: pending.tabId ?? 0,
            url: pending.url,
            title: pending.title,
          });
        }
        setError(null);
        setSuccess(null);
      });
    };

    loadPending();

    const onMessage = (message: { type?: string }) => {
      if (message.type === 'PENDING_PAGE_IMPORT') loadPending();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    const onFocus = () => void refreshActiveTab();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshActiveTab]);

  const runImport = async (mode: 'url' | 'text') => {
    if (!notebookId) {
      setError('Select a target notebook first.');
      return;
    }
    if (!effectiveUrl) {
      setError('Open a web page in this window, or paste a URL below.');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    setTruncationWarning(false);
    setPhase('registering');

    try {
      validateImportUrl(effectiveUrl);
      const session = await fetchAuthSession();

      if (mode === 'url') {
        await importUrlToNotebook(notebookId, effectiveUrl, {
          session,
          title: activeTab?.title?.trim() || undefined,
          onStatus: setPhase,
        });
        setSuccess('Page URL imported. It may take a minute to appear in NotebookLM.');
      } else {
        const tabId = activeTab?.tabId;
        if (!tabId) {
          throw new Error('Open the page you want to import, then click Import page text.');
        }
        const extracted = await extractPageContent(tabId);
        if (extracted.truncated) {
          setTruncationWarning(true);
        }
        await importTextToNotebook(notebookId, extracted.title, extracted.content, {
          session,
          onStatus: setPhase,
        });
        setSuccess('Page text imported into NotebookLM.');
      }

      setPhase('done');
    } catch (err) {
      log.error('Import failed', err);
      setPhase('error');
      if (err instanceof UrlImportValidationError) {
        setError(err.message);
      } else {
        setError(toUserErrorMessage(err, 'import'));
      }
    } finally {
      setBusy(false);
    }
  };

  const urlError = effectiveUrl
    ? (() => {
        try {
          validateImportUrl(effectiveUrl);
          return null;
        } catch (err) {
          return err instanceof UrlImportValidationError ? err.message : 'Invalid URL';
        }
      })()
    : null;

  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-lg bg-white border border-nlm-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-gray-800">Current page</p>
          <button
            type="button"
            onClick={() => void refreshActiveTab()}
            disabled={busy}
            className="text-xs text-nlm-blue hover:underline disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {activeTab ? (
          <div className="flex gap-2 items-start">
            {activeTab.favIconUrl ? (
              <img src={activeTab.favIconUrl} alt="" className="w-4 h-4 mt-0.5 shrink-0" />
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{activeTab.title}</p>
              <p className="text-xs text-gray-500 truncate">{activeTab.url}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No importable page detected. Browse to an article or site, or paste a URL below.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700" htmlFor="import-url">
          URL override (optional)
        </label>
        <input
          id="import-url"
          type="url"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          disabled={busy || disabled}
          placeholder={activeTab?.url ?? 'https://example.com/article'}
          className="w-full rounded-lg border border-nlm-border bg-white px-3 py-2 text-sm focus:border-nlm-blue focus:outline-none focus:ring-1 focus:ring-nlm-blue disabled:opacity-50"
        />
        <p className="text-xs text-gray-500">
          Import URL sends the link to Google (same as pasting in NotebookLM). Import page text uses
          visible content from your browser — useful for paywalled pages.
        </p>
      </div>

      {urlError && <p className="text-sm text-amber-700">{urlError}</p>}

      {!notebookId && authed && (
        <p className="text-sm text-amber-700">Select a target notebook above to enable import.</p>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
          {success}
        </div>
      )}

      {truncationWarning && (
        <p className="text-sm text-amber-700">
          Page text was truncated to fit NotebookLM limits. Consider importing a shorter page or using
          Import URL.
        </p>
      )}

      {phase === 'processing' && (
        <p className="text-sm text-gray-600">NotebookLM is processing the source…</p>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void runImport('url')}
          disabled={!authed || !notebookId || busy || disabled || !!urlError || !effectiveUrl}
          className="w-full rounded-lg bg-nlm-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy && phase !== 'done' ? 'Importing URL…' : 'Import URL'}
        </button>
        <button
          type="button"
          onClick={() => void runImport('text')}
          disabled={
            !authed ||
            !notebookId ||
            busy ||
            disabled ||
            !!urlError ||
            !effectiveUrl ||
            !activeTab?.tabId
          }
          className="w-full rounded-lg border border-nlm-border bg-white px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy && phase !== 'done' ? 'Importing text…' : 'Import page text'}
        </button>
      </div>
    </div>
  );
}
