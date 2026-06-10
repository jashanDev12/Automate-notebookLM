import { BATCHEXECUTE_URL, RPC_METHODS } from './constants';
import { decodeResponse, extractSourceId, RpcError } from './decoder';
import { createLogger, previewText, sessionLogContext } from './logger';
import { readTabSession } from './tab-session';
import { tabProxyFetch } from './tab-proxy';
import type { AuthSession, Notebook, Artifact } from './types';

const log = createLogger('rpc');

function encodeRpcRequest(rpcId: string, params: unknown[]): unknown[][][] {
  const paramsJson = JSON.stringify(params);
  return [[[rpcId, paramsJson, null, 'generic']]];
}

function buildRequestBody(rpcRequest: unknown[][][], csrfToken: string): string {
  const fReq = JSON.stringify(rpcRequest);
  return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(csrfToken)}&`;
}

function buildRpcUrl(
  rpcId: string,
  session: AuthSession,
  sourcePath = '/',
): string {
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

async function withFreshTabSession(session: AuthSession): Promise<AuthSession> {
  if (!session.tabId) return session;
  log.debug('Refreshing session tokens from tab', { tabId: session.tabId });
  const fresh = await readTabSession(session.tabId);
  return {
    ...session,
    csrfToken: fresh.csrfToken,
    sessionId: fresh.sessionId,
    authuser: fresh.authuser,
  };
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

function parseArtifact(row: unknown): Artifact | null {
  if (!Array.isArray(row)) return null;
  const id = typeof row[0] === 'string' ? row[0] : '';
  const title = typeof row[1] === 'string' ? row[1] : '';
  const typeCode = typeof row[2] === 'number' ? row[2] : 0;
  const status = typeof row[4] === 'number' ? row[4] : 0;
  
  const timestampBlock = row[15];
  const createdAt = (Array.isArray(timestampBlock) && typeof timestampBlock[0] === 'number') 
    ? timestampBlock[0] * 1000 
    : 0;

  let type: Artifact['type'] = 'unknown';
  if (typeCode === 1) type = 'audio';
  else if (typeCode === 2) type = 'report';
  else if (typeCode === 3) type = 'video';
  else if (typeCode === 4) {
    const optionsBlock = row[9];
    const variant = (Array.isArray(optionsBlock) && Array.isArray(optionsBlock[1]) && typeof optionsBlock[1][0] === 'number') 
      ? optionsBlock[1][0] 
      : 0;
    
    if (variant === 1) type = 'flashcards';
    else if (variant === 2) type = 'quiz';
    else if (variant === 4) type = 'mind_map';
  } else if (typeCode === 5) type = 'mind_map';
  else if (typeCode === 7) type = 'infographic';
  else if (typeCode === 8) type = 'slide_deck';
  else if (typeCode === 9) type = 'data_table';

  if (!id) return null;
  return { id, title, type, status, createdAt };
}

export async function listArtifacts(
  session: AuthSession,
  notebookId: string,
): Promise<Artifact[]> {
  // Params match standard NotebookLM traffic: [[2], notebookId, query]
  // The '2' is a static value (likely a version or mask), not a type filter.
  const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
  log.debug('listArtifacts request', { notebookId, params });
  
  const result = await rpcCall(
    session,
    RPC_METHODS.LIST_ARTIFACTS,
    params,
    `/notebook/${notebookId}`,
  );

  if (!Array.isArray(result) || result.length === 0) {
    log.warn('LIST_ARTIFACTS returned empty or non-array result', { resultPreview: previewText(JSON.stringify(result)) });
    return [];
  }

  // Handle nested structure: result[0] is usually the list of rows
  // but we fallback to result if it looks like the list itself.
  const raw = (Array.isArray(result[0]) && result[0].length > 0 && Array.isArray(result[0][0])) 
    ? result[0] 
    : (Array.isArray(result[0]) ? result[0] : result);

  log.debug('listArtifacts raw rows', { count: raw.length, firstRow: raw[0] });

  const artifacts = raw
    .map(parseArtifact)
    .filter((a): a is Artifact => a !== null);

  log.info('Artifacts loaded', { count: artifacts.length });
  return artifacts;
}

export async function getInteractiveHtml(
  session: AuthSession,
  notebookId: string,
  artifactId: string,
): Promise<any> {
  const params = [artifactId];
  const result = await rpcCall(
    session,
    RPC_METHODS.GET_INTERACTIVE_HTML,
    params,
    `/notebook/${notebookId}`,
  );

  return result;
}

export async function getArtifactState(
  session: AuthSession,
  notebookId: string,
  artifactId: string,
): Promise<any> {
  // Params captured from network traffic: [retry_options, artifact_id]
  const retryOptions = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];
  const params = [retryOptions, artifactId];
  const result = await rpcCall(
    session,
    RPC_METHODS.GET_ARTIFACT_STATE,
    params,
    `/notebook/${notebookId}`,
  );

  return result;
}
