import { useCallback, useEffect, useState } from 'react';
import { FileDropZone } from '../../components/FileDropZone';
import { NotebookSelect } from '../../components/NotebookSelect';
import { UploadProgress } from '../../components/UploadProgress';
import { VideoPrepDialog } from '../../components/VideoPrepDialog';
import { fetchAuthSession, isAuthenticated, openNotebookLmSignIn } from '../../lib/auth';
import {
  getFileValidationError,
  getFileValidationWarning,
  needsVideoPrep,
} from '../../lib/chunker';
import { listNotebooks } from '../../lib/rpc';
import { uploadQueue } from '../../lib/queue';
import type { Notebook, UploadJob, VideoPrepMode } from '../../lib/types';

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

  const checkAuth = useCallback(async () => {
    setAuthed(await isAuthenticated());
  }, []);

  const loadNotebooks = useCallback(async () => {
    setLoadingNotebooks(true);
    setError(null);
    try {
      const session = await fetchAuthSession();
      const list = await listNotebooks(session);
      setNotebooks(list);
      setAuthed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAuthed(false);
    } finally {
      setLoadingNotebooks(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await checkAuth();
      if (await isAuthenticated()) {
        await loadNotebooks();
      }
    })();
  }, [checkAuth, loadNotebooks]);

  const runUpload = async (videoPrepMode?: VideoPrepMode) => {
    if (!selectedFile || !notebookId) return;

    setBusy(true);
    setError(null);
    setJob(null);

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
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
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

  const handleCancel = () => {
    uploadQueue.cancel();
    setShowPrepDialog(false);
    setBusy(false);
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

      <main className="p-4 space-y-4">
        {authed === false && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900 space-y-2">
            <p>
              Sign in with your Google account in a normal Chrome tab (same profile as this
              extension — not Incognito).
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void openNotebookLmSignIn()}
                className="flex-1 rounded-lg bg-nlm-blue px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Open NotebookLM
              </button>
              <button
                type="button"
                onClick={() => void loadNotebooks()}
                className="rounded-lg border border-amber-300 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
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

        <FileDropZone
          disabled={busy}
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

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleUpload}
            disabled={!selectedFile || !notebookId || busy || !!getFileValidationError(selectedFile)}
            className="flex-1 rounded-lg bg-nlm-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy
              ? job?.phase === 'preparing'
                ? 'Preparing…'
                : 'Uploading…'
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

        <UploadProgress job={job} />
      </main>

      <footer className="px-4 py-3 text-center text-xs text-gray-400 border-t border-nlm-border">
        Files are processed on your device. No third-party servers.
      </footer>
    </div>
  );
}
