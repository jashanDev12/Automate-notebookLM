// import { BATCHEXECUTE_URL, RPC_METHODS } from './constants';
// import { decodeResponse, extractSourceId, RpcError } from './decoder';
// import { createLogger, previewText, sessionLogContext } from './logger';
// import { readTabSession } from './tab-session';
// import { tabProxyFetch } from './tab-proxy';
// import type { AuthSession, Notebook, Artifact } from './types';

// const log = createLogger('rpc');

// function encodeRpcRequest(rpcId: string, params: unknown[]): unknown[][][] {
//   const paramsJson = JSON.stringify(params);
//   return [[[rpcId, paramsJson, null, 'generic']]];
// }

// function buildRequestBody(rpcRequest: unknown[][][], csrfToken: string): string {
//   const fReq = JSON.stringify(rpcRequest);
//   return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(csrfToken)}&`;
// }

// function buildRpcUrl(
//   rpcId: string,
//   session: AuthSession,
//   sourcePath = '/',
// ): string {
//   const params = new URLSearchParams({
//     rpcids: rpcId,
//     'source-path': sourcePath,
//     'f.sid': session.sessionId,
//     hl: 'en',
//     rt: 'c',
//   });
//   if (session.authuser !== undefined && session.authuser !== '') {
//     params.set('authuser', session.authuser);
//   }
//   return `${BATCHEXECUTE_URL}?${params}`;
// }

// async function withFreshTabSession(session: AuthSession): Promise<AuthSession> {
//   if (!session.tabId) return session;
//   log.debug('Refreshing session tokens from tab', { tabId: session.tabId });
//   const fresh = await readTabSession(session.tabId);
//   return {
//     ...session,
//     csrfToken: fresh.csrfToken,
//     sessionId: fresh.sessionId,
//     authuser: fresh.authuser,
//   };
// }

// export async function rpcCall(
//   session: AuthSession,
//   rpcId: string,
//   params: unknown[],
//   sourcePath = '/',
// ): Promise<unknown> {
//   const started = performance.now();
//   const liveSession = await withFreshTabSession(session);
//   const url = buildRpcUrl(rpcId, liveSession, sourcePath);
//   const bodyText = buildRequestBody(encodeRpcRequest(rpcId, params), liveSession.csrfToken);
//   const headers = {
//     'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
//     Origin: 'https://notebooklm.google.com',
//     Referer: 'https://notebooklm.google.com/',
//   };

//   log.info(`RPC ${rpcId} → start`, {
//     rpcId,
//     sourcePath,
//     transport: liveSession.tabId ? 'tab-proxy' : 'extension-fetch',
//     session: sessionLogContext(liveSession),
//   });

//   let text: string;
//   let ok: boolean;
//   let status: number;

//   try {
//     if (liveSession.tabId) {
//       const result = await tabProxyFetch(liveSession.tabId, url, {
//         method: 'POST',
//         headers,
//         bodyText,
//       });
//       ok = result.ok;
//       status = result.status;
//       text = result.body;
//     } else {
//       const response = await fetch(url, {
//         method: 'POST',
//         headers: {
//           ...headers,
//           Cookie: liveSession.cookieHeader,
//         },
//         body: bodyText,
//         credentials: 'omit',
//       });
//       ok = response.ok;
//       status = response.status;
//       text = await response.text();
//     }

//     if (!ok) {
//       log.error(`RPC ${rpcId} HTTP error`, undefined, {
//         status,
//         responsePreview: previewText(text),
//       });
//       throw new RpcError(`HTTP ${status} calling ${rpcId}`, rpcId);
//     }

//     const decoded = decodeResponse(text, rpcId);
//     log.info(`RPC ${rpcId} ← ok`, {
//       rpcId,
//       ms: Math.round(performance.now() - started),
//       responseLen: text.length,
//     });
//     return decoded;
//   } catch (err) {
//     log.error(`RPC ${rpcId} failed`, err, {
//       rpcId,
//       ms: Math.round(performance.now() - started),
//       session: sessionLogContext(liveSession),
//     });
//     throw err;
//   }
// }

// function parseNotebook(row: unknown): Notebook | null {
//   if (!Array.isArray(row)) return null;
//   const rawTitle = typeof row[0] === 'string' ? row[0] : '';
//   const title = rawTitle.replace('thought\n', '').trim();
//   const id = typeof row[2] === 'string' ? row[2] : '';
//   if (!id) return null;
//   return { id, title };
// }

// export async function listNotebooks(session: AuthSession): Promise<Notebook[]> {
//   const params = [null, 1, null, [2]];
//   const result = await rpcCall(session, RPC_METHODS.LIST_NOTEBOOKS, params);

//   if (!Array.isArray(result) || result.length === 0) {
//     log.warn('LIST_NOTEBOOKS returned empty array');
//     return [];
//   }

//   const raw = Array.isArray(result[0]) ? result[0] : result;
//   const notebooks = raw
//     .map(parseNotebook)
//     .filter((nb): nb is Notebook => nb !== null);

//   log.info('Notebooks loaded', { count: notebooks.length });
//   return notebooks;
// }

// export async function registerFileSource(
//   session: AuthSession,
//   notebookId: string,
//   filename: string,
// ): Promise<string> {
//   const params = [
//     [[filename]],
//     notebookId,
//     [2],
//     [1, null, null, null, null, null, null, null, null, null, [1]],
//   ];

//   const result = await rpcCall(
//     session,
//     RPC_METHODS.ADD_SOURCE_FILE,
//     params,
//     `/notebook/${notebookId}`,
//   );

//   const sourceId = extractSourceId(result);
//   if (!sourceId) {
//     log.error('ADD_SOURCE_FILE: could not extract source ID', undefined, {
//       filename,
//       notebookId,
//     });
//     throw new RpcError(`Failed to extract SOURCE_ID for ${filename}`);
//   }

//   log.info('Source registered', { filename, sourceId, notebookId });
//   return sourceId;
// }

// function parseArtifact(row: unknown): Artifact | null {
//   if (!Array.isArray(row)) return null;
//   const id = typeof row[0] === 'string' ? row[0] : '';
//   const title = typeof row[1] === 'string' ? row[1] : '';
//   const typeCode = typeof row[2] === 'number' ? row[2] : 0;
//   const status = typeof row[4] === 'number' ? row[4] : 0;
  
//   const timestampBlock = row[15];
//   const createdAt = (Array.isArray(timestampBlock) && typeof timestampBlock[0] === 'number') 
//     ? timestampBlock[0] * 1000 
//     : 0;

//   let type: Artifact['type'] = 'unknown';
//   if (typeCode === 1) type = 'audio';
//   else if (typeCode === 2) type = 'report';
//   else if (typeCode === 3) type = 'video';
//   else if (typeCode === 4) {
//     const optionsBlock = row[9];
//     const variant = (Array.isArray(optionsBlock) && Array.isArray(optionsBlock[1]) && typeof optionsBlock[1][0] === 'number') 
//       ? optionsBlock[1][0] 
//       : 0;
    
//     if (variant === 1) type = 'flashcards';
//     else if (variant === 2) type = 'quiz';
//     else if (variant === 4) type = 'mind_map';
//   } else if (typeCode === 5) type = 'mind_map';
//   else if (typeCode === 7) type = 'infographic';
//   else if (typeCode === 8) type = 'slide_deck';
//   else if (typeCode === 9) type = 'data_table';

//   if (!id) return null;
//   return { id, title, type, status, createdAt };
// }

// export async function listArtifacts(
//   session: AuthSession,
//   notebookId: string,
// ): Promise<Artifact[]> {
//   // Params match standard NotebookLM traffic: [[2], notebookId, query]
//   // The '2' is a static value (likely a version or mask), not a type filter.
//   const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
//   log.debug('listArtifacts request', { notebookId, params });
  
//   const result = await rpcCall(
//     session,
//     RPC_METHODS.LIST_ARTIFACTS,
//     params,
//     `/notebook/${notebookId}`,
//   );

//   if (!Array.isArray(result) || result.length === 0) {
//     log.warn('LIST_ARTIFACTS returned empty or non-array result', { resultPreview: previewText(JSON.stringify(result)) });
//     return [];
//   }

//   // Handle nested structure: result[0] is usually the list of rows
//   // but we fallback to result if it looks like the list itself.
//   const raw = (Array.isArray(result[0]) && result[0].length > 0 && Array.isArray(result[0][0])) 
//     ? result[0] 
//     : (Array.isArray(result[0]) ? result[0] : result);

//   log.debug('listArtifacts raw rows', { count: raw.length, firstRow: raw[0] });

//   const artifacts = raw
//     .map(parseArtifact)
//     .filter((a): a is Artifact => a !== null);

//   log.info('Artifacts loaded', { count: artifacts.length });
//   return artifacts;
// }

// export async function getInteractiveHtml(
//   session: AuthSession,
//   notebookId: string,
//   artifactId: string,
// ): Promise<any> {
//   const params = [artifactId];
//   const result = await rpcCall(
//     session,
//     RPC_METHODS.GET_INTERACTIVE_HTML,
//     params,
//     `/notebook/${notebookId}`,
//   );

//   return result;
// }

// export async function getArtifactState(
//   session: AuthSession,
//   notebookId: string,
//   artifactId: string,
// ): Promise<any> {
//   // Params captured from network traffic: [retry_options, artifact_id]
//   const retryOptions = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];
//   const params = [retryOptions, artifactId];
//   const result = await rpcCall(
//     session,
//     RPC_METHODS.GET_ARTIFACT_STATE,
//     params,
//     `/notebook/${notebookId}`,
//   );

//   return result;
// }

import { BATCHEXECUTE_URL, RPC_METHODS } from './constants';
import { decodeResponse, extractSourceId, RpcError } from './decoder';
import { createLogger, previewText, sessionLogContext } from './logger';
import { readTabSession } from './tab-session';
import { tabProxyFetch } from './tab-proxy';
import type { AuthSession, Notebook, Artifact } from './types';

const log = createLogger('rpc');

// ─── Session token cache ──────────────────────────────────────────────────────
// withFreshTabSession was called on every single RPC, causing N WIZ_global_data
// reads for N parallel uploads. A 30s TTL is safe — CSRF tokens are valid for
// several minutes and the cache is busted on 401/403 responses.

const SESSION_CACHE_TTL_MS = 30_000;

interface CachedSession {
  csrfToken: string;
  sessionId: string;
  authuser: string | undefined;
  expiresAt: number;
}

const sessionCache = new Map<number, CachedSession>(); // keyed by tabId

function getCachedSession(tabId: number): CachedSession | null {
  const cached = sessionCache.get(tabId);
  if (!cached || Date.now() > cached.expiresAt) {
    sessionCache.delete(tabId);
    return null;
  }
  return cached;
}

function setCachedSession(tabId: number, fresh: CachedSession): void {
  sessionCache.set(tabId, { ...fresh, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
}

/** Bust the cache for a tab — called on 401/403 so we re-read immediately. */
export function bustSessionCache(tabId: number): void {
  sessionCache.delete(tabId);
  log.debug('Session cache busted', { tabId });
}

async function withFreshTabSession(session: AuthSession): Promise<AuthSession> {
  if (!session.tabId) return session;

  const cached = getCachedSession(session.tabId);
  if (cached) {
    log.debug('Session tokens from cache', { tabId: session.tabId });
    return {
      ...session,
      csrfToken: cached.csrfToken,
      sessionId: cached.sessionId,
      authuser: cached.authuser,
    };
  }

  log.debug('Refreshing session tokens from tab', { tabId: session.tabId });
  const fresh = await readTabSession(session.tabId);
  setCachedSession(session.tabId, {
    csrfToken: fresh.csrfToken,
    sessionId: fresh.sessionId,
    authuser: fresh.authuser,
    expiresAt: 0, // overwritten by setCachedSession
  });

  return {
    ...session,
    csrfToken: fresh.csrfToken,
    sessionId: fresh.sessionId,
    authuser: fresh.authuser,
  };
}

// ─── RPC plumbing ─────────────────────────────────────────────────────────────

function encodeRpcRequest(rpcId: string, params: unknown[]): unknown[][][] {
  const paramsJson = JSON.stringify(params);
  return [[[rpcId, paramsJson, null, 'generic']]];
}

function buildRequestBody(rpcRequest: unknown[][][], csrfToken: string): string {
  const fReq = JSON.stringify(rpcRequest);
  return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(csrfToken)}&`;
}

function buildRpcUrl(rpcId: string, session: AuthSession, sourcePath = '/'): string {
  const params = new URLSearchParams({
    rpcids: rpcId,
    'source-path': sourcePath,
    'f.sid': session.sessionId,
    hl: 'en',
    rt: 'c',
  });
  if (session.authuser !== undefined && session.authuser !== '') {
    params.set('authuser', session.authuser);
  }
  return `${BATCHEXECUTE_URL}?${params}`;
}

export async function rpcCall(
  session: AuthSession,
  rpcId: string,
  params: unknown[],
  sourcePath = '/',
): Promise<unknown> {
  const started = performance.now();
  const liveSession = await withFreshTabSession(session);
  const url = buildRpcUrl(rpcId, liveSession, sourcePath);
  const bodyText = buildRequestBody(encodeRpcRequest(rpcId, params), liveSession.csrfToken);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Origin: 'https://notebooklm.google.com',
    Referer: 'https://notebooklm.google.com/',
  };

  log.info(`RPC ${rpcId} → start`, {
    rpcId,
    sourcePath,
    transport: liveSession.tabId ? 'tab-proxy' : 'extension-fetch',
    session: sessionLogContext(liveSession),
  });

  let text: string;
  let ok: boolean;
  let status: number;

  try {
    if (liveSession.tabId) {
      const result = await tabProxyFetch(liveSession.tabId, url, {
        method: 'POST',
        headers,
        bodyText,
      });
      ok = result.ok;
      status = result.status;
      text = result.body;
    } else {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          Cookie: liveSession.cookieHeader,
        },
        body: bodyText,
        credentials: 'omit',
      });
      ok = response.ok;
      status = response.status;
      text = await response.text();
    }

    // Bust session cache on auth errors so the next call re-reads tokens
    if ((status === 401 || status === 403) && liveSession.tabId) {
      bustSessionCache(liveSession.tabId);
    }

    if (!ok) {
      log.error(`RPC ${rpcId} HTTP error`, undefined, {
        status,
        responsePreview: previewText(text),
      });
      throw new RpcError(`HTTP ${status} calling ${rpcId}`, rpcId);
    }

    const decoded = decodeResponse(text, rpcId);
    log.info(`RPC ${rpcId} ← ok`, {
      rpcId,
      ms: Math.round(performance.now() - started),
      responseLen: text.length,
    });
    return decoded;
  } catch (err) {
    log.error(`RPC ${rpcId} failed`, err, {
      rpcId,
      ms: Math.round(performance.now() - started),
      session: sessionLogContext(liveSession),
    });
    throw err;
  }
}

// ─── Notebooks ────────────────────────────────────────────────────────────────

function parseNotebook(row: unknown): Notebook | null {
  if (!Array.isArray(row)) return null;
  const rawTitle = typeof row[0] === 'string' ? row[0] : '';
  const title = rawTitle.replace('thought\n', '').trim();
  const id = typeof row[2] === 'string' ? row[2] : '';
  if (!id) return null;
  return { id, title };
}

export async function listNotebooks(session: AuthSession): Promise<Notebook[]> {
  const params = [null, 1, null, [2]];
  const result = await rpcCall(session, RPC_METHODS.LIST_NOTEBOOKS, params);

  if (!Array.isArray(result) || result.length === 0) {
    log.warn('LIST_NOTEBOOKS returned empty array');
    return [];
  }

  const raw = Array.isArray(result[0]) ? result[0] : result;
  const notebooks = raw
    .map(parseNotebook)
    .filter((nb): nb is Notebook => nb !== null);

  log.info('Notebooks loaded', { count: notebooks.length });
  return notebooks;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

export async function registerFileSource(
  session: AuthSession,
  notebookId: string,
  filename: string,
): Promise<string> {
  const params = [
    [[filename]],
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];

  const result = await rpcCall(
    session,
    RPC_METHODS.ADD_SOURCE_FILE,
    params,
    `/notebook/${notebookId}`,
  );

  const sourceId = extractSourceId(result);
  if (!sourceId) {
    log.error('ADD_SOURCE_FILE: could not extract source ID', undefined, {
      filename,
      notebookId,
    });
    throw new RpcError(`Failed to extract SOURCE_ID for ${filename}`);
  }

  log.info('Source registered', { filename, sourceId, notebookId });
  return sourceId;
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

// Ensure your types.ts Artifact type union includes 'study_tool':
//
//   export type ArtifactType =
//     | 'audio' | 'report' | 'video'
//     | 'flashcards' | 'quiz' | 'mind_map' | 'study_tool'
//     | 'infographic' | 'slide_deck' | 'data_table' | 'unknown';
//
//   export interface Artifact {
//     id: string;
//     title: string;
//     type: ArtifactType;
//     status: number;
//     createdAt: number;
//   }

/**
 * Scan the row from the end for the first array whose first element looks
 * like a Unix timestamp (> 1 billion = after year 2001).
 * This is more resilient than hardcoding row[15], which breaks when
 * NotebookLM adds or removes fields in the wire format.
 */
function findTimestampMs(row: unknown[]): number {
  for (let i = row.length - 1; i >= 0; i--) {
    const cell = row[i];
    if (
      Array.isArray(cell) &&
      typeof cell[0] === 'number' &&
      cell[0] > 1_000_000_000
    ) {
      return (cell[0] as number) * 1000;
    }
  }
  return 0;
}

function parseArtifact(row: unknown): Artifact | null {
  if (!Array.isArray(row) || row.length === 0) return null;

  const id = typeof row[0] === 'string' ? row[0] : '';
  if (!id) return null;

  const title = typeof row[1] === 'string' ? row[1] : '';
  const typeCode = typeof row[2] === 'number' ? row[2] : 0;
  const status = typeof row[4] === 'number' ? row[4] : 0;
  const createdAt = findTimestampMs(row);

  // Safely read the options block — null-check before descending
  const optionsBlock = Array.isArray(row[9]) ? row[9] : null;
  const variantArray = optionsBlock && Array.isArray(optionsBlock[1]) ? optionsBlock[1] : null;
  const variant = typeof variantArray?.[0] === 'number' ? variantArray[0] : 0;

  let type: Artifact['type'] = 'unknown';

  switch (typeCode) {
    case 1:
      type = 'audio';
      break;
    case 2:
      type = 'report';
      break;
    case 3:
      type = 'video';
      break;
    case 4:
      // Type 4 is a "study tool" — the variant distinguishes subtypes.
      // Unknown variants fall back to 'unknown' until ArtifactType is extended.
      if (variant === 1) type = 'flashcards';
      else if (variant === 2) type = 'quiz';
      else if (variant === 4) type = 'mind_map';
      else type = 'unknown';
      break;
    case 5:
      // Type 5 is a standalone mind map (distinct from the type-4 variant)
      type = 'mind_map';
      break;
    case 7:
      type = 'infographic';
      break;
    case 8:
      type = 'slide_deck';
      break;
    case 9:
      type = 'data_table';
      break;
    default:
      type = 'unknown';
  }

  return { id, title, type, status, createdAt };
}

export async function listArtifacts(
  session: AuthSession,
  notebookId: string,
): Promise<Artifact[]> {
  // Correct param order: notebookId first, then the mask [2], then the filter query.
  // sourcePath must also include the notebookId so the batchexecute routing is correct.
  const params = [
    notebookId,
    [2],
    'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"',
  ];

  log.debug('listArtifacts request', { notebookId, params });

  const result = await rpcCall(
    session,
    RPC_METHODS.LIST_ARTIFACTS,
    params,
    `/notebook/${notebookId}`, // was '/' — must match the notebookId
  );

  if (!Array.isArray(result) || result.length === 0) {
    log.warn('LIST_ARTIFACTS returned empty or non-array result', {
      resultPreview: previewText(JSON.stringify(result)),
    });
    return [];
  }

  // Unwrap one level of nesting if the first element is itself an array of arrays
  const raw =
    Array.isArray(result[0]) &&
    result[0].length > 0 &&
    Array.isArray(result[0][0])
      ? result[0]
      : Array.isArray(result[0])
      ? result[0]
      : result;

  log.debug('listArtifacts raw rows', { count: raw.length, firstRow: raw[0] });

  const artifacts = raw
    .map(parseArtifact)
    .filter((a): a is Artifact => a !== null);

  log.info('Artifacts loaded', { count: artifacts.length });
  return artifacts;
}

// ─── Interactive HTML ─────────────────────────────────────────────────────────

export interface InteractiveHtmlResult {
  html: string;
  artifactId: string;
}

/**
 * Fetch the rendered HTML for an interactive artifact (mind maps, infographics,
 * slide decks, data tables). Returns a typed result instead of `any`.
 *
 * Note: notebookId is required for the sourcePath even though the RPC only
 * takes artifactId as a payload param — the batchexecute routing uses it.
 */
export async function getInteractiveHtml(
  session: AuthSession,
  notebookId: string,
  artifactId: string,
): Promise<InteractiveHtmlResult> {
  const params = [artifactId];
  const result = await rpcCall(
    session,
    RPC_METHODS.GET_INTERACTIVE_HTML,
    params,
    `/notebook/${notebookId}`,
  );

  // The response is typically [[html_string]] or [html_string]
  let html = '';
  if (Array.isArray(result)) {
    const inner = Array.isArray(result[0]) ? result[0] : result;
    html = typeof inner[0] === 'string' ? inner[0] : JSON.stringify(inner);
  } else if (typeof result === 'string') {
    html = result;
  }

  return { html, artifactId };
}

// ─── Artifact state ───────────────────────────────────────────────────────────

export type ArtifactStatusCode = 0 | 1 | 2 | 3 | 4;

export interface ArtifactState {
  artifactId: string;
  status: ArtifactStatusCode;
  /** Raw decoded response — shape varies by artifact type */
  raw: unknown;
}

/**
 * Named constants for the source-type mask sent in getArtifactState.
 * Captured from network traffic; these correspond to NotebookLM source types
 * (1=document, 2=web, 4=youtube, 8=audio, 3=upload — values are bitmasks).
 */
const ARTIFACT_STATE_SOURCE_MASK = [1, 4, 8, 2, 3, 6] as const;

export async function getArtifactState(
  session: AuthSession,
  notebookId: string,
  artifactId: string,
): Promise<ArtifactState> {
  // retryOptions structure captured from network traffic.
  // Index 0 = version/mode (2), index 3 = source config, index 4 = source type mask.
  // Kept as a named structure so future changes are obvious.
  const retryOptions = [
    2,                                    // mode / version flag
    null,
    null,
    [1, null, null, null, null, null, null, null, null, null, [1]], // source config
    [ARTIFACT_STATE_SOURCE_MASK],         // source type mask
  ];

  const params = [retryOptions, artifactId];

  const result = await rpcCall(
    session,
    RPC_METHODS.GET_ARTIFACT_STATE,
    params,
    `/notebook/${notebookId}`,
  );

  // Extract status code from response — typically at result[0][3][1] or similar
  let status: ArtifactStatusCode = 0;
  if (Array.isArray(result)) {
    const inner = Array.isArray(result[0]) ? result[0] : result;
    const statusRaw = Array.isArray(inner[3]) ? inner[3][1] : inner[1];
    if (typeof statusRaw === 'number' && statusRaw >= 0 && statusRaw <= 4) {
      status = statusRaw as ArtifactStatusCode;
    }
  }

  return { artifactId, status, raw: result };
  }

  export async function exportArtifactToDocs(
  session: AuthSession,
  notebookId: string,
  artifactId: string,
  ): Promise<string> {
  // Params: [[artifactId], exportType]
  // ExportType 1 = Google Docs
  // ExportType 2 = Google Sheets / Slides
  const params = [[artifactId], 2];
  const result = await rpcCall(
    session,
    RPC_METHODS.EXPORT_ARTIFACT,
    params,
    `/notebook/${notebookId}`,
  );

  // result[0] is typically the URL string
  if (typeof result === 'string') return result;
  if (Array.isArray(result) && typeof result[0] === 'string') return result[0];

  throw new RpcError('Failed to get export URL from response');
  }