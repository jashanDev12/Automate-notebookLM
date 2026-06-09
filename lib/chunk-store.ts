import { createLogger } from './logger';
import type { ChunkProgress, FileChunk, JobPhase, UploadJob, UploadJobStatus } from './types';

const log = createLogger('chunk-store');

const DB_NAME = 'nlm-mega-uploader';
const DB_VERSION = 1;
const META_STORE = 'jobMeta';
const CHUNK_STORE = 'chunks';

interface StoredJobRecord {
  id: string;
  originalName: string;
  notebookId: string;
  chunks: ChunkProgress[];
  status: UploadJobStatus;
  phase: JobPhase;
  retryingChunkIndex?: number;
  updatedAt: number;
}

interface StoredChunkRecord {
  jobId: string;
  index: number;
  filename: string;
  size: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: ['jobId', 'index'] });
        store.createIndex('byJobId', 'jobId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** If a retry was interrupted (panel closed), allow retry again from summary. */
export function normalizeStoredJob(job: UploadJob): UploadJob {
  if (job.phase !== 'retrying') return job;

  const idx = job.retryingChunkIndex;
  const chunks = job.chunks.map((chunk, i) => {
    if (
      i === idx &&
      (chunk.status === 'pending' ||
        chunk.status === 'registering' ||
        chunk.status === 'uploading' ||
        chunk.status === 'uploaded' ||
        chunk.status === 'processing' ||
        chunk.status === 'polling')
    ) {
      return {
        ...chunk,
        status: 'failed' as const,
        error:
          chunk.error ??
          (chunk.failureKind === 'processing_timeout'
            ? 'Resume interrupted — click Resume waiting again'
            : 'Retry interrupted — click Retry this part again'),
      };
    }
    return chunk;
  });

  const failed = chunks.filter((c) => c.status === 'failed').length;
  return {
    ...job,
    chunks,
    phase: 'done',
    retryingChunkIndex: undefined,
    status: failed > 0 ? 'failed' : 'completed',
  };
}

function jobFromRecord(record: StoredJobRecord): UploadJob {
  return normalizeStoredJob({
    id: record.id,
    originalName: record.originalName,
    notebookId: record.notebookId,
    chunks: record.chunks,
    status: record.status,
    phase: record.phase,
    retryingChunkIndex: record.retryingChunkIndex,
  });
}

function metaFromJob(job: UploadJob): StoredJobRecord {
  return {
    id: job.id,
    originalName: job.originalName,
    notebookId: job.notebookId,
    chunks: job.chunks,
    status: job.status,
    phase: job.phase,
    retryingChunkIndex: job.retryingChunkIndex,
    updatedAt: Date.now(),
  };
}

/** Persist prepared blobs + job metadata for retry across panel reloads. */
export async function saveStoredJob(job: UploadJob, chunks: FileChunk[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  tx.objectStore(META_STORE).put(metaFromJob(job));
  const chunkStore = tx.objectStore(CHUNK_STORE);
  for (const chunk of chunks) {
    chunkStore.put({
      jobId: job.id,
      index: chunk.index,
      filename: chunk.filename,
      size: chunk.size,
      blob: chunk.blob,
    } satisfies StoredChunkRecord);
  }
  await idbTxDone(tx);
  db.close();
  log.info('Saved job to local storage', {
    jobId: job.id,
    parts: chunks.length,
    bytes: chunks.reduce((sum, c) => sum + c.size, 0),
  });
}

/** Update job progress metadata (chunk statuses) without rewriting blobs. */
export async function updateStoredJob(job: UploadJob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put(metaFromJob(job));
  await idbTxDone(tx);
  db.close();
}

export async function loadStoredJob(
  jobId: string,
): Promise<{ job: UploadJob; chunks: FileChunk[] } | null> {
  const db = await openDb();
  const meta = await idbRequest<StoredJobRecord | undefined>(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(jobId),
  );
  if (!meta) {
    db.close();
    return null;
  }

  const chunkTx = db.transaction(CHUNK_STORE, 'readonly');
  const index = chunkTx.objectStore(CHUNK_STORE).index('byJobId');
  const stored = await idbRequest<StoredChunkRecord[]>(index.getAll(jobId));
  await idbTxDone(chunkTx);
  db.close();

  if (stored.length === 0) return null;

  const chunks: FileChunk[] = stored
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      index: row.index,
      filename: row.filename,
      size: row.size,
      blob: row.blob,
    }));

  const job = jobFromRecord(meta);
  if (meta.phase === 'retrying' && job.phase === 'done') {
    void updateStoredJob(job);
  }
  return { job, chunks };
}

export async function getLatestStoredJob(): Promise<{ job: UploadJob; chunks: FileChunk[] } | null> {
  const db = await openDb();
  const all = await idbRequest<StoredJobRecord[]>(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll(),
  );
  db.close();

  if (all.length === 0) return null;

  const latest = all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return loadStoredJob(latest.id);
}

export async function deleteStoredJob(jobId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  tx.objectStore(META_STORE).delete(jobId);

  const chunkStore = tx.objectStore(CHUNK_STORE);
  const index = chunkStore.index('byJobId');
  const rows = await idbRequest<StoredChunkRecord[]>(index.getAll(jobId));
  for (const row of rows) {
    chunkStore.delete([row.jobId, row.index]);
  }

  await idbTxDone(tx);
  db.close();
  log.info('Deleted stored job', { jobId, parts: rows.length });
}
