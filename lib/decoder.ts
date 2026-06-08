/**
 * Decode NotebookLM batchexecute responses (ported from notebooklm-py).
 */

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
    for (const item of chunk) {
      if (Array.isArray(item) && typeof item[0] === 'string' && item[0].startsWith('wrb.fr')) {
        const data = item[1];
        if (Array.isArray(data) && typeof data[1] === 'string') {
          ids.push(data[1]);
        }
      }
    }
  }
  return ids;
}

function extractRpcResult(chunks: unknown[], rpcId: string): unknown {
  let lastResult: unknown = undefined;
  let found = false;

  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
      const data = item[1];
      if (!Array.isArray(data) || data.length < 3) continue;
      const id = data[1];
      const resultData = data[2];
      if (id !== rpcId) continue;
      found = true;

      if (typeof resultData === 'string') {
        try {
          lastResult = JSON.parse(resultData);
        } catch {
          lastResult = resultData;
        }
      } else {
        lastResult = resultData;
      }
    }
  }

  if (!found) {
    const ids = collectRpcIds(chunks);
    throw new RpcError(
      `No result for RPC ${rpcId}. Found IDs: ${ids.join(', ') || 'none'}`,
      rpcId,
    );
  }

  return lastResult;
}

export function decodeResponse(raw: string, rpcId: string): unknown {
  const cleaned = stripAntiXssi(raw);
  const chunks = parseChunkedResponse(cleaned);
  return extractRpcResult(chunks, rpcId);
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
