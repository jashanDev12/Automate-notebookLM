import { useEffect, useState } from 'react';
import { copyRecentLogsToClipboard } from '../lib/logger';
import type { UploadJob } from '../lib/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-500';
    case 'uploading':
      return 'bg-nlm-blue animate-pulse';
    case 'processing':
      return 'bg-amber-500 animate-pulse';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-gray-300';
  }
}

function statusLabel(status: string, uploadPct: number): string {
  switch (status) {
    case 'uploading':
      return `${uploadPct}%`;
    case 'processing':
      return 'processing';
    case 'completed':
      return 'done';
    default:
      return status;
  }
}

/** Byte-weighted overall upload progress (0–100). */
export function computeUploadPercent(job: UploadJob): number {
  if (!job.chunks.length) return 0;
  const totalBytes = job.chunks.reduce((sum, c) => sum + c.size, 0);
  if (totalBytes === 0) return 0;
  const sentBytes = job.chunks.reduce((sum, c) => sum + c.bytesSent, 0);
  return Math.min(100, Math.round((sentBytes / totalBytes) * 100));
}

interface Props {
  job: UploadJob | null;
  notebookTitle?: string;
  busy?: boolean;
  onRetryFailed?: () => void;
  onRetryChunk?: (chunkIndex: number) => void;
  onDone?: () => void;
}

export function UploadProgress({
  job,
  notebookTitle,
  busy = false,
  onRetryFailed,
  onRetryChunk,
  onDone,
}: Props) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [logCopied, setLogCopied] = useState(false);

  useEffect(() => {
    if (!job || job.phase !== 'preparing') {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [job?.id, job?.phase]);

  if (!job) return null;

  if (job.phase === 'preparing' && job.prepProgress) {
    const prepPct = Math.min(100, Math.max(0, job.prepProgress.percent));
    return (
      <div className="rounded-xl border border-nlm-border bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-gray-800 truncate">{job.originalName}</p>
          <span className="text-lg font-semibold text-amber-700 shrink-0">{prepPct}%</span>
        </div>
        <p className="text-xs text-gray-500">Splitting / preparing locally…</p>
        <p className="text-sm text-gray-700">{job.prepProgress.message}</p>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className="bg-amber-500 h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${Math.max(prepPct, 2)}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <span>Elapsed: {formatElapsed(elapsedSec)}</span>
          {job.prepProgress.part && job.prepProgress.totalParts && (
            <span>
              Part {job.prepProgress.part} of {job.prepProgress.totalParts}
            </span>
          )}
        </div>
      </div>
    );
  }

  const completed = job.chunks.filter((c) => c.status === 'completed').length;
  const failed = job.chunks.filter((c) => c.status === 'failed').length;
  const total = job.chunks.length;
  const uploadPct = computeUploadPercent(job);
  const isDone = job.phase === 'done';
  const allSucceeded = isDone && failed === 0 && completed === total;
  const partialSuccess = isDone && completed > 0 && failed > 0;

  if (total === 0) return null;

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 ${
        isDone
          ? allSucceeded
            ? 'border-green-200 bg-green-50'
            : partialSuccess
              ? 'border-amber-200 bg-amber-50'
              : 'border-red-200 bg-red-50'
          : 'border-nlm-border bg-white'
      }`}
    >
      {isDone && (
        <div className="text-center space-y-1 pb-1">
          <p className="text-lg font-semibold text-gray-900">
            {allSucceeded ? 'Upload complete' : partialSuccess ? 'Partially uploaded' : 'Upload failed'}
          </p>
          <p className="text-sm text-gray-700">
            {allSucceeded
              ? notebookTitle
                ? `All ${total} part(s) are ready in "${notebookTitle}".`
                : `All ${total} part(s) processed successfully by NotebookLM.`
              : partialSuccess
                ? `${completed} of ${total} part(s) ready${notebookTitle ? ` in "${notebookTitle}"` : ''}.`
                : `No parts were processed successfully.`}
          </p>
          {partialSuccess && (
            <p className="text-xs text-amber-800">
              Failed parts can be retried individually below without re-splitting the video.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-gray-800 truncate">{job.originalName}</p>
          <p className="text-xs text-gray-500">
            {isDone
              ? `${completed}/${total} parts succeeded${failed > 0 ? ` · ${failed} failed` : ''}`
              : `Uploading & processing · ${completed}/${total} ready${failed > 0 ? ` · ${failed} failed` : ''}`}
          </p>
        </div>
        {!isDone && (
          <span className="text-lg font-semibold text-nlm-blue shrink-0">{uploadPct}%</span>
        )}
      </div>

      {!isDone && (
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className="bg-nlm-blue h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${uploadPct}%` }}
          />
        </div>
      )}

      <ul className="space-y-2 max-h-48 overflow-y-auto">
        {job.chunks.map((chunk) => {
          const pct =
            chunk.size > 0 ? Math.round((chunk.bytesSent / chunk.size) * 100) : 0;
          return (
            <li key={chunk.index} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-gray-700">{chunk.filename}</span>
                <span className="text-xs text-gray-500 shrink-0">
                  {formatBytes(chunk.size)}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${statusColor(chunk.status)}`}
                    style={{
                      width:
                        chunk.status === 'completed' || chunk.status === 'processing'
                          ? '100%'
                          : chunk.status === 'uploading'
                            ? `${pct}%`
                            : '0%',
                    }}
                  />
                </div>
                <span className="text-xs text-gray-500 w-24 text-right capitalize">
                  {statusLabel(chunk.status, pct)}
                </span>
              </div>
              {chunk.error && (
                <p className="text-xs text-red-600 mt-0.5">{chunk.error}</p>
              )}
              {isDone && chunk.status === 'failed' && onRetryChunk && (
                <button
                  type="button"
                  onClick={() => onRetryChunk(chunk.index)}
                  disabled={busy}
                  className="mt-1 text-xs rounded border border-nlm-border px-2 py-1 text-nlm-blue hover:bg-blue-50 disabled:opacity-50"
                >
                  {busy ? 'Retrying…' : 'Retry this part'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {isDone && (
        <div className="flex flex-col gap-2 pt-1">
          {failed > 0 && onRetryFailed && (
            <button
              type="button"
              onClick={onRetryFailed}
              disabled={busy}
              className="w-full rounded-lg bg-nlm-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Retrying…' : `Retry ${failed} failed part${failed > 1 ? 's' : ''}`}
            </button>
          )}
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              disabled={busy}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50 ${
                allSucceeded
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'border border-nlm-border bg-white text-gray-800 hover:bg-gray-50'
              }`}
            >
              Done
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void copyRecentLogsToClipboard().then((ok) => {
                setLogCopied(ok);
                if (ok) setTimeout(() => setLogCopied(false), 2500);
              });
            }}
            className="text-xs text-gray-500 hover:text-gray-700 underline self-center"
          >
            {logCopied ? 'Logs copied!' : 'Copy debug log'}
          </button>
        </div>
      )}

      {!isDone && failed > 0 && (
        <button
          type="button"
          onClick={() => {
            void copyRecentLogsToClipboard().then((ok) => {
              setLogCopied(ok);
              if (ok) setTimeout(() => setLogCopied(false), 2500);
            });
          }}
          className="text-xs rounded border border-red-200 px-2 py-1 text-red-800 hover:bg-red-50"
        >
          {logCopied ? 'Logs copied!' : 'Copy debug log'}
        </button>
      )}
    </div>
  );
}
