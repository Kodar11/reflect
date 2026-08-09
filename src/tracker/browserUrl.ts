import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getBrowserUrl } = require('win-browser-url') as {
  getBrowserUrl(hwnd: number): string | null;
};

const SUPPORTED_BROWSERS: Record<string, string> = {
  brave: 'Brave',
  'google chrome': 'Chrome',
  chrome: 'Chrome',
  chromium: 'Chromium',
  'microsoft edge': 'Edge',
  edge: 'Edge',
  firefox: 'Firefox',
};

/** Return a canonical browser name, or undefined if we don't try to read its URL. */
export function normalizeBrowserName(appName: string): string | undefined {
  const lower = appName.toLowerCase();
  for (const [key, value] of Object.entries(SUPPORTED_BROWSERS)) {
    if (lower.includes(key)) {
      return value;
    }
  }
  return undefined;
}

export function isSupportedBrowser(appName: string): boolean {
  return normalizeBrowserName(appName) !== undefined;
}

const INTERNAL_PAGE_SCHEMES = /^(chrome|brave|edge|about|firefox|moz-extension|chrome-extension):/i;

/** Returns true for browser-internal pages we don't want to record as websites. */
export function isInternalPage(rawUrl: string): boolean {
  return INTERNAL_PAGE_SCHEMES.test(rawUrl.trim());
}

/** Extract the domain/host from a raw URL. Returns null on failure. */
export function getDomain(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    let host = rawUrl.trim();
    if (!/^https?:\/\//i.test(host)) {
      host = 'https://' + host;
    }
    const u = new URL(host);
    const domain = u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
    return domain || null;
  } catch {
    const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
    const candidate = match?.[1];
    return candidate && candidate.includes('.') ? candidate : null;
  }
}

/**
 * Ask the native Windows helper for the active browser tab URL, then return
 * only the domain/host. Returns null for unsupported apps, internal pages, or
 * any failure so the tracker can fall back to app-only recording.
 *
 * The `getUrl` parameter is the injection seam used by unit tests; production
 * code should leave it undefined so it defaults to the real native helper.
 */
export function getActiveBrowserDomain(
  hwnd: number,
  appName: string,
  getUrl: (hwnd: number) => string | null = getBrowserUrl,
): string | null {
  if (!isSupportedBrowser(appName)) {
    return null;
  }
  try {
    const raw = getUrl(hwnd);
    if (!raw || isInternalPage(raw)) {
      return null;
    }
    return getDomain(raw);
  } catch {
    return null;
  }
}
