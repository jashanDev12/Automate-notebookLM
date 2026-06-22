import {
  RPC_METHODS,
  SOURCE_PROCESSING_TIMEOUT_MS,
  computeSourceProcessingTimeoutMs,
} from './constants';
import { RpcError } from './decoder';
import { createLogger } from './logger';
import { rpcCall } from './rpc';
import type { AuthSession } from './types';

const log = createLogger('source-status');

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** NotebookLM source processing status (wire codes from GET_NOTEBOOK source[3][1]). */
export enum SourceStatus {
  PROCESSING = 1,
  READY = 2,
  ERROR = 3,
  PREPARING = 5,
}

export interface NotebookSource {
  id: string;
  title: string;
  status: SourceStatus;
  typeCode: number | null;
}

export class SourceProcessingError extends Error {
  constructor(
    message: string,
    public readonly sourceId: string,
    public readonly status: SourceStatus,
  ) {
    super(message);
    this.name = 'SourceProcessingError';
  }
}

export class SourceProcessingTimeoutError extends Error {
  constructor(
    message: string,
    public readonly sourceId: string,
    public readonly lastStatus: SourceStatus | null,
  ) {
    super(message);
    this.name = 'SourceProcessingTimeoutError';
  }
}

/** Types where status=ERROR can be transient during transcription/classification. */
const TRANSIENT_ERROR_TYPES = new Set<number | null>([10, 0, null]);

function parseStatusCode(raw: unknown): SourceStatus {
  if (raw === SourceStatus.PROCESSING) return SourceStatus.PROCESSING;
  if (raw === SourceStatus.READY) return SourceStatus.READY;
  if (raw === SourceStatus.ERROR) return SourceStatus.ERROR;
  if (raw === SourceStatus.PREPARING) return SourceStatus.PREPARING;
  return SourceStatus.READY;
}

function extractIdFromRow(raw: unknown[]): string | null {
  const idBlock = raw[0];
  if (typeof idBlock === 'string' && UUID_RE.test(idBlock)) return idBlock;
  if (Array.isArray(idBlock)) {
    if (typeof idBlock[0] === 'string' && UUID_RE.test(idBlock[0])) return idBlock[0];
    if (Array.isArray(idBlock[2]) && typeof idBlock[2][0] === 'string' && UUID_RE.test(idBlock[2][0])) {
      return idBlock[2][0];
    }
  }
  return null;
}

function parseSourceRow(raw: unknown): NotebookSource | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const id = extractIdFromRow(raw);
  if (!id) return null;

  const title = typeof raw[1] === 'string' ? raw[1] : '';

  let status = SourceStatus.READY;
  if (Array.isArray(raw[3]) && raw[3].length > 1) {
    status = parseStatusCode(raw[3][1]);
  }

  let typeCode: number | null = null;
  if (Array.isArray(raw[2]) && raw[2].length > 4 && typeof raw[2][4] === 'number') {
    typeCode = raw[2][4];
  }

  return { id, title, status, typeCode };
}

function extractUrlFromSourceRow(raw: unknown[]): string | null {
  const meta = raw[2];
  if (!Array.isArray(meta)) return null;
  if (Array.isArray(meta[7]) && typeof meta[7][0] === 'string') return meta[7][0];
  if (Array.isArray(meta[5]) && typeof meta[5][0] === 'string') return meta[5][0];
  if (typeof meta[0] === 'string' && meta[0].startsWith('http')) return meta[0];
  return null;
}

function normalizeImportUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const normalized = parsed.href;
    return normalized.endsWith('/') && parsed.pathname !== '/'
      ? normalized.slice(0, -1)
      : normalized;
  } catch {
    return url;
  }
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./i, '');
}

function urlsRoughlyMatch(a: string, b: string): boolean {
  const na = normalizeImportUrl(a);
  const nb = normalizeImportUrl(b);
  if (na === nb) return true;
  try {
    const ua = new URL(na);
    const ub = new URL(nb);
    if (stripWww(ua.hostname) !== stripWww(ub.hostname)) return false;
    const pathA = ua.pathname.replace(/\/$/, '') || '/';
    const pathB = ub.pathname.replace(/\/$/, '') || '/';
    return pathA === pathB && ua.protocol === ub.protocol;
  } catch {
    return false;
  }
}

function titlesRoughlyMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const prefixLen = Math.min(na.length, nb.length, 48);
  return na.slice(0, prefixLen) === nb.slice(0, prefixLen);
}

function collectUrlsFromMetadata(meta: unknown): string[] {
  const urls: string[] = [];
  function walk(node: unknown, depth = 0): void {
    if (depth > 10 || node == null) return;
    if (typeof node === 'string' && node.startsWith('http')) {
      urls.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    }
  }
  walk(meta);
  return urls;
}

export async function findSourceIdByUrl(
  session: AuthSession,
  notebookId: string,
  url: string,
  title?: string,
): Promise<string | null> {
  const target = normalizeImportUrl(url);
  const params = [notebookId, null, [2], null, 0];
  const result = await rpcCall(
    session,
    RPC_METHODS.GET_NOTEBOOK,
    params,
    `/notebook/${notebookId}`,
  );
  const sourcesList = extractSourcesList(result);
  for (const row of sourcesList) {
    if (!Array.isArray(row)) continue;

    const rowUrl = extractUrlFromSourceRow(row);
    const candidateUrls = rowUrl
      ? [rowUrl, ...collectUrlsFromMetadata(row[2])]
      : collectUrlsFromMetadata(row[2]);
    if (candidateUrls.some((candidate) => urlsRoughlyMatch(candidate, target))) {
      const id = extractIdFromRow(row);
      if (id) return id;
    }

    if (title && typeof row[1] === 'string' && titlesRoughlyMatch(title, row[1])) {
      const id = extractIdFromRow(row);
      if (id) return id;
    }
  }
  return null;
}

export interface WaitForSourceByUrlOptions {
  title?: string;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Poll GET_NOTEBOOK until a newly added URL (or title) source appears. */
export async function waitForSourceIdByUrl(
  session: AuthSession,
  notebookId: string,
  url: string,
  options: WaitForSourceByUrlOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const sourceId = await findSourceIdByUrl(session, notebookId, url, options.title);
    if (sourceId) {
      log.info('Source located after ADD_SOURCE poll', {
        attempt,
        sourceId,
        url: url.slice(0, 80),
      });
      return sourceId;
    }
    await sleep(intervalMs, options.signal);
  }

  throw new RpcError(
    `Source did not appear in notebook within ${Math.round(timeoutMs / 1000)}s`,
    RPC_METHODS.ADD_SOURCE,
  );
}

function extractSourcesList(notebook: unknown): unknown[] {
  if (!Array.isArray(notebook) || notebook.length === 0) {
    throw new RpcError('Empty notebook response when listing sources', RPC_METHODS.GET_NOTEBOOK);
  }

  const nbInfo = notebook[0];
  if (!Array.isArray(nbInfo) || nbInfo.length <= 1) {
    throw new RpcError('Unexpected notebook structure when listing sources', RPC_METHODS.GET_NOTEBOOK);
  }

  const sourcesList = nbInfo[1];
  if (sourcesList == null) return [];
  if (!Array.isArray(sourcesList)) {
    throw new RpcError('Sources data is not a list', RPC_METHODS.GET_NOTEBOOK);
  }
  return sourcesList;
}

export async function listNotebookSources(
  session: AuthSession,
  notebookId: string,
): Promise<NotebookSource[]> {
  const params = [notebookId, null, [2], null, 0];
  const result = await rpcCall(
    session,
    RPC_METHODS.GET_NOTEBOOK,
    params,
    `/notebook/${notebookId}`,
  );

  const sourcesList = extractSourcesList(result);
  const sources: NotebookSource[] = [];
  for (const row of sourcesList) {
    const parsed = parseSourceRow(row);
    if (parsed) sources.push(parsed);
  }
  return sources;
}

export async function getNotebookSource(
  session: AuthSession,
  notebookId: string,
  sourceId: string,
): Promise<NotebookSource | null> {
  const sources = await listNotebookSources(session, notebookId);
  return sources.find((s) => s.id === sourceId) ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface SourcePollUpdate {
  polls: number;
  /** True when GET_NOTEBOOK returned a row for this sourceId. */
  sourceVisible: boolean;
  status: SourceStatus | null;
}

export interface WaitForSourceOptions {
  timeoutMs?: number;
  /** When set, timeout defaults to a size-based value if timeoutMs is omitted. */
  fileSizeBytes?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoffFactor?: number;
  signal?: AbortSignal;
  /** Called after each status check while waiting for NotebookLM. */
  onPoll?: (update: SourcePollUpdate) => void;
}

/**
 * Poll GET_NOTEBOOK until the source is ready or reports a terminal error.
 * HTTP upload success only means bytes were stored — this confirms NotebookLM processing.
 */
export async function waitForSourceReady(
  session: AuthSession,
  notebookId: string,
  sourceId: string,
  filename: string,
  options: WaitForSourceOptions = {},
): Promise<NotebookSource> {
  const timeoutMs =
    options.timeoutMs ??
    (options.fileSizeBytes != null
      ? computeSourceProcessingTimeoutMs(options.fileSizeBytes)
      : SOURCE_PROCESSING_TIMEOUT_MS);
  const initialIntervalMs = options.initialIntervalMs ?? 1000;
  const maxIntervalMs = options.maxIntervalMs ?? 10_000;
  const backoffFactor = options.backoffFactor ?? 1.5;
  const signal = options.signal;

  const deadline = Date.now() + timeoutMs;
  let interval = initialIntervalMs;
  let lastStatus: SourceStatus | null = null;
  let polls = 0;

  log.info('Waiting for NotebookLM processing', { sourceId, filename, timeoutMs });

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() >= deadline) {
      throw new SourceProcessingTimeoutError(
        `NotebookLM did not finish processing "${filename}" within ${Math.round(timeoutMs / 1000)}s` +
          (lastStatus != null ? ` (last status: ${lastStatus})` : ''),
        sourceId,
        lastStatus,
      );
    }

    polls++;
    const source = await getNotebookSource(session, notebookId, sourceId);

    if (!source) {
      log.debug('Source not yet visible in notebook list', { sourceId, polls });
      options.onPoll?.({ polls, sourceVisible: false, status: null });
    } else {
      lastStatus = source.status;
      options.onPoll?.({ polls, sourceVisible: true, status: source.status });

      if (source.status === SourceStatus.READY) {
        log.info('Source processing complete', { sourceId, filename, polls });
        return source;
      }

      if (source.status === SourceStatus.ERROR) {
        if (TRANSIENT_ERROR_TYPES.has(source.typeCode)) {
          log.debug('Transient ERROR for media source — continuing poll', {
            sourceId,
            typeCode: source.typeCode,
          });
        } else {
          throw new SourceProcessingError(
            `NotebookLM failed to process "${filename}"`,
            sourceId,
            source.status,
          );
        }
      }
    }

    const remaining = deadline - Date.now();
    const sleepMs = Math.min(interval, remaining);
    if (sleepMs > 0) {
      await sleep(sleepMs, signal);
    }
    interval = Math.min(interval * backoffFactor, maxIntervalMs);
  }
}
