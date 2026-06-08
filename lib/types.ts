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

export type ChunkStatus = 'pending' | 'uploading' | 'completed' | 'failed';

export type VideoPrepMode = 'compress' | 'split';

export type JobPhase = 'idle' | 'preparing' | 'uploading';

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
  error?: string;
  sourceId?: string;
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
}

export interface AuthSession {
  csrfToken: string;
  sessionId: string;
  authuser: string;
  cookieHeader: string;
}

export type UploadProgressCallback = (job: UploadJob) => void;

export interface EnqueueOptions {
  videoPrepMode?: VideoPrepMode;
  signal?: AbortSignal;
}
