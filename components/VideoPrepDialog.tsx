import type { VideoPrepMode } from '../lib/types';

interface Props {
  open: boolean;
  fileName: string;
  fileSizeMb: number;
  onChoose: (mode: VideoPrepMode) => void;
  onCancel: () => void;
}

export function VideoPrepDialog({ open, fileName, fileSizeMb, onChoose, onCancel }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-lg border border-nlm-border p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Video over 200 MB</h2>
          <p className="text-sm text-gray-600 mt-1 truncate" title={fileName}>
            {fileName} ({fileSizeMb.toFixed(0)} MB)
          </p>
          <p className="text-sm text-gray-500 mt-2">
            Choose how to prepare this video before upload. All processing stays on your device.
          </p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => onChoose('split')}
            className="w-full text-left rounded-lg border border-nlm-border p-3 hover:border-nlm-blue hover:bg-blue-50 transition-colors"
          >
            <p className="font-medium text-gray-900">Split into parts</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Faster — creates valid MP4 parts under 200 MB each (_Part1, _Part2, …)
            </p>
          </button>
          <button
            type="button"
            onClick={() => onChoose('compress')}
            className="w-full text-left rounded-lg border border-nlm-border p-3 hover:border-nlm-blue hover:bg-blue-50 transition-colors"
          >
            <p className="font-medium text-gray-900">Compress to one file</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Slower — re-encodes to a single source under 200 MB in NotebookLM
            </p>
          </button>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-lg border border-nlm-border py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
