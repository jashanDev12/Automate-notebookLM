import { isNotebookLmUrl } from './tab-proxy';

const ALLOWED_SCHEMES = new Set(['http', 'https']);
const BLOCKED_SCHEMES = new Set(['chrome', 'chrome-extension', 'file', 'about', 'data', 'javascript', 'blob']);

const LOCALHOST_NAMES = new Set(['localhost', 'localhost.localdomain']);
const LOCALHOST_SUFFIXES = ['.localhost', '.localhost.localdomain'];

export class UrlImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlImportValidationError';
  }
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const h = hostname.toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be';
  } catch {
    return false;
  }
}

function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase();
  if (LOCALHOST_NAMES.has(h)) return true;
  return LOCALHOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (isLocalhostName(host)) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.includes(':')) return false;
  return isPrivateIpv4(host);
}

/** Validate a URL before sending it to NotebookLM as a source. */
export function validateImportUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlImportValidationError('Invalid URL. Use a full http:// or https:// link.');
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme) || !ALLOWED_SCHEMES.has(scheme)) {
    throw new UrlImportValidationError(
      'Only http:// and https:// pages can be imported. Browser-internal pages are not supported.',
    );
  }

  if (!parsed.hostname) {
    throw new UrlImportValidationError('URL must include a hostname.');
  }

  if (isInternalHost(parsed.hostname)) {
    throw new UrlImportValidationError('Local or private network URLs cannot be imported.');
  }

  if (isNotebookLmUrl(url)) {
    throw new UrlImportValidationError(
      'Switch to the page you want to import, then try again. NotebookLM itself cannot be imported as a source.',
    );
  }
}
