// import { BASE_URL, UPLOAD_URL } from './constants';
// import { createLogger, sessionLogContext } from './logger';
// import { registerFileSource } from './rpc';
// import { waitForSourceReady } from './source-status';
// import { tabProxyBlobUpload, tabProxyFetch } from './tab-proxy';
// import type { AuthSession } from './types';

// export type UploadPhase = 'uploading' | 'processing';

// export interface UploadFileChunkCallbacks {
//   onProgress?: (sent: number, total: number) => void;
//   onPhase?: (phase: UploadPhase) => void;
// }

// const log = createLogger('upload');

// function buildUploadStartBody(
//   notebookId: string,
//   filename: string,
//   sourceId: string,
// ): string {
//   return JSON.stringify({
//     PROJECT_ID: notebookId,
//     SOURCE_NAME: filename,
//     SOURCE_ID: sourceId,
//   });
// }

// export async function startResumableUpload(
//   session: AuthSession,
//   notebookId: string,
//   filename: string,
//   fileSize: number,
//   sourceId: string,
//   contentType: string,
// ): Promise<string> {
//   const uploadParams = new URLSearchParams();
//   if (session.authuser !== undefined && session.authuser !== '') {
//     uploadParams.set('authuser', session.authuser);
//   }
//   const url = uploadParams.toString()
//     ? `${UPLOAD_URL}?${uploadParams}`
//     : UPLOAD_URL;
//   const bodyText = buildUploadStartBody(notebookId, filename, sourceId);
//   const headers = {
//     Accept: '*/*',
//     'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
//     Origin: BASE_URL,
//     Referer: `${BASE_URL}/`,
//     ...(session.authuser !== undefined && session.authuser !== ''
//       ? { 'x-goog-authuser': session.authuser }
//       : {}),
//     'x-goog-upload-command': 'start',
//     'x-goog-upload-header-content-length': String(fileSize),
//     'x-goog-upload-header-content-type': contentType,
//     'x-goog-upload-protocol': 'resumable',
//   };

//   let uploadUrl: string | null = null;

//   if (session.tabId) {
//     const result = await tabProxyFetch(session.tabId, url, {
//       method: 'POST',
//       headers,
//       bodyText,
//     });
//     if (!result.ok) {
//       throw new Error(`Upload handshake failed (${result.status})`);
//     }
//     uploadUrl = result.headers['x-goog-upload-url'] ?? null;
//   } else {
//     const response = await fetch(url, {
//       method: 'POST',
//       headers: {
//         ...headers,
//         Cookie: session.cookieHeader,
//       },
//       body: bodyText,
//       credentials: 'omit',
//     });
//     if (!response.ok) {
//       throw new Error(`Upload handshake failed (${response.status})`);
//     }
//     uploadUrl = response.headers.get('x-goog-upload-url');
//   }

//   if (!uploadUrl) {
//     log.error('Upload handshake missing x-goog-upload-url', undefined, {
//       filename,
//       notebookId,
//       fileSize,
//     });
//     throw new Error('Missing x-goog-upload-url in upload handshake response');
//   }

//   log.info('Upload handshake ok', { filename, fileSize, sourceId });
//   return uploadUrl;
// }

// export async function uploadBlobResumable(
//   session: AuthSession,
//   uploadUrl: string,
//   blob: Blob,
//   onProgress?: (sent: number, total: number) => void,
// ): Promise<void> {
//   onProgress?.(0, blob.size);

//   const headers = {
//     Accept: '*/*',
//     'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
//     ...(session.authuser !== undefined && session.authuser !== ''
//       ? { 'x-goog-authuser': session.authuser }
//       : {}),
//     Origin: BASE_URL,
//     Referer: `${BASE_URL}/`,
//     'x-goog-upload-command': 'upload, finalize',
//     'x-goog-upload-offset': '0',
//   };

//   if (session.tabId) {
//     const result = await tabProxyBlobUpload(session.tabId, uploadUrl, headers, blob);
//     onProgress?.(blob.size, blob.size);
//     if (!result.ok) {
//       throw new Error(`Upload finalize failed (${result.status}): ${result.body.slice(0, 200)}`);
//     }
//     return;
//   }

//   const response = await fetch(uploadUrl, {
//     method: 'POST',
//     headers: {
//       ...headers,
//       Cookie: session.cookieHeader,
//     },
//     body: blob,
//     credentials: 'omit',
//   });

//   onProgress?.(blob.size, blob.size);

//   if (!response.ok) {
//     const text = await response.text().catch(() => '');
//     throw new Error(`Upload finalize failed (${response.status}): ${text.slice(0, 200)}`);
//   }
// }

// export async function uploadFileChunk(
//   session: AuthSession,
//   notebookId: string,
//   filename: string,
//   blob: Blob,
//   contentType: string,
//   callbacks?: UploadFileChunkCallbacks,
//   options?: { signal?: AbortSignal },
// ): Promise<string> {
//   log.info('uploadFileChunk start', {
//     filename,
//     bytes: blob.size,
//     contentType,
//     notebookId,
//     session: sessionLogContext(session),
//   });
//   callbacks?.onPhase?.('uploading');
//   const sourceId = await registerFileSource(session, notebookId, filename);
//   const uploadUrl = await startResumableUpload(
//     session,
//     notebookId,
//     filename,
//     blob.size,
//     sourceId,
//     contentType,
//   );
//   await uploadBlobResumable(session, uploadUrl, blob, callbacks?.onProgress);
//   log.info('Upload bytes complete — waiting for NotebookLM processing', { filename, sourceId });
//   callbacks?.onPhase?.('processing');
//   await waitForSourceReady(session, notebookId, sourceId, filename, {
//     signal: options?.signal,
//   });
//   log.info('uploadFileChunk complete', { filename, sourceId });
//   return sourceId;
// }
import { BASE_URL, UPLOAD_URL } from './constants';
import { createLogger, sessionLogContext } from './logger';
import { registerFileSource } from './rpc';
import {
  SourceStatus,
  waitForSourceReady,
  type SourcePollUpdate,
} from './source-status';
import { tabProxyBlobUpload, tabProxyFetch } from './tab-proxy';
import type { AuthSession } from './types';

export type UploadPhase =
  | 'registering'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'polling';

export interface UploadFileChunkCallbacks {
  onProgress?: (sent: number, total: number) => void;
  onPhase?: (phase: UploadPhase, detail?: string) => void;
}

/**
 * Per-part progress state for parallel uploads.
 * `partIndex` is 0-based.
 */
export interface MultiPartProgress {
  partIndex: number;
  phase: UploadPhase;
  sent: number;
  total: number;
  detail?: string;
}

const log = createLogger('upload');

export function pollPhaseFromUpdate(update: SourcePollUpdate): {
  phase: 'processing' | 'polling';
  detail: string;
} {
  const detail = `Check ${update.polls}`;
  if (!update.sourceVisible) {
    return { phase: 'polling', detail };
  }
  if (
    update.status === SourceStatus.PROCESSING ||
    update.status === SourceStatus.PREPARING
  ) {
    return { phase: 'processing', detail };
  }
  return { phase: 'polling', detail };
}

// ─── Single-chunk helpers (unchanged) ────────────────────────────────────────

function buildUploadStartBody(
  notebookId: string,
  filename: string,
  sourceId: string,
): string {
  return JSON.stringify({
    PROJECT_ID: notebookId,
    SOURCE_NAME: filename,
    SOURCE_ID: sourceId,
  });
}

export async function startResumableUpload(
  session: AuthSession,
  notebookId: string,
  filename: string,
  fileSize: number,
  sourceId: string,
  contentType: string,
): Promise<string> {
  const uploadParams = new URLSearchParams();
  if (session.authuser !== undefined && session.authuser !== '') {
    uploadParams.set('authuser', session.authuser);
  }
  const url = uploadParams.toString() ? `${UPLOAD_URL}?${uploadParams}` : UPLOAD_URL;
  const bodyText = buildUploadStartBody(notebookId, filename, sourceId);
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    ...(session.authuser !== undefined && session.authuser !== ''
      ? { 'x-goog-authuser': session.authuser }
      : {}),
    'x-goog-upload-command': 'start',
    'x-goog-upload-header-content-length': String(fileSize),
    'x-goog-upload-header-content-type': contentType,
    'x-goog-upload-protocol': 'resumable',
  };

  let uploadUrl: string | null = null;

  if (session.tabId) {
    const result = await tabProxyFetch(session.tabId, url, {
      method: 'POST',
      headers,
      bodyText,
    });
    if (!result.ok) throw new Error(`Upload handshake failed (${result.status})`);
    uploadUrl = result.headers['x-goog-upload-url'] ?? null;
  } else {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Cookie: session.cookieHeader },
      body: bodyText,
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Upload handshake failed (${response.status})`);
    uploadUrl = response.headers.get('x-goog-upload-url');
  }

  if (!uploadUrl) {
    log.error('Upload handshake missing x-goog-upload-url', undefined, {
      filename,
      notebookId,
      fileSize,
    });
    throw new Error('Missing x-goog-upload-url in upload handshake response');
  }

  log.info('Upload handshake ok', { filename, fileSize, sourceId });
  return uploadUrl;
}

export async function uploadBlobResumable(
  session: AuthSession,
  uploadUrl: string,
  blob: Blob,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  onProgress?.(0, blob.size);

  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    ...(session.authuser !== undefined && session.authuser !== ''
      ? { 'x-goog-authuser': session.authuser }
      : {}),
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'x-goog-upload-command': 'upload, finalize',
    'x-goog-upload-offset': '0',
  };

  if (session.tabId) {
    const result = await tabProxyBlobUpload(session.tabId, uploadUrl, headers, blob);
    onProgress?.(blob.size, blob.size);
    if (!result.ok) {
      throw new Error(`Upload finalize failed (${result.status}): ${result.body.slice(0, 200)}`);
    }
    return;
  }

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...headers, Cookie: session.cookieHeader },
    body: blob,
    credentials: 'omit',
  });

  onProgress?.(blob.size, blob.size);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload finalize failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Single chunk (original API, unchanged) ───────────────────────────────────

export async function uploadFileChunk(
  session: AuthSession,
  notebookId: string,
  filename: string,
  blob: Blob,
  contentType: string,
  callbacks?: UploadFileChunkCallbacks,
  options?: { signal?: AbortSignal },
): Promise<string> {
  log.info('uploadFileChunk start', {
    filename,
    bytes: blob.size,
    contentType,
    notebookId,
    session: sessionLogContext(session),
  });
  callbacks?.onPhase?.('registering');
  const sourceId = await registerFileSource(session, notebookId, filename);
  const uploadUrl = await startResumableUpload(
    session,
    notebookId,
    filename,
    blob.size,
    sourceId,
    contentType,
  );
  callbacks?.onPhase?.('uploading');
  await uploadBlobResumable(session, uploadUrl, blob, callbacks?.onProgress);
  log.info('Upload bytes complete — waiting for NotebookLM processing', { filename, sourceId });
  callbacks?.onPhase?.('uploaded');
  await waitForChunkProcessing(
    session,
    notebookId,
    sourceId,
    filename,
    blob.size,
    callbacks,
    options,
  );
  log.info('uploadFileChunk complete', { filename, sourceId });
  return sourceId;
}

/** Poll NotebookLM until an already-uploaded source is ready (no re-upload). */
export async function waitForChunkProcessing(
  session: AuthSession,
  notebookId: string,
  sourceId: string,
  filename: string,
  fileSizeBytes: number,
  callbacks?: UploadFileChunkCallbacks,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await waitForSourceReady(session, notebookId, sourceId, filename, {
    signal: options?.signal,
    fileSizeBytes,
    onPoll: (update) => {
      const { phase, detail } = pollPhaseFromUpdate(update);
      callbacks?.onPhase?.(phase, detail);
    },
  });
}

// ─── Parallel multi-part upload ───────────────────────────────────────────────

export interface FileChunkInput {
  blob: Blob;
  filename: string;
  contentType: string;
}

export interface UploadedPart {
  partIndex: number;
  filename: string;
  sourceId: string;
}

/**
 * How many parts to upload simultaneously.
 *
 * Browser limit is 6 connections per host; we use 3 to leave room for
 * status-polling and other extension requests running in parallel.
 */
const UPLOAD_CONCURRENCY = 3;

/**
 * Upload all parts in parallel (up to UPLOAD_CONCURRENCY at once), then
 * wait for ALL parts to finish processing in a single shared polling loop
 * instead of N separate polling loops.
 *
 * Timeline comparison
 * ───────────────────
 * Before (sequential):
 *   [register₁][upload₁][poll₁] → [register₂][upload₂][poll₂] → …
 *
 * After (parallel):
 *   [register₁][upload₁] ─┐
 *   [register₂][upload₂] ─┤ → [poll all simultaneously]
 *   [register₃][upload₃] ─┘
 *
 * For N parts this reduces wall-clock time from O(N) to O(1) (bounded by
 * the slowest part) for both the upload phase and the processing phase.
 */
export async function uploadFileChunksParallel(
  session: AuthSession,
  notebookId: string,
  chunks: FileChunkInput[],
  onPartProgress?: (progress: MultiPartProgress) => void,
  options?: { signal?: AbortSignal },
): Promise<UploadedPart[]> {
  if (chunks.length === 0) return [];

  // Single chunk — fall back to original path (no overhead)
  if (chunks.length === 1) {
    const { blob, filename, contentType } = chunks[0];
    const sourceId = await uploadFileChunk(
      session,
      notebookId,
      filename,
      blob,
      contentType,
      {
        onProgress: (sent, total) =>
          onPartProgress?.({ partIndex: 0, phase: 'uploading', sent, total }),
        onPhase: (phase, detail) =>
          onPartProgress?.({
            partIndex: 0,
            phase,
            sent: phase === 'uploading' ? 0 : blob.size,
            total: blob.size,
            detail,
          }),
      },
      options,
    );
    return [{ partIndex: 0, filename, sourceId }];
  }

  log.info('uploadFileChunksParallel start', {
    parts: chunks.length,
    concurrency: UPLOAD_CONCURRENCY,
    notebookId,
  });

  const totalStart = performance.now();

  // ── Phase 1: register + upload all parts in parallel ─────────────────────
  //
  // We use a simple semaphore so at most UPLOAD_CONCURRENCY uploads run at
  // the same time. Registration (RPC) is cheap (~700 ms) and can overlap
  // freely; the semaphore only gates the actual blob upload.

  let activeUploads = 0;
  const uploadQueue: Array<() => void> = [];

  function acquireUploadSlot(): Promise<void> {
    if (activeUploads < UPLOAD_CONCURRENCY) {
      activeUploads++;
      return Promise.resolve();
    }
    return new Promise((resolve) => uploadQueue.push(resolve));
  }

  function releaseUploadSlot(): void {
    const next = uploadQueue.shift();
    if (next) {
      next(); // hand the slot to the next waiter
    } else {
      activeUploads--;
    }
  }

  // Upload one part; returns its sourceId
  async function uploadOnePart(
    chunk: FileChunkInput,
    partIndex: number,
  ): Promise<{ partIndex: number; filename: string; sourceId: string }> {
    const { blob, filename, contentType } = chunk;

    onPartProgress?.({ partIndex, phase: 'registering', sent: 0, total: blob.size });

    const sourceId = await registerFileSource(session, notebookId, filename);

    const uploadUrl = await startResumableUpload(
      session,
      notebookId,
      filename,
      blob.size,
      sourceId,
      contentType,
    );

    // Acquire upload slot before sending bytes
    await acquireUploadSlot();

    options?.signal?.throwIfAborted();

    onPartProgress?.({ partIndex, phase: 'uploading', sent: 0, total: blob.size });

    try {
      await uploadBlobResumable(session, uploadUrl, blob, (sent, total) =>
        onPartProgress?.({ partIndex, phase: 'uploading', sent, total }),
      );
    } finally {
      releaseUploadSlot();
    }

    log.info('Part upload bytes done', { partIndex, filename, sourceId });
    onPartProgress?.({ partIndex, phase: 'uploaded', sent: blob.size, total: blob.size });

    return { partIndex, filename, sourceId };
  }

  // Kick off all uploads; failures are collected after Promise.allSettled
  const uploadResults = await Promise.allSettled(
    chunks.map((chunk, i) => uploadOnePart(chunk, i)),
  );

  // Surface any upload errors immediately
  const uploadErrors = uploadResults
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  if (uploadErrors.length > 0) {
    log.error('One or more part uploads failed', uploadErrors[0], {
      failedCount: uploadErrors.length,
      totalCount: chunks.length,
    });
    throw uploadErrors[0]; // throw first error; caller can retry individual parts
  }

  const uploaded = uploadResults.map(
    (r) => (r as PromiseFulfilledResult<UploadedPart>).value,
  );

  log.info('All parts uploaded, waiting for processing', {
    parts: uploaded.length,
    uploadMs: Math.round(performance.now() - totalStart),
  });

  // ── Phase 2: poll all source IDs simultaneously ───────────────────────────
  //
  // Instead of N serial waitForSourceReady calls (each with its own polling
  // interval), run them all in parallel via Promise.all. The shared event
  // loop means the polling intervals interleave naturally without fighting
  // over the tab-proxy connection.

  await Promise.all(
    uploaded.map(({ partIndex, sourceId, filename }) =>
      waitForSourceReady(session, notebookId, sourceId, filename, {
        signal: options?.signal,
        fileSizeBytes: chunks[partIndex]?.blob.size,
        onPoll: (update) => {
          const { phase, detail } = pollPhaseFromUpdate(update);
          onPartProgress?.({
            partIndex,
            phase,
            sent: chunks[partIndex]?.blob.size ?? 0,
            total: chunks[partIndex]?.blob.size ?? 0,
            detail,
          });
        },
      }),
    ),
  );

  log.info('uploadFileChunksParallel complete', {
    parts: uploaded.length,
    totalMs: Math.round(performance.now() - totalStart),
  });

  return uploaded;
}