import { fetchAuthSession } from './auth';
import { extractAddSourceId, extractSourceId, RpcError } from './decoder';
import { createLogger } from './logger';
import { registerTextSource, registerUrlSource } from './rpc';
import { waitForSourceIdByUrl, waitForSourceReady } from './source-status';
import type { AuthSession } from './types';
import { isYouTubeUrl, validateImportUrl } from './url-import';

const log = createLogger('import-url');

const URL_IMPORT_TIMEOUT_MS = 120_000;
const TEXT_IMPORT_TIMEOUT_MS = 180_000;
const SOURCE_LOOKUP_TIMEOUT_MS = 90_000;

export interface ImportUrlResult {
  sourceId: string;
}

export interface ImportUrlOptions {
  session?: AuthSession;
  signal?: AbortSignal;
  title?: string;
  onStatus?: (status: 'registering' | 'processing' | 'done') => void;
}

function sourceIdFromAddResult(result: unknown): string | null {
  return extractAddSourceId(result) ?? extractSourceId(result);
}

async function resolveSourceIdAfterAdd(
  session: AuthSession,
  notebookId: string,
  url: string,
  title: string | undefined,
): Promise<string> {
  const result = await registerUrlSource(session, notebookId, url, {
    youtube: isYouTubeUrl(url),
    title,
  });

  const direct = sourceIdFromAddResult(result);
  if (direct) return direct;

  log.warn('ADD_SOURCE response missing source id — polling notebook sources', {
    url: url.slice(0, 120),
    hasTitle: Boolean(title),
  });

  return waitForSourceIdByUrl(session, notebookId, url, {
    title,
    timeoutMs: SOURCE_LOOKUP_TIMEOUT_MS,
  });
}

async function resolveTextSourceIdAfterAdd(
  session: AuthSession,
  notebookId: string,
  title: string,
  content: string,
): Promise<string> {
  const result = await registerTextSource(session, notebookId, title, content);

  const direct = sourceIdFromAddResult(result);
  if (direct) return direct;

  log.warn('ADD_SOURCE text response missing source id — polling notebook sources by title', {
    title: title.slice(0, 80),
  });

  return waitForSourceIdByUrl(session, notebookId, '', {
    title,
    timeoutMs: SOURCE_LOOKUP_TIMEOUT_MS,
  });
}

export async function importUrlToNotebook(
  notebookId: string,
  url: string,
  options: ImportUrlOptions = {},
): Promise<ImportUrlResult> {
  validateImportUrl(url);
  const session = options.session ?? (await fetchAuthSession());
  const label = options.title?.trim() || new URL(url).hostname;

  options.onStatus?.('registering');
  log.info('Importing URL to notebook', { notebookId, url: url.slice(0, 120), title: label });

  let sourceId: string;
  try {
    sourceId = await resolveSourceIdAfterAdd(session, notebookId, url, options.title);
  } catch (err) {
    if (err instanceof RpcError && err.methodId) {
      throw new RpcError(`Failed to extract source ID for ${label}`, err.methodId);
    }
    throw err;
  }

  options.onStatus?.('processing');
  await waitForSourceReady(session, notebookId, sourceId, label, {
    timeoutMs: URL_IMPORT_TIMEOUT_MS,
    signal: options.signal,
  });

  options.onStatus?.('done');
  log.info('URL import complete', { sourceId, notebookId });
  return { sourceId };
}

export async function importTextToNotebook(
  notebookId: string,
  title: string,
  content: string,
  options: ImportUrlOptions = {},
): Promise<ImportUrlResult> {
  if (!content.trim()) {
    throw new Error('No text content found on this page.');
  }

  const session = options.session ?? (await fetchAuthSession());
  const safeTitle = title.trim().slice(0, 200) || 'Imported page';

  options.onStatus?.('registering');
  log.info('Importing text to notebook', { notebookId, title: safeTitle, contentLen: content.length });

  const sourceId = await resolveTextSourceIdAfterAdd(session, notebookId, safeTitle, content);

  options.onStatus?.('processing');
  await waitForSourceReady(session, notebookId, sourceId, safeTitle, {
    timeoutMs: TEXT_IMPORT_TIMEOUT_MS,
    signal: options.signal,
  });

  options.onStatus?.('done');
  log.info('Text import complete', { sourceId, notebookId });
  return { sourceId };
}
