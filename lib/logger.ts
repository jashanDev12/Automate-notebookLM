/**
 * Structured logging for NotebookLM Mega Uploader.
 * View logs: side panel → right-click → Inspect → Console (filter: [NLM])
 * Verbose debug: localStorage.setItem('nlm-debug', '1') then reload side panel
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const PREFIX = '[NLM]';
const MAX_ENTRIES = 250;
const buffer: LogEntry[] = [];

const SENSITIVE_KEY_RE =
  /^(csrf|session|cookie|token|sid|auth|password|secret|at$|f\.sid)/i;

function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem('nlm-debug') === '1';
  } catch {
    return false;
  }
}

export function previewText(text: string, max = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}… (${oneLine.length} chars)`;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 120) {
      return `${value.slice(0, 40)}…${value.slice(-8)} (${value.length} chars)`;
    }
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack && isDebugEnabled() ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key) || key === 'cookieHeader' || key === 'csrfToken') {
        out[key] = typeof val === 'string' ? `[redacted:${val.length}]` : '[redacted]';
      } else {
        out[key] = sanitize(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function pushEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

/** Also log to the extension service worker console (chrome://extensions → Inspect views). */
function mirrorLogToBackground(entry: LogEntry): void {
  if (entry.level === 'debug' && !isDebugEnabled()) return;
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void chrome.runtime.sendMessage({ type: 'NLM_LOG_MIRROR', entry }).catch(() => {
      // background may be asleep
    });
  } catch {
    // ignore
  }
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data !== undefined ? { data: sanitize(data) } : {}),
  };
  pushEntry(entry);
  mirrorLogToBackground(entry);

  const tag = `${PREFIX}:${scope}`;
  const line = data !== undefined ? `${tag} ${message}` : `${tag} ${message}`;

  if (level === 'debug' && !isDebugEnabled()) return;

  switch (level) {
    case 'debug':
      console.debug(line, data !== undefined ? sanitize(data) : '');
      break;
    case 'info':
      console.info(line, data !== undefined ? sanitize(data) : '');
      break;
    case 'warn':
      console.warn(line, data !== undefined ? sanitize(data) : '');
      break;
    case 'error':
      console.error(line, data !== undefined ? sanitize(data) : '');
      break;
  }
}

function mergeErrorData(err: unknown, data?: unknown): unknown {
  if (err === undefined) return data;
  return {
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}),
    error: formatError(err),
  };
}

function emitWithOptionalError(
  level: LogLevel,
  scope: string,
  message: string,
  errOrData?: unknown,
  data?: unknown,
): void {
  const payload =
    data !== undefined || errOrData instanceof Error
      ? mergeErrorData(errOrData, data)
      : errOrData;
  emit(level, scope, message, payload);
}

export interface Logger {
  debug: (message: string, errOrData?: unknown, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, errOrData?: unknown, data?: unknown) => void;
  error: (message: string, errOrData?: unknown, data?: unknown) => void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, errOrData, data) =>
      emitWithOptionalError('debug', scope, message, errOrData, data),
    info: (message, data) => emit('info', scope, message, data),
    warn: (message, errOrData, data) =>
      emitWithOptionalError('warn', scope, message, errOrData, data),
    error: (message, errOrData, data) =>
      emitWithOptionalError('error', scope, message, errOrData, data),
  };
}

export function formatError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  methodId?: string;
} {
  if (err instanceof Error) {
    const rpc = err as Error & { methodId?: string };
    return {
      name: rpc.name,
      message: rpc.message,
      ...(rpc.methodId ? { methodId: rpc.methodId } : {}),
      ...(isDebugEnabled() && rpc.stack ? { stack: rpc.stack } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

export function getRecentLogsText(): string {
  return buffer
    .map((e) => {
      const dataPart = e.data !== undefined ? ` | ${JSON.stringify(e.data)}` : '';
      return `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}${dataPart}`;
    })
    .join('\n');
}

export async function copyRecentLogsToClipboard(): Promise<boolean> {
  const text = getRecentLogsText();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Redacted auth session fields safe for logs. */
export function sessionLogContext(session: {
  tabId?: number;
  authuser?: string;
  csrfToken?: string;
  sessionId?: string;
  cookieHeader?: string;
}): Record<string, unknown> {
  return {
    viaTab: Boolean(session.tabId),
    tabId: session.tabId,
    authuser: session.authuser ?? '(default)',
    hasCsrf: Boolean(session.csrfToken),
    hasSessionId: Boolean(session.sessionId),
    hasCookieHeader: Boolean(session.cookieHeader),
    csrfLen: session.csrfToken?.length ?? 0,
    sessionIdLen: session.sessionId?.length ?? 0,
  };
}
