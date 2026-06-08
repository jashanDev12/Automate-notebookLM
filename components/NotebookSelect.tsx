import type { Notebook } from '../lib/types';

interface Props {
  notebooks: Notebook[];
  value: string;
  loading: boolean;
  onChange: (notebookId: string) => void;
  onRefresh: () => void;
}

export function NotebookSelect({ notebooks, value, loading, onChange, onRefresh }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">Target Notebook</label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs text-nlm-blue hover:underline disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || notebooks.length === 0}
        className="w-full rounded-lg border border-nlm-border bg-white px-3 py-2 text-sm focus:border-nlm-blue focus:outline-none focus:ring-1 focus:ring-nlm-blue"
      >
        <option value="">
          {loading ? 'Loading notebooks…' : 'Select a notebook'}
        </option>
        {notebooks.map((nb) => (
          <option key={nb.id} value={nb.id}>
            {nb.title}
          </option>
        ))}
      </select>
    </div>
  );
}
