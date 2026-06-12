import { BASE_URL } from './constants';

import { readTabSession } from './tab-session';
import {
  findNotebookLmTabId,
  findNotebookLmTabs,
  getSessionFromTab,
  NOT_SIGNED_IN_HELP,
  TAB_REQUIRED_HELP,
} from './tab-proxy';

import { createLogger, sessionLogContext } from './logger';
import type { AuthSession } from './types';

import { extractWizField, isSignInPageHtml } from './wiz';

const log = createLogger('auth');



/** Cookies Google requires for NotebookLM API access (Tier 1). */

const MINIMUM_REQUIRED_COOKIES = new Set(['SID', '__Secure-1PSIDTS']);



const COOKIE_PROBE_URLS = [

  `${BASE_URL}/`,

  'https://accounts.google.com/',

  'https://www.google.com/',

] as const;



const COOKIE_PROBE_DOMAINS = [

  '.google.com',

  'google.com',

  '.notebooklm.google.com',

] as const;



function cookieKey(cookie: chrome.cookies.Cookie): string {

  return `${cookie.domain}|${cookie.name}|${cookie.path}`;

}



/** All cookies Chrome would attach to a NotebookLM request. */

export async function getNotebookLmCookies(): Promise<chrome.cookies.Cookie[]> {

  const seen = new Map<string, chrome.cookies.Cookie>();



  for (const url of COOKIE_PROBE_URLS) {

    try {

      const cookies = await chrome.cookies.getAll({ url });

      for (const cookie of cookies) {

        seen.set(cookieKey(cookie), cookie);

      }

    } catch {

      // ignore per-url failures

    }

  }



  for (const domain of COOKIE_PROBE_DOMAINS) {

    try {

      const cookies = await chrome.cookies.getAll({ domain });

      for (const cookie of cookies) {

        seen.set(cookieKey(cookie), cookie);

      }

    } catch {

      // ignore per-domain failures

    }

  }



  return [...seen.values()];

}



function hasSessionCookies(cookies: chrome.cookies.Cookie[]): boolean {

  const names = new Set(cookies.map((c) => c.name));

  return [...MINIMUM_REQUIRED_COOKIES].every((n) => names.has(n));

}



function buildCookieHeader(cookies: chrome.cookies.Cookie[]): string {

  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');

}



async function extractTokensFromFetch(cookieHeader: string): Promise<{

  csrfToken: string;

  sessionId: string;

}> {

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

      'NotebookLM rejected the session. Sign in at notebooklm.google.com, then click Refresh.',

    );

  }



  if (!response.ok) {

    throw new Error(`Failed to load NotebookLM (${response.status}).`);

  }



  const html = await response.text();



  if (isSignInPageHtml(html)) {

    throw new Error(NOT_SIGNED_IN_HELP);

  }



  const csrfToken = extractWizField(html, 'SNlM0e');

  const sessionId = extractWizField(html, 'FdrFJe');



  if (!csrfToken || !sessionId) {

    throw new Error(

      'Could not read session tokens. Open notebooklm.google.com, wait until your notebooks appear, then click Refresh.',

    );

  }



  return { csrfToken, sessionId };

}



function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function openNotebookLmSignIn(): Promise<void> {
  const existing = await findNotebookLmTabId();
  if (existing) {
    await chrome.tabs.update(existing, { active: true });
    return;
  }
  await chrome.tabs.create({ url: BASE_URL, active: true });
}

/** Open NotebookLM (or focus existing tab) and wait until session tokens are readable. */
export async function connectNotebookLm(): Promise<void> {
  log.info('connectNotebookLm started');
  let tabId: number | undefined = (await findNotebookLmTabId()) ?? undefined;
  if (!tabId) {
    log.info('Opening new NotebookLM tab');
    const created = await chrome.tabs.create({ url: BASE_URL, active: true });
    tabId = created.id;
  } else {
    log.info('Focusing existing NotebookLM tab', { tabId });
    await chrome.tabs.update(tabId, { active: true });
  }

  if (!tabId) {
    log.error('Failed to obtain NotebookLM tab id');
    throw new Error('Could not open a NotebookLM tab.');
  }

  const deadline = Date.now() + 30_000;
  let lastError = 'NotebookLM is still loading.';
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      await readTabSession(tabId);
      log.info('connectNotebookLm succeeded', { tabId, attempts: attempt });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.debug('connectNotebookLm waiting for session', { tabId, attempt, lastError });
      
      const lower = lastError.toLowerCase();
      if (lower.includes('sign-in') || lower.includes('servicelogin')) {
        log.error('connectNotebookLm: sign-in required', err, { tabId });
        throw new Error(
          `Sign-in required on the NotebookLM tab.\n\nComplete sign-in in the browser window, then click Connect again.`,
        );
      }
    }
    await delay(1500);
  }

  log.error('connectNotebookLm timed out', undefined, { tabId, attempts: attempt, lastError });
  throw new Error(
    `${lastError}\n\nWait until your notebooks appear on the NotebookLM tab, then click Connect again.`,
  );
}



function isAnonymousCookieSet(names: string[]): boolean {
  const set = new Set(names);
  return !set.has('SID') && !set.has('__Secure-1PSID') && !set.has('__Secure-3PSID');
}

function likelySignedIntoGoogle(cookies: chrome.cookies.Cookie[]): boolean {
  if (hasSessionCookies(cookies)) return true;
  const names = new Set(cookies.map((c) => c.name));
  return (
    names.has('ACCOUNT_CHOOSER') ||
    names.has('LSID') ||
    names.has('SAPISID') ||
    names.has('APISID') ||
    names.has('__Secure-1PSID') ||
    names.has('__Secure-3PSID')
  );
}



export async function getAuthDiagnostics(): Promise<string> {

  const cookies = await getNotebookLmCookies();

  const names = cookies.map((c) => c.name).sort();

  const tabs = await findNotebookLmTabs();
  const anonymous = isAnonymousCookieSet(names);
  const likelySignedIn = likelySignedIntoGoogle(cookies);
  const sessionNote = hasSessionCookies(cookies)
    ? ' (signed-in session detected)'
    : likelySignedIn
      ? ' (likely signed into Google — open NotebookLM tab to connect)'
      : anonymous
        ? ' (not signed into Google)'
        : ' (partial session)';

  return (
    `Cookies found: ${cookies.length} (${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''})${sessionNote}. ` +
    `Open NotebookLM tabs: ${tabs.length}.`
  );

}



/** Prefer live NotebookLM tab session — works when Chrome hides session cookies from extensions. */

async function fetchAuthSessionFromTab(): Promise<AuthSession | null> {
  const tabs = await findNotebookLmTabs();
  log.debug('fetchAuthSessionFromTab', { tabCount: tabs.length });

  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const session = await getSessionFromTab(tab.id);
      const authSession = {
        csrfToken: session.csrfToken,
        sessionId: session.sessionId,
        authuser: session.authuser,
        cookieHeader: '',
        tabId: session.tabId,
      };
      log.info('Auth session from tab', sessionLogContext(authSession));
      return authSession;
    } catch (err) {
      log.warn('Tab session read failed for tab', err, { tabId: tab.id, url: tab.url });
      continue;
    }
  }

  log.warn('No tab yielded a valid session', { tabCount: tabs.length });
  return null;
}



export async function fetchAuthSession(): Promise<AuthSession> {
  log.info('fetchAuthSession started');

  const fromTab = await fetchAuthSessionFromTab();
  if (fromTab) {
    return fromTab;
  }

  const tabCount = (await findNotebookLmTabs()).length;
  const cookies = await getNotebookLmCookies();
  const cookieNames = cookies.map((c) => c.name);

  log.warn('Tab auth failed — evaluating cookie fallback', {
    tabCount,
    cookieCount: cookies.length,
    hasSid: cookieNames.includes('SID'),
    likelySignedIn: likelySignedIntoGoogle(cookies),
  });

  if (tabCount === 0) {
    if (!likelySignedIntoGoogle(cookies)) {
      log.error('Auth failed: no tab and not signed into Google');
      throw new Error(`${TAB_REQUIRED_HELP}\n\n${NOT_SIGNED_IN_HELP}`);
    }
    log.error('Auth failed: no NotebookLM tab open');
    throw new Error(TAB_REQUIRED_HELP);
  }

  if (!hasSessionCookies(cookies)) {
    log.error('Auth failed: tab open but session cookies missing', undefined, {
      tabCount,
      cookieNames: cookieNames.slice(0, 12),
    });
    throw new Error(
      `${NOT_SIGNED_IN_HELP}\n\nA NotebookLM tab is open but Google sign-in is not complete on that tab.`,
    );
  }

  const cookieHeader = buildCookieHeader(cookies);
  const tokens = await extractTokensFromFetch(cookieHeader);
  log.info('Auth session from cookie fetch', {
    csrfLen: tokens.csrfToken.length,
    sessionIdLen: tokens.sessionId.length,
  });

  return {
    csrfToken: tokens.csrfToken,
    sessionId: tokens.sessionId,
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


