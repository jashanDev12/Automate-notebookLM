/** Patterns to extract Google WIZ globals embedded in NotebookLM HTML. */
export const WIZ_FIELD_PATTERNS = (key: string) => [
  new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`),
  new RegExp(`'${key}'\\s*:\\s*'([^'\\\\]*(?:\\\\.[^"\\\\]*)*)'`),
  new RegExp(`&quot;${key}&quot;\\s*:\\s*&quot;((?:(?!&quot;).)*)&quot;`),
];

export function extractWizField(html: string, key: string): string | null {
  for (const pattern of WIZ_FIELD_PATTERNS(key)) {
    const match = html.match(pattern);
    if (match) return unescapeWizValue(match[1]);
  }
  return null;
}

/** Decode JS-style escapes from a WIZ_global_data string value. */
export function unescapeWizValue(value: string): string {
  if (!value.includes('\\')) return value;
  try {
    return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

export function isSignInPageHtml(html: string): boolean {
  return html.includes('accounts.google.com/v3/signin') || html.includes('ServiceLogin');
}
