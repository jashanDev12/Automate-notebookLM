import { createLogger } from './logger';
import { ensureTabBridge } from './tab-proxy';
import { unescapeWizValue, WIZ_FIELD_PATTERNS } from './wiz';

const log = createLogger('tab-session');

export interface TabSession {
  tabId: number;
  csrfToken: string;
  sessionId: string;
  authuser?: string;
}

/** Read live session tokens from the NotebookLM tab (MAIN world first, then HTML). */
export async function readTabSession(tabId: number): Promise<TabSession> {
  log.debug('Reading tab session', { tabId });
  await ensureTabBridge(tabId);

  const fromMainWorld = await readWizFromMainWorld(tabId);
  if (fromMainWorld?.csrfToken && fromMainWorld.sessionId) {
    log.info('Session tokens read via MAIN world WIZ_global_data', {
      tabId,
      authuser: fromMainWorld.authuser,
      csrfLen: fromMainWorld.csrfToken.length,
      sessionIdLen: fromMainWorld.sessionId.length,
    });
    return {
      tabId,
      csrfToken: fromMainWorld.csrfToken,
      sessionId: fromMainWorld.sessionId,
      authuser: fromMainWorld.authuser,
    };
  }
  log.debug('MAIN world tokens unavailable', { tabId });

  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: 'NLM_GET_SESSION' })) as {
      signedIn?: boolean;
      csrfToken?: string;
      sessionId?: string;
      authuser?: string;
      error?: string;
    };
    if (response.error) throw new Error(response.error);
    if (response.signedIn && response.csrfToken && response.sessionId) {
      log.info('Session tokens read via content script', {
        tabId,
        authuser: response.authuser,
        csrfLen: response.csrfToken.length,
        sessionIdLen: response.sessionId.length,
      });
      return {
        tabId,
        csrfToken: response.csrfToken,
        sessionId: response.sessionId,
        authuser: response.authuser,
      };
    }
    log.warn('Content script returned no session', { tabId, signedIn: response.signedIn });
  } catch (err) {
    log.warn('Content script session read failed', err, { tabId });
  }

  const fromHtml = await readWizFromHtmlInjection(tabId);
  if (fromHtml?.csrfToken && fromHtml.sessionId) {
    log.info('Session tokens read via HTML injection', {
      tabId,
      authuser: fromHtml.authuser,
      csrfLen: fromHtml.csrfToken.length,
      sessionIdLen: fromHtml.sessionId.length,
    });
    return {
      tabId,
      csrfToken: fromHtml.csrfToken,
      sessionId: fromHtml.sessionId,
      authuser: fromHtml.authuser,
    };
  }

  log.error('All session read paths failed', undefined, { tabId });
  throw new Error(
    'Could not read NotebookLM session from the open tab. Refresh the NotebookLM tab (F5), wait for your notebooks to load, then click Refresh.',
  );
}

async function readWizFromMainWorld(tabId: number): Promise<{
  csrfToken: string | null;
  sessionId: string | null;
  authuser?: string;
} | null> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const wiz = (window as unknown as { WIZ_global_data?: Record<string, unknown> })
          .WIZ_global_data;
        const authuser = new URLSearchParams(location.search).get('authuser');
        const csrf = wiz?.SNlM0e;
        const sid = wiz?.FdrFJe;
        return {
          csrfToken: typeof csrf === 'string' ? csrf : null,
          sessionId: typeof sid === 'string' ? sid : null,
          authuser: authuser ?? undefined,
          pageUrl: location.href,
        };
      },
    });
    const result = injection?.result as {
      csrfToken: string | null;
      sessionId: string | null;
      authuser?: string;
      pageUrl?: string;
    } | undefined;
    if (result?.pageUrl) {
      log.debug('MAIN world probe', { tabId, pageUrl: result.pageUrl });
    }
    return result ?? null;
  } catch (err) {
    log.debug('MAIN world executeScript failed', err, { tabId });
    return null;
  }
}

async function readWizFromHtmlInjection(tabId: number): Promise<{
  csrfToken: string;
  sessionId: string;
  authuser?: string;
} | null> {
  const patterns = [
    { key: 'SNlM0e', patterns: WIZ_FIELD_PATTERNS('SNlM0e').map((r) => r.source) },
    { key: 'FdrFJe', patterns: WIZ_FIELD_PATTERNS('FdrFJe').map((r) => r.source) },
  ];

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fieldPatterns: { key: string; patterns: string[] }[]) => {
        const html = document.documentElement.innerHTML;
        if (
          html.includes('accounts.google.com/v3/signin') ||
          html.includes('ServiceLogin')
        ) {
          return { error: 'sign-in' as const };
        }
        const authuser = new URLSearchParams(location.search).get('authuser') ?? undefined;
        const out: Record<string, string | null> = {};
        for (const { key, patterns: pats } of fieldPatterns) {
          out[key] = null;
          for (const source of pats) {
            const match = html.match(new RegExp(source));
            if (match?.[1]) {
              out[key] = match[1];
              break;
            }
          }
        }
        return { tokens: out, authuser };
      },
      args: [patterns],
    });

    const result = injection?.result as
      | { error: 'sign-in' }
      | { tokens: Record<string, string | null>; authuser?: string }
      | undefined;

    if (!result) return null;
    if ('error' in result) {
      log.warn('HTML injection found sign-in page', { tabId });
      return null;
    }

    const csrfRaw = result.tokens.SNlM0e;
    const sidRaw = result.tokens.FdrFJe;
    if (!csrfRaw || !sidRaw) {
      log.warn('HTML injection: tokens missing in page HTML', {
        tabId,
        hasCsrf: Boolean(csrfRaw),
        hasSessionId: Boolean(sidRaw),
      });
      return null;
    }

    return {
      csrfToken: unescapeWizValue(csrfRaw),
      sessionId: unescapeWizValue(sidRaw),
      authuser: result.authuser,
    };
  } catch (err) {
    log.warn('HTML injection failed', err, { tabId });
    return null;
  }
}
