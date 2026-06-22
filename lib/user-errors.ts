import {
  SourceProcessingError,
  SourceProcessingTimeoutError,
} from './source-status';

export type UserErrorContext = 'auth' | 'upload' | 'chunk' | 'export' | 'import' | 'general';

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultMessage(context: UserErrorContext): string {
  switch (context) {
    case 'auth':
      return 'Could not connect to NotebookLM. Open notebooklm.google.com, sign in, and click Connect.';
    case 'upload':
      return 'Upload failed. Keep the NotebookLM tab open and try again.';
    case 'chunk':
      return 'This part failed. Try again, or click "Resume waiting" if the upload already finished.';
    case 'export':
      return 'Export failed. Make sure the artifact is ready and try again.';
    case 'import':
      return 'Import failed. Keep the NotebookLM tab open and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

function isAlreadyFriendly(msg: string): boolean {
  if (msg.includes('\n')) return false;
  if (msg.length > 160) return false;
  if (
    /batchexecute|f\.req|x-goog-|RPC |\(status \d+\)|cookie|csrf|sessionId|Receiving end|JSON\.parse|last status:/i.test(
      msg,
    )
  ) {
    return false;
  }
  return true;
}

const PATTERNS: Array<{ test: (msg: string) => boolean; message: string }> = [
  {
    test: (m) => /No NotebookLM tab|notebooklm\.google\.com tab/i.test(m),
    message: 'Open notebooklm.google.com in this Chrome window, then click Connect.',
  },
  {
    test: (m) =>
      /Not signed into Google|sign.?in|Sign in|Couldn't sign you in|anonymous cookies/i.test(m),
    message: 'Sign in to Google at notebooklm.google.com, then click Connect again.',
  },
  {
    test: (m) =>
      /Could not connect to the NotebookLM tab|tab did not respond|Extension bridge|Refresh that tab/i.test(
        m,
      ),
    message: 'Refresh the NotebookLM tab (F5), then click Connect again.',
  },
  {
    test: (m) => /session tokens|wait until your notebooks|Notebooks appear/i.test(m),
    message: 'Wait until your notebooks appear on the NotebookLM tab, then click Connect again.',
  },
  {
    test: (m) => /Upload session expired/i.test(m),
    message: 'Upload session expired. Start the upload again.',
  },
  {
    test: (m) =>
      /Upload handshake failed|Upload finalize failed|Missing x-goog-upload-url/i.test(m),
    message: 'Upload to Google failed. Keep the NotebookLM tab open and try again.',
  },
  {
    test: (m) => /Prepared parts were cleared/i.test(m),
    message: 'Saved parts were cleared. Please upload the file again.',
  },
  {
    test: (m) => /already in progress|Finish the current retry/i.test(m),
    message: 'An upload is already running. Wait for it to finish or cancel first.',
  },
  {
    test: (m) => /FFmpeg|Invalid video duration|No segments produced/i.test(m),
    message: 'Video preparation failed. Try a different file or another prep option.',
  },
  {
    test: (m) => /RpcError|batchexecute|RPC .* failed/i.test(m),
    message: 'NotebookLM request failed. Refresh the NotebookLM tab and try again.',
  },
  {
    test: (m) => /Failed to load NotebookLM \(\d+\)/i.test(m),
    message: 'Could not reach NotebookLM. Check your connection and try again.',
  },
  {
    test: (m) => /Could not open a NotebookLM tab/i.test(m),
    message: 'Could not open NotebookLM. Allow the extension to open tabs and try again.',
  },
  {
    test: (m) => /NotebookLM rejected the session/i.test(m),
    message: 'Your NotebookLM session expired. Sign in again and click Connect.',
  },
  {
    test: (m) => /Mind map data not yet ready|Failed to fetch artifact|Export not supported/i.test(m),
    message: 'This artifact is not ready to export yet. Wait until it shows Ready, then try again.',
  },
  {
    test: (m) => /NotebookLM did not finish processing/i.test(m),
    message: 'NotebookLM is still processing this part. Click "Resume waiting" — do not re-upload.',
  },
  {
    test: (m) => /NotebookLM failed to process/i.test(m),
    message: 'NotebookLM could not process this file. Try a smaller part or a different format.',
  },
  {
    test: (m) => /no notebooks found/i.test(m),
    message: 'No notebooks found. Create one at notebooklm.google.com first.',
  },
  {
    test: (m) => /Only http|Browser-internal|Local or private|Switch to the page/i.test(m),
    message: 'This page cannot be imported. Use a public http:// or https:// link.',
  },
  {
    test: (m) => /Could not read text from this page/i.test(m),
    message: 'Could not read text from this page. Try Import URL instead.',
  },
  {
    test: (m) => /No text content found/i.test(m),
    message: 'No readable text on this page. Try Import URL or pick another page.',
  },
  {
    test: (m) => /Cannot access contents of the page|Extension manifest must request permission/i.test(m),
    message: 'Cannot read this tab. Click the extension icon on the page first, then try Import page text.',
  },
  {
    test: (m) => /Source rejected|Failed to extract source ID/i.test(m),
    message: 'NotebookLM rejected this source. The page may be blocked or unsupported.',
  },
];

/** Map internal errors to short, user-facing text. Full details stay in the debug log. */
export function toUserErrorMessage(
  err: unknown,
  context: UserErrorContext = 'general',
): string {
  if (err instanceof SourceProcessingTimeoutError) {
    return 'NotebookLM is still processing this part. Click "Resume waiting" — do not re-upload.';
  }
  if (err instanceof SourceProcessingError) {
    return 'NotebookLM could not process this file. Try a smaller part or a different format.';
  }

  const msg = rawMessage(err).trim();
  if (!msg) return defaultMessage(context);

  if (
    msg.startsWith('Unsupported file') ||
    msg.startsWith('File is ') ||
    msg.startsWith('Large file') ||
    msg.startsWith('Connected, but no notebooks')
  ) {
    return msg.split('\n')[0].trim();
  }

  for (const { test, message } of PATTERNS) {
    if (test(msg)) return message;
  }

  if (isAlreadyFriendly(msg)) {
    return msg;
  }

  return defaultMessage(context);
}
