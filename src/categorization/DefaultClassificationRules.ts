import type { ContextEntry, DimensionEntry, EventLike } from './Classification.js';

/**
 * Pure, deterministic default event classification.
 *
 * This is the conservative fallback layer when:
 *   - the user has not manually classified the event, and
 *   - no enabled tracking rule matches the event.
 *
 * It is:
 *   - pure (no side effects)
 *   - deterministic (same event + dictionaries → same result)
 *   - independent of React, SQLite, Electron, Date.now, and random values
 *
 * Default classifications are intentionally NOT persisted. They are calculated
 * on demand in CategorizationService.getResolvedEventClassifications().
 */

export interface DefaultClassificationResult {
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: 'default';
  reason: string;
}

interface DefaultMatch {
  name: string;
  contextId: string | null;
  areaName: string;
  intentName: string;
  qualityName: string;
}

const LEARNING_DOMAINS = new Set([
  'docs.python.org',
  'developer.mozilla.org',
  'react.dev',
  'nextjs.org',
  'nodejs.org',
  'docs.npmjs.com',
  'learn.microsoft.com',
  'docs.github.com',
]);

/**
 * Classify a raw event using deterministic application/domain heuristics.
 * Returns null when no high-confidence default is known.
 */
export function classifyEventByDefault(
  event: EventLike,
  _contexts: ContextEntry[],
  dimensions: DimensionEntry[],
): DefaultClassificationResult | null {
  const app = normalizeAppName(event.app);
  const domain = event.url ? getDomain(event.url) : '';

  const match = findDefaultMatch(app, domain);
  if (!match) return null;

  return {
    contextId: match.contextId,
    areaId: findDimensionId(dimensions, 'area', match.areaName),
    intentId: resolveIntent(dimensions, match.intentName),
    qualityId: findDimensionId(dimensions, 'quality', match.qualityName),
    source: 'default',
    reason: `Default: ${match.name}`,
  };
}

function findDefaultMatch(app: string, domain: string): DefaultMatch | null {
  // ChatGPT — domain or standalone app.
  if (domain === 'chatgpt.com' || app === 'chatgpt') {
    return {
      name: 'ChatGPT',
      contextId: null,
      areaName: 'Work',
      intentName: 'Research',
      qualityName: 'Focused',
    };
  }

  // VS Code: — clear code editor signal.
  if (app === 'visual studio code' || app === 'vscode') {
    return {
      name: 'VS Code:',
      contextId: null,
      areaName: 'Work',
      intentName: 'Create',
      qualityName: 'Focused',
    };
  }

  // YouTube — domain or app.
  if (domain === 'youtube.com' || app === 'youtube') {
    return {
      name: 'YouTube',
      contextId: null,
      areaName: 'Leisure',
      intentName: 'Consume',
      qualityName: 'Routine',
    };
  }

  // Recognized learning / documentation domains.
  if (LEARNING_DOMAINS.has(domain)) {
    return {
      name: 'Documentation',
      contextId: null,
      areaName: 'Learning',
      intentName: 'Learn',
      qualityName: 'Focused',
    };
  }

  return null;
}

/**
 * Resolve an intent dimension by name, with an ordered fallback list.
 * This lets us prefer `Research` when it exists without inventing IDs.
 */
function resolveIntent(
  dimensions: DimensionEntry[],
  primaryName: string,
): string | null {
  if (primaryName === 'Research') {
    return (
      findDimensionId(dimensions, 'intent', 'Research') ??
      findDimensionId(dimensions, 'intent', 'Learn') ??
      findDimensionId(dimensions, 'intent', 'Create')
    );
  }
  return findDimensionId(dimensions, 'intent', primaryName);
}

/**
 * Find a dimension ID by its type and human-readable name.
 * Returns null if no matching dimension exists.
 */
function findDimensionId(
  dimensions: DimensionEntry[],
  dimension: 'area' | 'intent' | 'quality',
  name: string,
): string | null {
  const want = name.toLowerCase();
  const found = dimensions.find(
    (d) => d.dimension === dimension && d.name.toLowerCase() === want,
  );
  return found?.id ?? null;
}

/**
 * Normalize an application name for matching.
 * - trims whitespace
 * - removes a trailing `.exe`
 * - removes a trailing colon (macOS menu-bar naming)
 * - maps known aliases to canonical forms
 * - lowercases for case-insensitive comparison
 */
function normalizeAppName(app: string | null | undefined): string {
  if (!app) return '';
  let normalized = app.trim();
  if (normalized.toLowerCase().endsWith('.exe')) {
    normalized = normalized.slice(0, -4);
  }
  if (normalized.endsWith(':')) {
    normalized = normalized.slice(0, -1);
  }
  const alias = APP_ALIASES[normalized.toLowerCase()];
  return (alias ?? normalized).toLowerCase();
}

const APP_ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'code': 'Visual Studio Code',
  'chatgpt': 'ChatGPT',
};

/**
 * Extract the registered domain from a URL.
 * - Strips protocol, path, query, and fragment.
 * - Strips leading `www.`.
 * - Lowercases the result.
 * - Returns empty string on failure.
 */
function getDomain(rawUrl: string): string {
  try {
    let url = rawUrl.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    const u = new URL(url);
    const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
    return host.toLowerCase();
  } catch {
    const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:?#]+)/i);
    return (match?.[1] ?? '').toLowerCase();
  }
}
