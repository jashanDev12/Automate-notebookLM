import { MAX_TEXT_SOURCE_CHARS } from './constants';
import { createLogger } from './logger';

const log = createLogger('page-extract');

export interface ExtractedPageContent {
  title: string;
  content: string;
  truncated: boolean;
}

function truncateContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_SOURCE_CHARS) {
    return { content: text, truncated: false };
  }
  return {
    content: text.slice(0, MAX_TEXT_SOURCE_CHARS),
    truncated: true,
  };
}

/** Extract visible page text from a tab via scripting (requires activeTab or host permission). */
export async function extractPageContent(tabId: number): Promise<ExtractedPageContent> {
  log.info('Extracting page content', { tabId });

  let injection: chrome.scripting.InjectionResult | undefined;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title?.trim() || location.href;
        const clone = document.body?.cloneNode(true) as HTMLElement | null;
        if (clone) {
          clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
        }
        const text = (clone?.innerText ?? document.body?.innerText ?? '').replace(/\s+\n/g, '\n').trim();
        return { title, text, url: location.href };
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Page extraction script failed', err, { tabId });
    if (/Cannot access|chrome:\/\/|extension page|Extension manifest|cannot be scripted|chrome-extension:\/\//i.test(message)) {
      throw new Error(
        'This page cannot be read by the extension (browser-internal or restricted page). Open a normal http(s) web page and try again.',
      );
    }
    throw new Error('Could not read text from this page. Try Import URL instead.');
  }

  const result = injection?.result as { title: string; text: string; url: string } | undefined;
  if (!result?.text) {
    throw new Error('Could not read text from this page. Try Import URL instead.');
  }

  const { content, truncated } = truncateContent(result.text);
  log.info('Page content extracted', {
    tabId,
    titleLen: result.title.length,
    contentLen: content.length,
    truncated,
  });

  return {
    title: result.title,
    content,
    truncated,
  };
}
