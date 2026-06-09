export const BASE_URL = 'https://notebooklm.google.com';
export const BATCHEXECUTE_URL = `${BASE_URL}/_/LabsTailwindUi/data/batchexecute`;
export const UPLOAD_URL = `${BASE_URL}/upload/_/`;

/** Maximum chunk size: strictly below 200MB. */
export const MAX_CHUNK_BYTES = 200 * 1024 * 1024 - 1;

/** Target size for video segments (margin below hard limit). */
export const TARGET_CHUNK_BYTES = 190 * 1024 * 1024;

/** Conservative target for stream-copy splits (keyframes often exceed average bitrate). */
export const TARGET_SPLIT_BYTES = 100 * 1024 * 1024;

/** Warn when source exceeds this size (browser memory). */
export const WARN_SOURCE_BYTES = 1024 * 1024 * 1024;

/** Block sources above this size. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

export const RPC_METHODS = {
  LIST_NOTEBOOKS: 'wXbhsf',
  GET_NOTEBOOK: 'rLM1Ne',
  ADD_SOURCE_FILE: 'o4cbdc',
  UPDATE_SOURCE: 'b7Wfje',
} as const;

/** Default wait for NotebookLM to finish processing an uploaded source. */
export const SOURCE_PROCESSING_TIMEOUT_MS = 180_000;

export const ALLOWED_COOKIE_DOMAINS = new Set([
  '.google.com',
  'google.com',
  '.notebooklm.google.com',
  'notebooklm.google.com',
  '.notebooklm.cloud.google.com',
  'notebooklm.cloud.google.com',
  'accounts.google.com',
  '.accounts.google.com',
  '.googleusercontent.com',
  'drive.google.com',
  '.drive.google.com',
]);

export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
]);

/** Video cannot be byte-split — each part must be a valid container file. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

export const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
