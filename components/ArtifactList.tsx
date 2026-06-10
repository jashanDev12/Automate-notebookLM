import { useEffect, useState } from 'react';
import type { Artifact, AuthSession } from '../lib/types';
import { listArtifacts } from '../lib/rpc';
import { exportArtifact } from '../lib/artifacts';
import { fetchAuthSession } from '../lib/auth';
import { createLogger } from '../lib/logger';

const log = createLogger('ui-artifacts');

interface Props {
  notebookId: string;
}

export function ArtifactList({ notebookId }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const loadArtifacts = async () => {
    if (!notebookId) return;
    setLoading(true);
    setError(null);
    try {
      const session = await fetchAuthSession();
      const list = await listArtifacts(session, notebookId);
      // Filter for exportable types
      const exportable = list.filter(a => ['quiz', 'flashcards', 'mind_map'].includes(a.type));
      setArtifacts(exportable);
    } catch (err) {
      log.error('Failed to load artifacts', err);
      setError('Failed to load artifacts. Make sure you are connected.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadArtifacts();
  }, [notebookId]);

  const handleExport = async (artifact: Artifact, format: 'json' | 'markdown' | 'html') => {
    setExportingId(artifact.id);
    try {
      const session = await fetchAuthSession();
      const { content, filename, mimeType } = await exportArtifact(session, notebookId, artifact, format);
      
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      log.info('Artifact exported successfully', { id: artifact.id, filename });
    } catch (err) {
      log.error('Export failed', err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingId(null);
    }
  };

  if (!notebookId) {
    return (
      <div className="text-center py-8 text-sm text-gray-500 italic">
        Select a notebook to see exportable artifacts
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Exportable Artifacts</h3>
        <button
          type="button"
          onClick={loadArtifacts}
          disabled={loading}
          className="text-xs text-nlm-blue hover:underline disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-100">
          {error}
        </div>
      )}

      {loading && artifacts.length === 0 && (
        <div className="text-center py-4 text-sm text-gray-400">Loading artifacts…</div>
      )}

      {!loading && artifacts.length === 0 && !error && (
        <div className="text-center py-6 text-sm text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No quizzes, flashcards, or mind maps found in this notebook.
        </div>
      )}

      <div className="space-y-2">
        {artifacts.map((art) => (
          <div key={art.id} className="rounded-lg border border-nlm-border bg-white p-3 space-y-2">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm font-medium text-gray-900 truncate max-w-[180px]" title={art.title}>
                  {art.title}
                </p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
                  {art.type.replace('_', ' ')}
                </p>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${art.status === 3 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                {art.status === 3 ? 'Ready' : 'Processing'}
              </span>
            </div>

            <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-50 mt-2">
              {art.type === 'mind_map' ? (
                <button
                  onClick={() => handleExport(art, 'json')}
                  disabled={exportingId === art.id || art.status !== 3}
                  className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                >
                  {exportingId === art.id ? 'Exporting…' : 'Export JSON'}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => handleExport(art, 'json')}
                    disabled={exportingId === art.id || art.status !== 3}
                    className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                  >
                    JSON
                  </button>
                  <button
                    onClick={() => handleExport(art, 'markdown')}
                    disabled={exportingId === art.id || art.status !== 3}
                    className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                  >
                    Markdown
                  </button>
                  <button
                    onClick={() => handleExport(art, 'html')}
                    disabled={exportingId === art.id || art.status !== 3}
                    className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                  >
                    HTML
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
