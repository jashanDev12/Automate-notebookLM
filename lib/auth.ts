import { ALLOWED_COOKIE_DOMAINS, BASE_URL } from './constants';
import type { AuthSession } from './types';

/** Cookies Google requires for NotebookLM API access (Tier 1). */
const MINIMUM_REQUIRED_COOKIES = new Set(['SID', '__Secure-1PSIDTS']);

const COOKIE_PROBE_URLS = [
  `${BASE_URL}/`,
  'https://accounts.google.com/',
  'https://www.google.com/',
] as const;

const WIZ_FIELD_PATTERNS = (key: string) => [
  new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`),
  new RegExp(`'${key}'\\s*:\\s*'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'`),
  new RegExp(`&quot;${key}&quot;\\s*:\\s*&quot;((?:(?!&quot;).)*)&quot;`),
];

function extractWizField(html: string, key: string): string | null {
  for (const pattern of WIZ_FIELD_PATTERNS(key)) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function domainAllowed(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  for (const allowed of ALLOWED_COOKIE_DOMAINS) {
    const a = allowed.replace(/^\./, '').toLowerCase();
    if (host === a || host.endsWith(`.${a}`)) return true;
  }
  return false;
}

function cookiePriority(cookie: chrome.cookies.Cookie): number {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (domain === 'notebooklm.google.com') return 100;
  if (domain.endsWith('notebooklm.google.com')) return 90;
  if (domain === 'google.com' || domain.endsWith('.google.com')) return 50;
  if (domain.includes('accounts.google.com')) return 40;
  return 10;
}

/** Collect cookies Chrome would send to NotebookLM (url-based API — most reliable). */
export async function getNotebookLmCookies(): Promise<chrome.cookies.Cookie[]> {
  const byName = new Map<string, chrome.cookies.Cookie>();

  for (const url of COOKIE_PROBE_URLS) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        if (!domainAllowed(cookie.domain)) continue;
        const existing = byName.get(cookie.name);
        if (!existing || cookiePriority(cookie) > cookiePriority(existing)) {
          byName.set(cookie.name, cookie);
        }
      }
    } catch {
      // ignore per-url failures
    }
  }

  return [...byName.values()];
}

function validateCookieSet(cookies: chrome.cookies.Cookie[]): void {
  const names = new Set(cookies.map((c) => c.name));
  const missing = [...MINIMUM_REQUIRED_COOKIES].filter((n) => !names.has(n));
  if (missing.length > 0) {
    throw new Error(
      `Missing required Google cookies: ${missing.join(', ')}. ` +
        'Sign in at notebooklm.google.com in this Chrome profile (not an Incognito window), then click Refresh.',
    );
  }
}

function buildCookieHeader(cookies: chrome.cookies.Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export async function openNotebookLmSignIn(): Promise<void> {
  await chrome.tabs.create({ url: BASE_URL, active: true });
}

export async function fetchAuthSession(): Promise<AuthSession> {
  const cookies = await getNotebookLmCookies();

  if (cookies.length === 0) {
    throw new Error(
      'No Google session cookies found. Click "Open NotebookLM" below, sign in with Google in that tab, then return here and click Refresh.',
    );
  }

  validateCookieSet(cookies);
  const cookieHeader = buildCookieHeader(cookies);

  // credentials: 'include' lets Chrome attach cookies when host_permissions allow it
  const response = await fetch(BASE_URL, {
    method: 'GET',
    headers: {
      Accept: 'text/html',
      Cookie: cookieHeader,
    },
    credentials: 'include',
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'NotebookLM rejected the session. Open notebooklm.google.com, sign in again, then click Refresh.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load NotebookLM (${response.status}). Sign in at notebooklm.google.com in this browser profile.`,
    );
  }

  const html = await response.text();

  if (html.includes('accounts.google.com/v3/signin') || html.includes('ServiceLogin')) {
    throw new Error(
      'Google sign-in required. Click "Open NotebookLM", complete sign-in in that tab, then click Refresh.',
    );
  }

  const csrfToken = extractWizField(html, 'SNlM0e');
  const sessionId = extractWizField(html, 'FdrFJe');

  if (!csrfToken || !sessionId) {
    throw new Error(
      'Could not read session tokens. Open notebooklm.google.com, ensure you see your notebooks, then click Refresh.',
    );
  }

  return {
    csrfToken,
    sessionId,
    authuser: '0',
    cookieHeader,
  };
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    await fetchAuthSession();
    return true;
  } catch {
    return false;
  }
}
