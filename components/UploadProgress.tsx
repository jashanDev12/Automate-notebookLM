import type { UploadJob } from '../lib/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-500';
    case 'uploading':
      return 'bg-nlm-blue animate-pulse';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-gray-300';
  }
}

interface Props {
  job: UploadJob | null;
}

export function UploadProgress({ job }: Props) {
  if (!job) return null;

  if (job.phase === 'preparing' && job.prepProgress) {
    return (
      <div className="rounded-xl border border-nlm-border bg-white p-4 space-y-3">
        <p className="font-medium text-gray-800 truncate">{job.originalName}</p>
        <p className="text-xs text-gray-500">Preparing video locally…</p>
        <p className="text-sm text-gray-700">{job.prepProgress.message}</p>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-amber-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${job.prepProgress.percent}%` }}
          />
        </div>
        {job.prepProgress.part && job.prepProgress.totalParts && (
          <p className="text-xs text-gray-500">
            Part {job.prepProgress.part} of {job.prepProgress.totalParts}
          </p>
        )}
      </div>
    );
  }

  const completed = job.chunks.filter((c) => c.status === 'completed').length;
  const total = job.chunks.length;

  if (total === 0) return null;

  return (
    <div className="rounded-xl border border-nlm-border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-gray-800 truncate">{job.originalName}</p>
          <p className="text-xs text-gray-500">
            {completed}/{total} parts · {job.status}
          </p>
        </div>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className="bg-nlm-blue h-2 rounded-full transition-all duration-300"
          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
        />
      </div>

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
                        chunk.status === 'completed'
                          ? '100%'
                          : chunk.status === 'uploading'
                            ? `${pct}%`
                            : '0%',
                    }}
                  />
                </div>
                <span className="text-xs text-gray-500 w-16 text-right capitalize">
                  {chunk.status}
                </span>
              </div>
              {chunk.error && (
                <p className="text-xs text-red-600 mt-0.5">{chunk.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
