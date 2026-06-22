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

const GRPC_STATUS_MESSAGES: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

function extractStatusCode(errorInfo: unknown): { code: number; label: string } | null {
  if (!Array.isArray(errorInfo) || errorInfo.length !== 1) return null;
  const code = errorInfo[0];
  if (typeof code !== 'number' || !(code in GRPC_STATUS_MESSAGES)) return null;
  return { code, label: GRPC_STATUS_MESSAGES[code] };
}

function findWrbStatus(chunks: unknown[], rpcId: string): { code: number; label: string } | null {
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];
    for (const item of items) {
      if (!Array.isArray(item) || item.length < 6) continue;
      if (item[0] !== 'wrb.fr' || item[1] !== rpcId) continue;
      if (item[2] !== null) continue;
      const status = extractStatusCode(item[5]);
      if (status) return status;
    }
  }
  return null;
}

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

export interface DecodeResponseOptions {
  /** When true, return null for a present-but-empty wrb.fr frame instead of throwing. */
  allowNull?: boolean;
}

export function decodeResponse(
  raw: string,
  rpcId: string,
  options: DecodeResponseOptions = {},
): unknown {
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
    const foundIds = collectRpcIds(chunks);
    log.debug('Parsed RPC response chunks', {
      rpcId,
      chunkCount: chunks.length,
      foundIds,
    });

    const result = extractRpcResult(chunks, rpcId);
    if (result !== null) return result;

    if (foundIds.length > 0 && !foundIds.includes(rpcId)) {
      throw new RpcError(
        `No result for RPC ${rpcId}. Found IDs: ${foundIds.join(', ')}`,
        rpcId,
      );
    }
    if (foundIds.length === 0) {
      throw new RpcError(
        `No result for RPC ${rpcId} (response contained no RPC data)`,
        rpcId,
      );
    }

    if (options.allowNull) return null;

    const status = findWrbStatus(chunks, rpcId);
    if (status) {
      throw new RpcError(
        `RPC ${rpcId} returned null with status ${status.code} (${status.label})`,
        rpcId,
      );
    }
    throw new RpcError(
      `RPC ${rpcId} returned null result (possible parameter mismatch)`,
      rpcId,
    );
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

/** Unwrap JSON strings returned by batchexecute (sometimes double-encoded). */
function unwrapJsonPayload(value: unknown, maxDepth = 4): unknown {
  let current = value;
  for (let i = 0; i < maxDepth; i++) {
    if (typeof current !== 'string') break;
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Parse id envelope shapes from ADD_SOURCE / GET_NOTEBOOK rows. */
function extractIdFromEnvelope(rawId: unknown): string | null {
  if (isSourceId(rawId)) return rawId;
  if (!Array.isArray(rawId) || rawId.length === 0) return null;

  const first = rawId[0];
  if (isSourceId(first)) return first;
  if (Array.isArray(first) && isSourceId(first[0])) return first[0];

  const driveInner = rawId[2];
  if (Array.isArray(driveInner) && isSourceId(driveInner[0])) return driveInner[0];

  return null;
}

/**
 * Extract source id from ADD_SOURCE responses.
 * Handles flat, medium-nested, deeply-nested, and legacy simple shapes.
 */
export function extractAddSourceId(result: unknown): string | null {
  const data = unwrapJsonPayload(result);
  if (!Array.isArray(data) || data.length === 0) {
    return extractSourceId(unwrapJsonPayload(result));
  }

  // Legacy/simple: [["source-id"]] or ["source-id"]
  const simple = extractIdFromEnvelope(data[0]);
  if (simple) return simple;
  if (isSourceId(data[0])) return data[0];

  const outer = data[0];
  if (!Array.isArray(outer) || outer.length === 0) {
    return extractSourceId(data);
  }

  // Medium nested: [[[id], title, ...]]
  const medium = extractIdFromEnvelope(outer[0]);
  if (medium) return medium;

  const inner = outer[0];
  if (!Array.isArray(inner) || inner.length === 0) {
    return extractSourceId(data);
  }

  // Deeply nested: [[[[id], title, ...]]]
  const deep = extractIdFromEnvelope(inner[0]);
  if (deep) return deep;

  if (Array.isArray(inner[0])) {
    const fromEntry = extractIdFromEnvelope(inner[0]);
    if (fromEntry) return fromEntry;
  }

  return extractSourceId(data);
}

export function extractSourceId(result: unknown): string | null {
  const data = unwrapJsonPayload(result);
  const found: string[] = [];

  function walk(node: unknown, depth = 0): void {
    if (depth > 12 || node == null) return;
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

  walk(data);
  return found.length === 1 ? found[0] : found[0] ?? null;
}
