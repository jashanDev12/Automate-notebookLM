export interface Notebook {
  id: string;
  title: string;
}

export interface FileChunk {
  index: number;
  blob: Blob;
  filename: string;
  size: number;
}

/** Why a chunk failed — drives retry behavior (poll-only vs re-upload). */
export type ChunkFailureKind = 'upload' | 'processing_timeout' | 'processing' | 'cancelled';

export type ChunkStatus =
  | 'pending'
  | 'registering'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'polling'
  | 'completed'
  | 'failed';

export type VideoPrepMode = 'compress' | 'split';

export type JobPhase = 'idle' | 'preparing' | 'uploading' | 'retrying' | 'done';

export interface PrepProgress {
  message: string;
  percent: number;
  part?: number;
  totalParts?: number;
}

export interface ChunkProgress {
  index: number;
  filename: string;
  size: number;
  status: ChunkStatus;
  bytesSent: number;
  /** Extra context for polling/processing (e.g. poll count). */
  statusDetail?: string;
  error?: string;
  sourceId?: string;
  /** Set when status is failed — avoids re-uploading after a processing timeout. */
  failureKind?: ChunkFailureKind;
}

export type UploadJobStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface UploadJob {
  id: string;
  originalName: string;
  notebookId: string;
  chunks: ChunkProgress[];
  status: UploadJobStatus;
  phase: JobPhase;
  prepProgress?: PrepProgress;
  /** Set while a single failed part is being retried. */
  retryingChunkIndex?: number;
}

export interface AuthSession {
  csrfToken: string;
  sessionId: string;
  authuser?: string;
  cookieHeader: string;
  /** API calls run inside this signed-in NotebookLM tab (session cookies not readable). */
  tabId?: number;
}

export type UploadProgressCallback = (job: UploadJob) => void;

export interface EnqueueOptions {
  videoPrepMode?: VideoPrepMode;
  signal?: AbortSignal;
}
