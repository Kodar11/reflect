import {
  DEFAULT_CLASSIFICATION_DATA,
  type DefaultClassificationEntry,
} from '../categorization/defaultClassificationData.js';
import type { EffectiveBlockingConfig, FocusProfile, FocusProfileRule } from './FocusModels.js';

/**
 * Compiles a profile's rules into the exact hostnames and process names a
 * Focus session enforces. Pure and deterministic: the same rules always
 * produce the same config, regardless of rule order.
 *
 * PRECEDENCE — an explicit allow always wins over a block:
 *
 *   1. Every `block` rule is expanded and unioned into the blocked set.
 *   2. Every `allow` rule then removes what it covers from that set.
 *
 * So "block *.youtube.com" + "allow music.youtube.com" blocks YouTube except
 * music.youtube.com, and "block category social-media" + "allow linkedin.com"
 * blocks social media except LinkedIn. Order in the database is irrelevant.
 *
 * Website enforcement is a list of exact hostnames (the hosts file has no
 * wildcards), so an apex or `*.` rule is expanded to its known hostnames.
 */

type RuleInput = Pick<FocusProfileRule, 'type' | 'target' | 'action'>;

/** Hostname prefixes every apex/wildcard website rule is expanded with. */
const COMMON_PREFIXES = ['www', 'm'];

/**
 * Extra hostnames for sites that are served from more names than
 * `www.`/`m.` — without these, blocking the apex leaves an easy side door.
 */
const KNOWN_SITE_HOSTS: Record<string, string[]> = {
  'youtube.com': ['music.youtube.com', 'gaming.youtube.com', 'tv.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'],
  'twitter.com': ['mobile.twitter.com', 'x.com', 'www.x.com', 'mobile.x.com'],
  'x.com': ['mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
  'facebook.com': ['web.facebook.com', 'touch.facebook.com', 'fb.com', 'www.fb.com'],
  'instagram.com': ['instagr.am'],
  'reddit.com': ['old.reddit.com', 'new.reddit.com', 'sh.reddit.com', 'redd.it'],
  'tiktok.com': ['vm.tiktok.com'],
  'twitch.tv': ['player.twitch.tv', 'clips.twitch.tv'],
  'netflix.com': ['nflxvideo.net'],
  'spotify.com': ['open.spotify.com'],
  'discord.com': ['discordapp.com', 'ptb.discord.com', 'canary.discord.com'],
  'steampowered.com': ['store.steampowered.com', 'steamcommunity.com', 'www.steamcommunity.com'],
  'linkedin.com': ['in.linkedin.com'],
  'pinterest.com': ['in.pinterest.com', 'pin.it'],
};

/**
 * Focus category names → the organizing categories of the default
 * classification dataset. Focus reuses that dataset instead of keeping a
 * second list of "what counts as social media".
 */
const CATEGORY_ALIASES: Record<string, DefaultClassificationEntry['category'][]> = {
  'social-media': ['social'],
  social: ['social'],
  entertainment: ['entertainment'],
  streaming: ['entertainment'],
  gaming: ['gaming'],
  games: ['gaming'],
  shopping: ['shopping'],
  news: ['news'],
  communication: ['communication'],
  messaging: ['communication'],
};

/**
 * The dataset names applications the way the tracker displays them
 * ("Discord"); enforcement needs process image names.
 */
const APP_PROCESS_NAMES: Record<string, string[]> = {
  Discord: ['discord.exe'],
  Slack: ['slack.exe'],
  Telegram: ['telegram.exe'],
  WhatsApp: ['whatsapp.exe'],
  Skype: ['skype.exe'],
  Zoom: ['zoom.exe'],
  'Microsoft Teams': ['teams.exe', 'ms-teams.exe'],
  Spotify: ['spotify.exe'],
  Twitch: ['twitch.exe'],
  Steam: ['steam.exe', 'steamwebhelper.exe'],
  'Epic Games Launcher': ['epicgameslauncher.exe'],
  'GOG Galaxy': ['galaxyclient.exe'],
  'Battle.net': ['battle.net.exe'],
  'Riot Client': ['riotclientservices.exe', 'riotclientux.exe'],
  'EA App': ['eadesktop.exe'],
  'Ubisoft Connect': ['upc.exe', 'ubisoftconnect.exe'],
  Xbox: ['xboxapp.exe', 'xboxpcapp.exe'],
};

/** Processes Focus must never terminate, whatever a rule says. */
export const PROTECTED_PROCESSES: ReadonlySet<string> = new Set([
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'dwm.exe', 'explorer.exe', 'fontdrvhost.exe', 'conhost.exe', 'sihost.exe', 'taskhostw.exe',
  'ctfmon.exe', 'runtimebroker.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe',
  'taskmgr.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'tasklist.exe', 'taskkill.exe', 'ipconfig.exe',
  'electron.exe', 'productivity coach.exe', 'reflect.exe', 'node.exe',
]);

export const MAX_BLOCKED_DOMAINS = 2000;
export const MAX_BLOCKED_APPS = 200;

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PROCESS_RE = /^[a-z0-9][a-z0-9 ._+-]{0,62}\.exe$/;

export interface ParsedWebsiteTarget {
  host: string;
  /** True when the rule covers the host and everything under it. */
  subtree: boolean;
}

/**
 * Parse a website rule target ("youtube.com", "*.youtube.com",
 * "https://www.youtube.com/watch") into a hostname. Returns null when the
 * target is not a usable hostname.
 */
export function parseWebsiteTarget(raw: string): ParsedWebsiteTarget | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);

  let wildcard = false;
  if (s.startsWith('*.')) {
    wildcard = true;
    s = s.slice(2);
  }
  if (!isValidHostname(s)) return null;

  const labels = s.split('.');
  if (labels[0] === 'www' && labels.length > 2) {
    // "www.youtube.com" means the site, not one hostname.
    return { host: labels.slice(1).join('.'), subtree: true };
  }
  // A bare registrable-looking name ("youtube.com", "bbc.co.uk") covers the
  // site; a deeper name ("mail.google.com") is taken literally.
  return { host: s, subtree: wildcard || labels.length === 2 || isTwoPartSuffix(labels) };
}

export function isValidHostname(host: string): boolean {
  return HOSTNAME_RE.test(host) && !/^\d+(\.\d+){3}$/.test(host) && host !== 'localhost';
}

/** "example.co.uk" — three labels where the last two are a public suffix. */
function isTwoPartSuffix(labels: string[]): boolean {
  if (labels.length !== 3) return false;
  return ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(labels[1]) && labels[2].length === 2;
}

/** Normalize an app rule target to a process image name, or null. */
export function parseAppTarget(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.split(/[\\/]/).pop() ?? '';
  if (!s) return null;
  if (!/\.[a-z0-9]{1,4}$/.test(s)) s = `${s}.exe`;
  if (!PROCESS_RE.test(s)) return null;
  if (PROTECTED_PROCESSES.has(s)) return null;
  return s;
}

export function normalizeCategoryTarget(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Every hostname an apex/wildcard website rule stands for. */
function expandSite(host: string): string[] {
  const out = new Set<string>([host]);
  for (const prefix of COMMON_PREFIXES) out.add(`${prefix}.${host}`);
  for (const extra of KNOWN_SITE_HOSTS[host] ?? []) out.add(extra);
  return [...out].filter(isValidHostname);
}

interface CategoryMembers {
  sites: ParsedWebsiteTarget[];
  apps: string[];
}

/** Sites and processes belonging to a Focus category; empty if unknown. */
export function resolveCategory(rawTarget: string): CategoryMembers {
  const categories = CATEGORY_ALIASES[normalizeCategoryTarget(rawTarget)];
  const members: CategoryMembers = { sites: [], apps: [] };
  if (!categories) return members;
  for (const entry of DEFAULT_CLASSIFICATION_DATA) {
    if (!categories.includes(entry.category)) continue;
    for (const domain of entry.domains ?? []) {
      const parsed = parseWebsiteTarget(domain);
      if (parsed) members.sites.push(parsed);
    }
    for (const app of entry.apps ?? []) {
      for (const processName of APP_PROCESS_NAMES[app] ?? []) members.apps.push(processName);
    }
  }
  return members;
}

export const KNOWN_FOCUS_CATEGORIES: string[] = Object.keys(CATEGORY_ALIASES).sort();

/** The categories offered in the UI, in display order. */
const CATEGORY_LABELS: Array<{ id: string; label: string }> = [
  { id: 'social-media', label: 'Social media' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'gaming', label: 'Games' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'news', label: 'News' },
  { id: 'communication', label: 'Messaging' },
];

/** Different spellings of the same category collapse to one id. */
const CATEGORY_CANONICAL: Record<string, string> = {
  social: 'social-media',
  streaming: 'entertainment',
  games: 'gaming',
  messaging: 'communication',
};

export interface CategoryOption {
  id: string;
  label: string;
  siteCount: number;
  appCount: number;
}

/** Categories that actually resolve to something blockable. */
export function listCategoryOptions(): CategoryOption[] {
  return CATEGORY_LABELS.map(({ id, label }) => {
    const config = compileBlockingRules([{ type: 'category', target: id, action: 'block' }]);
    return { id, label, siteCount: config.domains.length, appCount: config.apps.length };
  }).filter((c) => c.siteCount + c.appCount > 0);
}

type BlockType = RuleInput['type'];

/**
 * The one stored spelling of a block target, or null if it cannot be
 * enforced. "https://www.YouTube.com/watch?v=1", "youtube.com" and
 * "*.youtube.com" are the same block; so are "Discord" and "discord.exe".
 */
export function canonicalBlockTarget(type: BlockType, raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (type === 'website') return parseWebsiteTarget(raw)?.host ?? null;
  if (type === 'app') return parseAppTarget(raw);
  const id = normalizeCategoryTarget(raw);
  const canonical = CATEGORY_CANONICAL[id] ?? id;
  return CATEGORY_ALIASES[canonical] ? canonical : null;
}

const PROCESS_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(APP_PROCESS_NAMES).map(([name, processes]) => [processes[0], name]),
);

/** "discord.exe" → "Discord"; unknown processes get a tidy version of the name. */
export function appDisplayName(processName: string): string {
  const exe = processName.trim().toLowerCase();
  const known = PROCESS_DISPLAY_NAMES[exe];
  if (known) return known;
  const base = exe.replace(/\.exe$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** What the user sees for a rule — never a raw identifier where a name exists. */
export function blockLabel(type: BlockType, target: string): string {
  const canonical = canonicalBlockTarget(type, target);
  if (!canonical) return target;
  if (type === 'app') return appDisplayName(canonical);
  if (type === 'category') return CATEGORY_LABELS.find((c) => c.id === canonical)?.label ?? canonical;
  return canonical;
}

const DISABLED: EffectiveBlockingConfig = { enabled: false, domains: [], apps: [], rules: [] };

export function compileBlockingRules(rules: RuleInput[]): EffectiveBlockingConfig {
  const blockedHosts = new Set<string>();
  const blockedApps = new Set<string>();

  const sites = (rule: RuleInput): ParsedWebsiteTarget[] => {
    if (rule.type === 'website') {
      const parsed = parseWebsiteTarget(rule.target);
      return parsed ? [parsed] : [];
    }
    return rule.type === 'category' ? resolveCategory(rule.target).sites : [];
  };
  const apps = (rule: RuleInput): string[] => {
    if (rule.type === 'app') {
      const parsed = parseAppTarget(rule.target);
      return parsed ? [parsed] : [];
    }
    return rule.type === 'category' ? resolveCategory(rule.target).apps : [];
  };

  for (const rule of rules) {
    if (rule.action !== 'block') continue;
    for (const site of sites(rule)) {
      for (const host of site.subtree ? expandSite(site.host) : [site.host]) blockedHosts.add(host);
    }
    for (const app of apps(rule)) blockedApps.add(app);
  }

  for (const rule of rules) {
    if (rule.action !== 'allow') continue;
    for (const site of sites(rule)) {
      for (const host of [...blockedHosts]) {
        const covered = host === site.host || (site.subtree && host.endsWith(`.${site.host}`));
        if (covered) blockedHosts.delete(host);
      }
      if (site.subtree) {
        // The allowed site's known aliases (youtu.be for youtube.com) too.
        for (const alias of expandSite(site.host)) blockedHosts.delete(alias);
      }
    }
    for (const app of apps(rule)) blockedApps.delete(app);
  }

  const domains = [...blockedHosts].sort().slice(0, MAX_BLOCKED_DOMAINS);
  const appList = [...blockedApps].filter((a) => !PROTECTED_PROCESSES.has(a)).sort().slice(0, MAX_BLOCKED_APPS);
  return {
    enabled: domains.length > 0 || appList.length > 0,
    domains,
    apps: appList,
    rules: rules
      .map((r) => ({ type: r.type, target: r.target, action: r.action }))
      .sort((a, b) => `${a.action}|${a.type}|${a.target}`.localeCompare(`${b.action}|${b.type}|${b.target}`)),
  };
}

/** The blocking a session started from this profile would enforce. */
export function compileBlockingConfig(profile: Pick<FocusProfile, 'blocksDistractions' | 'rules'>): EffectiveBlockingConfig {
  if (!profile.blocksDistractions) return { ...DISABLED };
  return compileBlockingRules(profile.rules);
}

/** True when `domain` (as seen in a browser tab) is covered by the blocked hosts. */
export function isDomainBlocked(domain: string, blockedHosts: readonly string[]): boolean {
  const host = domain.trim().toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  return blockedHosts.some((blocked) => {
    const b = blocked.replace(/^www\./, '');
    return host === b || host.endsWith(`.${b}`);
  });
}

/** Number of block rules — what the UI calls "N rules". */
export function countBlockRules(config: EffectiveBlockingConfig | null): number {
  return config ? config.rules.filter((r) => r.action === 'block').length : 0;
}

/** Parse a stored snapshot defensively; anything malformed means "no snapshot". */
export function parseBlockingConfig(json: string | null): EffectiveBlockingConfig | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<EffectiveBlockingConfig>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const domains = strings(raw.domains).filter(isValidHostname);
    const apps = strings(raw.apps).filter((a) => PROCESS_RE.test(a) && !PROTECTED_PROCESSES.has(a));
    const rules = Array.isArray(raw.rules)
      ? raw.rules.filter(
          (r): r is RuleInput =>
            !!r && typeof r === 'object' && typeof r.target === 'string' &&
            ['app', 'website', 'category'].includes(r.type) && ['block', 'allow'].includes(r.action),
        )
      : [];
    return { enabled: Boolean(raw.enabled) && (domains.length > 0 || apps.length > 0), domains, apps, rules };
  } catch {
    return null;
  }
}
