import { BASE_URL, UPLOAD_URL } from './constants';
import { createLogger, sessionLogContext } from './logger';
import { registerFileSource } from './rpc';
import { waitForSourceReady } from './source-status';
import { tabProxyBlobUpload, tabProxyFetch } from './tab-proxy';
import type { AuthSession } from './types';

export type UploadPhase = 'uploading' | 'processing';

export interface UploadFileChunkCallbacks {
  onProgress?: (sent: number, total: number) => void;
  onPhase?: (phase: UploadPhase) => void;
}

const log = createLogger('upload');

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
  const url = uploadParams.toString()
    ? `${UPLOAD_URL}?${uploadParams}`
    : UPLOAD_URL;
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
    if (!result.ok) {
      throw new Error(`Upload handshake failed (${result.status})`);
    }
    uploadUrl = result.headers['x-goog-upload-url'] ?? null;
  } else {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        Cookie: session.cookieHeader,
      },
      body: bodyText,
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`Upload handshake failed (${response.status})`);
    }
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
    headers: {
      ...headers,
      Cookie: session.cookieHeader,
    },
    body: blob,
    credentials: 'omit',
  });

  onProgress?.(blob.size, blob.size);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload finalize failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

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
  callbacks?.onPhase?.('uploading');
  const sourceId = await registerFileSource(session, notebookId, filename);
  const uploadUrl = await startResumableUpload(
    session,
    notebookId,
    filename,
    blob.size,
    sourceId,
    contentType,
  );
  await uploadBlobResumable(session, uploadUrl, blob, callbacks?.onProgress);
  log.info('Upload bytes complete — waiting for NotebookLM processing', { filename, sourceId });
  callbacks?.onPhase?.('processing');
  await waitForSourceReady(session, notebookId, sourceId, filename, {
    signal: options?.signal,
  });
  log.info('uploadFileChunk complete', { filename, sourceId });
  return sourceId;
}
