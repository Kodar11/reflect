import type { CategorizationRule, RuleCondition, RuleSource, SessionLike } from './Classification.js';

/**
 * Pure rule matching and specificity scoring.
 *
 * No React / SQLite / Electron / Date.now / Math.random.
 * Same inputs always yield the same outputs.
 */

/**
 * Deterministic application-name aliases.
 * Maps common short names to their canonical tracked name and vice versa.
 * Matching is still exact after normalization.
 */
const APP_ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'chrome': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'edge': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  'firefox': 'Mozilla Firefox',
  'mozilla firefox': 'Mozilla Firefox',
};

/**
 * Normalize an application name for matching.
 * - Trims whitespace
 * - Removes a trailing .exe
 * - Maps known aliases to a canonical form
 * - Lowercases for case-insensitive comparison
 */
export function normalizeAppName(app: string): string {
  let normalized = app.trim();
  if (normalized.toLowerCase().endsWith('.exe')) {
    normalized = normalized.slice(0, -4);
  }
  const alias = APP_ALIASES[normalized.toLowerCase()];
  return (alias ?? normalized).toLowerCase();
}

/**
 * Legacy condition-type names created by older UI versions.
 * Normalized at runtime so existing rules keep working without migration.
 */
const LEGACY_CONDITION_TYPES: Record<string, RuleCondition['type']> = {
  application: 'app_equals',
  app: 'app_equals',
  app_name: 'app_equals',
  browser: 'browser_equals',
  title: 'title_contains',
  url: 'url_contains',
  domain: 'domain_equals',
};

/**
 * Normalize a single condition so legacy rules match the current engine.
 */
export function normalizeCondition(c: RuleCondition): RuleCondition {
  const type = LEGACY_CONDITION_TYPES[c.type.toLowerCase()] ?? (c.type as RuleCondition['type']);
  return { type, value: c.value };
}

/**
 * Normalize all conditions on a rule in-place (returns the same rule object).
 */
export function normalizeRuleConditions(rule: CategorizationRule): CategorizationRule {
  rule.conditions = rule.conditions.map(normalizeCondition);
  return rule;
}

/**
 * Check whether all conditions in a rule match the session.
 * Conditions are AND-combined. Empty conditions never match.
 */
export function matchConditions(s: SessionLike, conditions: RuleCondition[]): boolean {
  if (conditions.length === 0) return false;
  return conditions.every((c) => matchSingleCondition(s, c));
}

function matchSingleCondition(s: SessionLike, c: RuleCondition): boolean {
  const normalized = normalizeCondition(c);
  const val = normalized.value.toLowerCase().trim();
  if (!val) return false;

  switch (normalized.type) {
    case 'app_equals': {
      const want = normalizeAppName(normalized.value);
      const app = normalizeAppName(s.primaryApp ?? '');
      const apps = (s.appsUsed ?? []).map(normalizeAppName);
      return app === want || apps.includes(want);
    }
    case 'browser_equals': {
      const browser = (s.primaryBrowser ?? '').toLowerCase().trim();
      return browser === val || browser.includes(val);
    }
    case 'title_contains': {
      const title = (s.primaryTitle ?? '').toLowerCase();
      return title.includes(val);
    }
    case 'url_contains': {
      const url = (s.primaryUrl ?? '').toLowerCase();
      const tabs = (s.browserTabs ?? []).map((x) => x.toLowerCase());
      return url.includes(val) || tabs.some((t) => t.includes(val));
    }
    case 'url_starts_with': {
      const url = (s.primaryUrl ?? '').toLowerCase();
      const tabs = (s.browserTabs ?? []).map((x) => x.toLowerCase());
      return url.startsWith(val) || tabs.some((t) => t.startsWith(val));
    }
    case 'domain_equals': {
      const domain = getDomain(s.primaryUrl ?? '').toLowerCase();
      const tabDomains = (s.browserTabs ?? []).map((t) => getDomain(t).toLowerCase());
      return domain === val || tabDomains.includes(val);
    }
    default:
      return false;
  }
}

export function getDomain(rawUrl: string): string {
  try {
    let host = rawUrl.trim();
    if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
    const u = new URL(host);
    return u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
  } catch {
    const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
    return match?.[1] ?? rawUrl;
  }
}

/**
 * Specificity = number of non-empty conditions.
 * More conditions = more specific rule = higher precedence.
 */
export function specificity(rule: CategorizationRule): number {
  return rule.conditions.filter((c) => c.value.trim().length > 0).length;
}

/**
 * Explicit user intent is stronger than AI-derived learning, which is stronger
 * than a seeded default. Lower = wins.
 */
const SOURCE_RANK: Record<RuleSource, number> = { user: 0, learned: 1, system: 2 };

export function sourceRank(rule: CategorizationRule): number {
  return SOURCE_RANK[rule.source ?? 'user'] ?? SOURCE_RANK.user;
}

/**
 * Deterministic comparison for rule ordering.
 * 0. source (user → learned → system)
 * 1. priority DESC (explicit user-set priority)
 * 2. specificity DESC (more conditions = more specific = wins)
 * 3. id ASC (stable creation-order tiebreak, never random)
 */
export function compareRules(a: CategorizationRule, b: CategorizationRule): number {
  const rankA = sourceRank(a);
  const rankB = sourceRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const specA = specificity(a);
  const specB = specificity(b);
  if (specA !== specB) return specB - specA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort rules deterministically for classification.
 * Returns a new array; does not mutate the input.
 */
export function sortRules(rules: CategorizationRule[]): CategorizationRule[] {
  return [...rules].sort(compareRules);
}

/**
 * Produce a human-readable summary of a rule's conditions.
 * e.g. "app=VS Code, domain=github.com"
 */
export function summarizeConditions(conditions: RuleCondition[]): string {
  const parts = conditions.map((c) => {
    const normalized = normalizeCondition(c);
    const label =
      normalized.type === 'app_equals' ? 'app' :
      normalized.type === 'browser_equals' ? 'browser' :
      normalized.type === 'title_contains' ? 'title~' :
      normalized.type === 'url_contains' ? 'url~' :
      normalized.type === 'url_starts_with' ? 'url^' :
      normalized.type === 'domain_equals' ? 'domain' :
      normalized.type;
    return `${label}=${normalized.value}`;
  });
  return parts.join(', ');
}
