import { BASE_URL, UPLOAD_URL } from './constants';
import { registerFileSource } from './rpc';
import type { AuthSession } from './types';

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
  const url = `${UPLOAD_URL}?authuser=${session.authuser}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'x-goog-authuser': session.authuser,
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(fileSize),
      'x-goog-upload-header-content-type': contentType,
      'x-goog-upload-protocol': 'resumable',
      Cookie: session.cookieHeader,
    },
    body: buildUploadStartBody(notebookId, filename, sourceId),
    credentials: 'omit',
  });

  if (!response.ok) {
    throw new Error(`Upload handshake failed (${response.status})`);
  }

  const uploadUrl = response.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Missing x-goog-upload-url in upload handshake response');
  }

  return uploadUrl;
}

export async function uploadBlobResumable(
  session: AuthSession,
  uploadUrl: string,
  blob: Blob,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  onProgress?.(0, blob.size);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-goog-authuser': session.authuser,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
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
  onProgress?: (sent: number, total: number) => void,
): Promise<string> {
  const sourceId = await registerFileSource(session, notebookId, filename);
  const uploadUrl = await startResumableUpload(
    session,
    notebookId,
    filename,
    blob.size,
    sourceId,
    contentType,
  );
  await uploadBlobResumable(session, uploadUrl, blob, onProgress);
  return sourceId;
}
