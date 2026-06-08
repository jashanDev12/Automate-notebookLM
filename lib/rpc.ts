import { BATCHEXECUTE_URL, RPC_METHODS } from './constants';
import { decodeResponse, extractSourceId, RpcError } from './decoder';
import type { AuthSession, Notebook } from './types';

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
    authuser: session.authuser,
  });
  return `${BATCHEXECUTE_URL}?${params}`;
}

async function rpcCall(
  session: AuthSession,
  rpcId: string,
  params: unknown[],
  sourcePath = '/',
): Promise<unknown> {
  const url = buildRpcUrl(rpcId, session, sourcePath);
  const body = buildRequestBody(encodeRpcRequest(rpcId, params), session.csrfToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Cookie: session.cookieHeader,
      Origin: 'https://notebooklm.google.com',
      Referer: 'https://notebooklm.google.com/',
    },
    body,
    credentials: 'omit',
  });

  if (!response.ok) {
    throw new RpcError(`HTTP ${response.status} calling ${rpcId}`, rpcId);
  }

  const text = await response.text();
  return decodeResponse(text, rpcId);
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

  if (!Array.isArray(result) || result.length === 0) return [];

  const raw = Array.isArray(result[0]) ? result[0] : result;
  return raw
    .map(parseNotebook)
    .filter((nb): nb is Notebook => nb !== null);
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
    throw new RpcError(`Failed to extract SOURCE_ID for ${filename}`);
  }
  return sourceId;
}
