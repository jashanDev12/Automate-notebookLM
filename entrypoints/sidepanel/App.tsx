import { useCallback, useEffect, useState } from 'react';
import { createLogger, formatError } from '../../lib/logger';
import { toUserErrorMessage } from '../../lib/user-errors';
import { FileDropZone } from '../../components/FileDropZone';
import { NotebookSelect } from '../../components/NotebookSelect';
import { computeUploadPercent, UploadProgress } from '../../components/UploadProgress';
import { VideoPrepDialog } from '../../components/VideoPrepDialog';
import {
  connectNotebookLm,
  fetchAuthSession,
} from '../../lib/auth';
import { findNotebookLmTabs } from '../../lib/tab-proxy';
import {
  getFileValidationError,
  getFileValidationWarning,
  needsVideoPrep,
} from '../../lib/chunker';
import { listNotebooks } from '../../lib/rpc';
import { getLatestStoredJob } from '../../lib/chunk-store';
import { uploadQueue } from '../../lib/queue';
import type { Notebook, UploadJob, VideoPrepMode } from '../../lib/types';
import { ArtifactList } from '../../components/ArtifactList';
import { ImportPage } from '../../components/ImportPage';

const log = createLogger('ui');

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState('');
  const [loadingNotebooks, setLoadingNotebooks] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrepDialog, setShowPrepDialog] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'upload' | 'import' | 'artifacts'>('upload');

  const handleDone = useCallback(() => {
    const jobId = job?.id;
    void uploadQueue.clearPreparedChunks(jobId);
    setSelectedFile(null);
    setJob(null);
    setError(null);
    setWarning(null);
    setShowPrepDialog(false);
    log.info('User dismissed upload summary', { jobId });
  }, [job?.id]);

  const loadNotebooks = useCallback(async () => {
    setLoadingNotebooks(true);
    setError(null);
    log.info('loadNotebooks started');
    try {
      const session = await fetchAuthSession();
      const list = await listNotebooks(session);
      setNotebooks(list);
      setAuthed(true);
      log.info('loadNotebooks succeeded', { notebookCount: list.length });
      if (list.length === 0) {
        setWarning('Connected, but no notebooks found. Create one at notebooklm.google.com first.');
      }
    } catch (err) {
      log.error('loadNotebooks failed', err);
      setError(toUserErrorMessage(err, 'auth'));
      setAuthed(false);
      setNotebooks([]);
      setNotebookId('');
    } finally {
      setLoadingNotebooks(false);
    }
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const tabs = await findNotebookLmTabs();
      if (tabs.length === 0) {
        await connectNotebookLm();
      }
      await loadNotebooks();
    } catch (err) {
      log.error('handleConnect failed', err);
      setError(toUserErrorMessage(err, 'auth'));
      setAuthed(false);
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    void getLatestStoredJob().then((stored) => {
      if (!stored || uploadQueue.isRunning) return;
      // We don't automatically hydrate/start the job anymore.
      // This prevents the extension from starting an old upload on restart.
      // Instead, we just check if there's a stored job and log it for debug.
      log.info('Found stored upload in local storage', {
        jobId: stored.job.id,
        file: stored.job.originalName,
        phase: stored.job.phase,
      });
    });
  }, []);

  useEffect(() => {
    const onMessage = (message: { type?: string }) => {
      if (message.type === 'PENDING_PAGE_IMPORT') {
        setActiveTab('import');
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    let debounceId: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (message: { type?: string }) => {
      if (message.type !== 'NOTEBOOKLM_TAB_READY') return;
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        if (uploadQueue.isRunning) {
          log.debug('Skipping notebook refresh — upload in progress');
          return;
        }
        void loadNotebooks();
      }, 2000);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      if (debounceId) clearTimeout(debounceId);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [loadNotebooks]);

  const runUpload = async (videoPrepMode?: VideoPrepMode) => {
    if (!selectedFile || !notebookId) return;

    setBusy(true);
    setError(null);
    setJob(null);
    log.info('upload started', {
      file: selectedFile.name,
      sizeMb: (selectedFile.size / (1024 * 1024)).toFixed(1),
      videoPrepMode,
    });

    try {
      await uploadQueue.enqueue(
        selectedFile,
        notebookId,
        (updated) => {
          setJob({ ...updated, chunks: [...updated.chunks] });
        },
        { videoPrepMode },
      );
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError' || (err as Error).message?.includes('aborted');
      if (isAbort) {
        log.info('upload cancelled');
        if (uploadQueue.hasPreparedChunks) {
          setError(null);
        } else {
          setJob(null);
          setError(null);
        }
      } else {
        log.error('upload failed', err, formatError(err));
        setError(toUserErrorMessage(err, 'upload'));
      }
    } finally {
      setBusy(false);
      setShowPrepDialog(false);
    }
  };

  const handleUpload = () => {
    if (!selectedFile || !notebookId) return;

    const validationError = getFileValidationError(selectedFile);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (needsVideoPrep(selectedFile)) {
      setShowPrepDialog(true);
      return;
    }

    void runUpload();
  };

  const handlePrepChoice = (mode: VideoPrepMode) => {
    setShowPrepDialog(false);
    void runUpload(mode);
  };

  const handleRetryChunk = async (chunkIndex: number) => {
    if (!job || job.phase !== 'done' || busy || uploadQueue.isRunning) return;
    const jobSnapshot = job;
    setBusy(true);
    setError(null);
    log.info('Retry single part clicked', { chunkIndex: chunkIndex + 1 });
    try {
      await uploadQueue.retryChunk(jobSnapshot, chunkIndex, (updated) => {
        setJob({ ...updated, chunks: [...updated.chunks] });
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        log.error('retry chunk failed', err, formatError(err));
        setError(toUserErrorMessage(err, 'upload'));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    log.info('Cancel clicked');
    uploadQueue.cancel();
    setShowPrepDialog(false);
    setJob((prev) => {
      if (!prev) return null;
      if (prev.chunks.length === 0) {
        return null;
      }
      return { ...prev, status: 'cancelled', phase: 'done', prepProgress: undefined };
    });
    setBusy(false);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-nlm-surface text-gray-900">
      <VideoPrepDialog
        open={showPrepDialog && !busy}
        fileName={selectedFile?.name ?? ''}
        fileSizeMb={(selectedFile?.size ?? 0) / (1024 * 1024)}
        onChoose={handlePrepChoice}
        onCancel={() => setShowPrepDialog(false)}
      />

      <header className="bg-white border-b border-nlm-border px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-900">NotebookLM Mega Uploader</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          100% local processing · sequential uploads to Google NotebookLM only
        </p>
      </header>

      <div className="flex border-b border-nlm-border bg-white px-4">
        <button
          onClick={() => setActiveTab('upload')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'upload' ? 'border-nlm-blue text-nlm-blue' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Upload
        </button>
        <button
          onClick={() => setActiveTab('import')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'import' ? 'border-nlm-blue text-nlm-blue' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Import Page
        </button>
        <button
          onClick={() => setActiveTab('artifacts')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'artifacts' ? 'border-nlm-blue text-nlm-blue' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Export
        </button>
      </div>

      <main className="p-4 space-y-4">
        {authed !== true && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900 space-y-2">
            <p>
              <strong>Connect first.</strong> This extension needs an open{' '}
              <strong>notebooklm.google.com</strong> tab in this Chrome window (where Gmail works — not
              Incognito).
            </p>
            <p>
              Click <strong>Connect to NotebookLM</strong> below. Sign in if Google asks.{' '}
              <strong>Keep that tab open</strong> while you upload.
            </p>
            <p className="text-xs text-amber-800">
              Use Connect first — Refresh only works after a NotebookLM tab is open.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleConnect()}
                disabled={connecting || loadingNotebooks}
                className="flex-1 rounded-lg bg-nlm-blue px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {connecting ? 'Connecting…' : 'Connect to NotebookLM'}
              </button>
              <button
                type="button"
                onClick={() => void loadNotebooks()}
                disabled={connecting || loadingNotebooks}
                className="rounded-lg border border-amber-300 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </div>
        )}

        {warning && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
            {warning}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <NotebookSelect
          notebooks={notebooks}
          value={notebookId}
          loading={loadingNotebooks}
          onChange={setNotebookId}
          onRefresh={loadNotebooks}
        />

        {activeTab === 'upload' ? (
          <div className="space-y-4 pt-2">
            <FileDropZone
              disabled={busy || job?.phase === 'done' || job?.phase === 'retrying'}
              onFileSelected={(file) => {
                setSelectedFile(file);
                setJob(null);
                setError(getFileValidationError(file));
                setWarning(getFileValidationWarning(file));
              }}
            />

            {selectedFile && (
              <div className="rounded-lg bg-white border border-nlm-border px-3 py-2 text-sm flex justify-between">
                <span className="truncate font-medium">{selectedFile.name}</span>
                <span className="text-gray-500 shrink-0 ml-2">
                  {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                  {needsVideoPrep(selectedFile) && (
                    <span className="text-amber-600 ml-1">· needs prep</span>
                  )}
                </span>
              </div>
            )}

            {selectedFile && needsVideoPrep(selectedFile) && authed === false && (
              <p className="text-sm text-amber-700">
                Your video needs local prep (compress or split). Connect to NotebookLM first using the
                steps above — prep starts when you click Start Upload after a notebook is selected.
              </p>
            )}

            {!notebookId && selectedFile && authed && (
              <p className="text-sm text-amber-700">Select a target notebook above to enable upload.</p>
            )}

            {job?.phase !== 'done' && job?.phase !== 'retrying' && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={!selectedFile || !notebookId || busy || !!getFileValidationError(selectedFile)}
                  className="flex-1 rounded-lg bg-nlm-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy
                    ? job?.phase === 'preparing' && job.prepProgress
                      ? `Splitting… ${Math.min(100, job.prepProgress.percent)}%`
                      : job?.phase === 'uploading' && job.chunks.length > 0
                        ? (() => {
                            const done = job.chunks.filter((c) => c.status === 'completed').length;
                            const total = job.chunks.length;
                            if (done === total) return 'All parts ready';
                            if (job.chunks.some(
                              (c) => c.status === 'processing' || c.status === 'polling',
                            )) {
                              return done > 0
                                ? `NotebookLM processing… (${done}/${total} ready)`
                                : 'NotebookLM processing…';
                            }
                            if (job.chunks.some((c) => c.status === 'uploaded')) {
                              return `Uploaded — waiting for NotebookLM… (${done}/${total} ready)`;
                            }
                            return `Uploading… ${computeUploadPercent(job)}%`;
                          })()
                        : 'Working…'
                    : 'Start Upload'}
                </button>
                {busy && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="rounded-lg border border-nlm-border px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}

            <UploadProgress
              job={job}
              notebookTitle={notebooks.find((n) => n.id === notebookId)?.title}
              busy={busy}
              onRetryChunk={
                job?.phase === 'done' ? (i) => void handleRetryChunk(i) : undefined
              }
              onDone={job?.phase === 'done' || job?.phase === 'retrying' ? handleDone : undefined}
              onCancel={handleCancel}
            />
          </div>
        ) : activeTab === 'import' ? (
          <ImportPage
            notebookId={notebookId}
            authed={authed === true}
            disabled={busy || uploadQueue.isRunning}
          />
        ) : (
          <div className="pt-2">
            <ArtifactList notebookId={notebookId} />
          </div>
        )}
      </main>

      <footer className="px-4 py-3 text-center text-xs text-gray-400 border-t border-nlm-border space-y-1">
        <p>Files are processed on your device. No third-party servers.</p>
        <p>
          Debug: Console filter <code className="text-gray-500">[NLM]</code> · verbose:{' '}
          <code className="text-gray-500">localStorage.setItem(&apos;nlm-debug&apos;,&apos;1&apos;)</code>
        </p>
      </footer>
    </div>
  );
}
