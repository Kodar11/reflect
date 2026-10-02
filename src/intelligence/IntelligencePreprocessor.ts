import type { Event } from '../models/Event.js';
import type { EvidenceItem, PreprocessResult } from './IntelligenceModels.js';

/**
 * Local preprocessing before Gemini. Pure.
 *
 * The goal is a compact, clean evidence list — NOT an interpretation. We sort,
 * drop events that carry no evidence, normalize naming noise, redact obvious
 * secrets, and collapse back-to-back identical evidence. Every output item
 * keeps the raw event ids it stands for.
 */

/** Events shorter than this inside the window are flicker (alt-tab pass-through). */
const MIN_EVENT_MS = 1000;
/** Identical evidence separated by at most this gap is one block. */
const MERGE_GAP_MS = 60_000;
const MAX_TITLE_LENGTH = 160;
const MAX_URL_LENGTH = 160;

/** Obvious duplicate spellings of the same application. */
const APP_DISPLAY_NAMES: Record<string, string> = {
  code: 'VS Code',
  'visual studio code': 'VS Code',
  'vs code': 'VS Code',
  chrome: 'Chrome',
  'google chrome': 'Chrome',
  msedge: 'Edge',
  'microsoft edge': 'Edge',
  firefox: 'Firefox',
  'mozilla firefox': 'Firefox',
  brave: 'Brave',
  'brave browser': 'Brave',
  windowsterminal: 'Windows Terminal',
  'windows terminal': 'Windows Terminal',
  explorer: 'File Explorer',
  'windows explorer': 'File Explorer',
};

/** Trailing " - <application>" decorations that repeat the `app` field. */
const TITLE_APP_SUFFIX =
  /\s+[-–—]\s+(Google Chrome|Chromium|Brave|Mozilla Firefox|Firefox|Microsoft Edge|Visual Studio Code)$/i;

export function preprocessEvents(events: Event[], windowStart: string, windowEnd: string): PreprocessResult {
  const ws = Date.parse(windowStart);
  const we = Date.parse(windowEnd);
  const items: EvidenceItem[] = [];
  const droppedEventIds: number[] = [];

  for (const event of sortChronologically(events)) {
    const start = Date.parse(event.startedAt);
    const end = Date.parse(event.endedAt);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= we || end <= ws) continue;

    // Present only the portion of the event that falls inside this window.
    const clippedStart = Math.max(start, ws);
    const clippedEnd = Math.min(end, we);

    const app = normalizeApp(event.app);
    const browser = normalizeText(event.browser);
    const url = normalizeUrl(event.url);
    const title = normalizeTitle(event.title);

    if ((!app && !title && !url) || clippedEnd - clippedStart < MIN_EVENT_MS) {
      droppedEventIds.push(event.id);
      continue;
    }

    const last = items[items.length - 1];
    if (
      last &&
      last.watcher === event.watcher &&
      last.app === app &&
      last.browser === browser &&
      last.title === title &&
      last.url === url &&
      clippedStart - Date.parse(last.endedAt) <= MERGE_GAP_MS
    ) {
      last.endedAt = new Date(Math.max(clippedEnd, Date.parse(last.endedAt))).toISOString();
      last.sourceEventIds.push(event.id);
      continue;
    }

    items.push({
      id: event.id,
      watcher: event.watcher,
      startedAt: new Date(clippedStart).toISOString(),
      endedAt: new Date(clippedEnd).toISOString(),
      app,
      browser,
      title,
      url,
      sourceEventIds: [event.id],
    });
  }

  return { items, droppedEventIds };
}

/** startedAt asc, then id asc — stable regardless of repository ordering. */
export function sortChronologically<T extends { id: number; startedAt: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const d = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return d !== 0 ? d : a.id - b.id;
  });
}

export function normalizeApp(app: string | null | undefined): string | null {
  let name = normalizeText(app);
  if (!name) return null;
  if (name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4);
  if (name.endsWith(':')) name = name.slice(0, -1);
  name = name.trim();
  if (!name) return null;
  return APP_DISPLAY_NAMES[name.toLowerCase()] ?? name;
}

export function normalizeTitle(title: string | null | undefined): string | null {
  let text = normalizeText(title);
  if (!text) return null;
  text = text
    .replace(/^\(\d+\+?\)\s*/, '') // "(3) Inbox" unread counters
    .replace(/^[●•*]\s+/, '') // unsaved-file markers
    .replace(TITLE_APP_SUFFIX, '');
  text = redactSecrets(text).trim();
  if (!text) return null;
  return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH - 1) + '…' : text;
}

/**
 * Keep host + path (useful project/page evidence), drop credentials, query
 * string and fragment (where tokens live). Bare domains just get normalized.
 */
export function normalizeUrl(url: string | null | undefined): string | null {
  const raw = normalizeText(url);
  if (!raw) return null;
  let result: string;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return null;
    const path = parsed.pathname.replace(/\/+$/, '');
    result = host + redactSecrets(safeDecode(path));
  } catch {
    result = redactSecrets(raw.split(/[?#]/)[0]).toLowerCase().replace(/^www\./, '');
  }
  return result.length > MAX_URL_LENGTH ? result.slice(0, MAX_URL_LENGTH) : result;
}

/** Remove obvious secrets without touching ordinary words. */
export function redactSecrets(text: string): string {
  return text
    // query strings / fragments on embedded URLs
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1')
    // key=value / key: value credentials
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)(\s*[=:]\s*)\S+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer [REDACTED]')
    // well-known token shapes
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    // long opaque hex blobs
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]');
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value
    // zero-width + control characters
    .replace(/[​-‍⁠﻿\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
