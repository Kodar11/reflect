import type { ContextEntry, DimensionEntry, EventLike } from './Classification.js';
import {
  DEFAULT_CLASSIFICATION_DATA,
  type DefaultClassificationEntry,
} from './defaultClassificationData.js';

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
 *
 * The dataset lives in defaultClassificationData.ts. This file contains only
 * the matching algorithm and dimension resolution.
 */

export interface DefaultClassificationResult {
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: 'default';
  reason: string;
}

interface ClassificationIndexes {
  domainIndex: Map<string, DefaultClassificationEntry[]>;
  appIndex: Map<string, DefaultClassificationEntry[]>;
}

const CONFIDENCE_ORDER: Record<DefaultClassificationEntry['confidence'], number> = {
  high: 2,
  medium: 1,
  low: 0,
};

const APP_ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'code': 'Visual Studio Code',
  'chatgpt': 'ChatGPT',
};

const INDEXES = buildIndexes(DEFAULT_CLASSIFICATION_DATA);

/**
 * Classify a raw event against the declarative default dataset.
 * Returns null when no high/medium-confidence default is known.
 */
function findDefaultClassificationEntry(
  event: EventLike,
): DefaultClassificationEntry | null {
  const app = normalizeAppName(event.app);
  const domain = event.url ? getDomain(event.url) : '';
  return findBestMatch(app, domain, INDEXES);
}

export function getDefaultArea(event: EventLike): string | null {
  return findDefaultClassificationEntry(event)?.area ?? null;
}

export function classifyEventByDefault(
  event: EventLike,
  _contexts: ContextEntry[],
  dimensions: DimensionEntry[],
): DefaultClassificationResult | null {
  const match = findDefaultClassificationEntry(event);
  if (!match) return null;

  return {
    contextId: null,
    areaId: findDimensionId(dimensions, 'area', match.area),
    intentId: resolveIntent(dimensions, match.intent),
    qualityId: findDimensionId(dimensions, 'quality', match.quality),
    source: 'default',
    reason: `Default: ${match.name}`,
  };
}

/**
 * Find the single best dataset entry matching the event.
 *
 * Matching rules:
 *   - High confidence: exact domain match OR subdomain match OR exact app match.
 *   - Medium confidence: exact domain match OR exact app match (no subdomain expansion).
 *   - Low confidence: never matches automatically.
 *
 * Tie-breaking: priority desc, confidence desc, id asc.
 */
function findBestMatch(
  app: string,
  domain: string,
  indexes: ClassificationIndexes,
): DefaultClassificationEntry | null {
  const candidates = collectCandidates(app, domain, indexes);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;

    const confidenceDiff = CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence];
    if (confidenceDiff !== 0) return confidenceDiff;

    return a.id.localeCompare(b.id);
  });

  return candidates[0];
}

function collectCandidates(
  app: string,
  domain: string,
  indexes: ClassificationIndexes,
): DefaultClassificationEntry[] {
  const seen = new Set<string>();
  const candidates: DefaultClassificationEntry[] = [];

  const add = (entry: DefaultClassificationEntry): boolean => {
    if (entry.confidence === 'low') return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  };

  // App match — strong signal, allowed for high and medium confidence.
  if (app) {
    for (const entry of indexes.appIndex.get(app) ?? []) {
      if (add(entry)) candidates.push(entry);
    }
  }

  // Exact domain match — allowed for high and medium confidence.
  if (domain) {
    for (const entry of indexes.domainIndex.get(domain) ?? []) {
      if (add(entry)) candidates.push(entry);
    }

    // Subdomain match — allowed only for high-confidence entries.
    const parts = domain.split('.');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(i).join('.');
      for (const entry of indexes.domainIndex.get(parent) ?? []) {
        if (entry.confidence !== 'high') continue;
        if (add(entry)) candidates.push(entry);
      }
    }
  }

  return candidates;
}

/**
 * Build lookup indexes from the declarative dataset.
 * Built once at module load for O(1) lookups.
 */
function buildIndexes(data: DefaultClassificationEntry[]): ClassificationIndexes {
  const domainIndex = new Map<string, DefaultClassificationEntry[]>();
  const appIndex = new Map<string, DefaultClassificationEntry[]>();

  for (const entry of data) {
    for (const domain of entry.domains ?? []) {
      const normalized = normalizeDomainForIndex(domain);
      if (!normalized) continue;
      const list = domainIndex.get(normalized) ?? [];
      list.push(entry);
      domainIndex.set(normalized, list);
    }

    for (const app of entry.apps ?? []) {
      const normalized = normalizeAppName(app);
      if (!normalized) continue;
      const list = appIndex.get(normalized) ?? [];
      list.push(entry);
      appIndex.set(normalized, list);
    }
  }

  return { domainIndex, appIndex };
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
export function normalizeAppName(app: string | null | undefined): string {
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

/**
 * Normalize a domain before adding it to the index.
 * - lowercase
 * - strip leading `www.`
 * - strip leading `*.`
 * - trim whitespace
 */
function normalizeDomainForIndex(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^www\./, '');
}

/**
 * Extract the registered domain from a URL.
 * - Strips protocol, path, query, and fragment.
 * - Strips leading `www.`.
 * - Lowercases the result.
 * - Returns empty string on failure.
 */
export function getDomain(rawUrl: string): string {
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
