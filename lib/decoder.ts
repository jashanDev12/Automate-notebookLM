/**
 * Decode NotebookLM batchexecute responses (ported from notebooklm-py).
 */

import { createLogger, previewText } from './logger';

const log = createLogger('rpc-decode');

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly methodId?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function stripAntiXssi(response: string): string {
  if (response.startsWith(")]}'")) {
    const match = response.match(/^\)\]\}'\r?\n/);
    if (match) return response.slice(match[0].length);
  }
  return response;
}

export function parseChunkedResponse(response: string): unknown[] {
  if (!response.trim()) return [];

  const chunks: unknown[] = [];
  const lines = response
    .trim()
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    const byteCount = Number.parseInt(line, 10);
    if (!Number.isNaN(byteCount)) {
      i++;
      if (i >= lines.length) break;
      try {
        chunks.push(JSON.parse(lines[i]));
      } catch {
        // skip malformed chunk
      }
      i++;
      continue;
    }

    try {
      chunks.push(JSON.parse(line));
    } catch {
      // skip
    }
    i++;
  }

  return chunks;
}

function collectRpcIds(chunks: unknown[]): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];
    for (const item of items) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const tag = item[0];
      const id = item[1];
      if ((tag === 'wrb.fr' || tag === 'er') && typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
}

const SENTINEL_NO_RESULT = Symbol('no-result');

function extractRpcResult(chunks: unknown[], rpcId: string): unknown {
  let lastResult: unknown = SENTINEL_NO_RESULT;

  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];

    for (const item of items) {
      if (!Array.isArray(item) || item.length < 3) continue;
      const tag = item[0];
      const id = item[1];
      const resultData = item[2];

      if (tag === 'er' && id === rpcId) {
        throw new RpcError(`RPC error ${resultData ?? 'unknown'}`, rpcId);
      }

      if (tag !== 'wrb.fr' || id !== rpcId) continue;

      let parsed: unknown = resultData;
      if (typeof resultData === 'string') {
        try {
          parsed = JSON.parse(resultData);
        } catch {
          parsed = resultData;
        }
      }

      if (parsed !== null || lastResult === SENTINEL_NO_RESULT) {
        lastResult = parsed;
      }
    }
  }

  if (lastResult === SENTINEL_NO_RESULT) {
    const ids = collectRpcIds(chunks);
    throw new RpcError(
      `No result for RPC ${rpcId}. Found IDs: ${ids.join(', ') || 'none'}`,
      rpcId,
    );
  }

  return lastResult;
}

function parseJsonErrorBody(raw: string, rpcId: string): void {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return;
  try {
    const json = JSON.parse(trimmed) as { error?: { message?: string; code?: number } };
    if (json.error) {
      const msg = json.error.message ?? JSON.stringify(json.error);
      if (json.error.code === 400 && msg.toLowerCase().includes('token')) {
        throw new RpcError(
          'Session token expired. Refresh the NotebookLM tab (F5), then click Refresh here.',
          rpcId,
        );
      }
      throw new RpcError(`NotebookLM API error: ${msg}`, rpcId);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
  }
}

export function decodeResponse(raw: string, rpcId: string): unknown {
  const cleaned = stripAntiXssi(raw);

  try {
    parseJsonErrorBody(cleaned, rpcId);

    if (!cleaned.trim()) {
      throw new RpcError(
        'Empty response from NotebookLM. Refresh the NotebookLM tab (F5), then try again.',
        rpcId,
      );
    }

    const chunks = parseChunkedResponse(cleaned);
    log.debug('Parsed RPC response chunks', {
      rpcId,
      chunkCount: chunks.length,
      foundIds: collectRpcIds(chunks),
    });
    return extractRpcResult(chunks, rpcId);
  } catch (err) {
    const chunks = parseChunkedResponse(cleaned);
    log.error('Failed to decode batchexecute response', err, {
      rpcId,
      responseLen: raw.length,
      responsePreview: previewText(raw),
      foundIds: collectRpcIds(chunks),
      chunkCount: chunks.length,
    });
    throw err;
  }
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function extractSourceId(result: unknown): string | null {
  const found: string[] = [];

  function walk(node: unknown, depth = 0): void {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string' && UUID_RE.test(node)) {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        walk(value, depth + 1);
      }
    }
  }

  walk(result);
  return found.length === 1 ? found[0] : found[0] ?? null;
}
