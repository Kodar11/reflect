import { describe, it, expect } from 'vitest';
import {
  compileBlockingConfig,
  compileBlockingRules,
  countBlockRules,
  isDomainBlocked,
  parseAppTarget,
  parseBlockingConfig,
  parseWebsiteTarget,
  resolveCategory,
} from '../../src/focus/BlockingConfig.js';
import type { FocusProfileRule } from '../../src/focus/FocusModels.js';

type Rule = Pick<FocusProfileRule, 'type' | 'target' | 'action'>;
const block = (type: Rule['type'], target: string): Rule => ({ type, target, action: 'block' });
const allow = (type: Rule['type'], target: string): Rule => ({ type, target, action: 'allow' });

describe('website targets', () => {
  it.each([
    ['youtube.com', { host: 'youtube.com', subtree: true }],
    ['*.youtube.com', { host: 'youtube.com', subtree: true }],
    ['www.youtube.com', { host: 'youtube.com', subtree: true }],
    ['  HTTPS://www.YouTube.com/watch?v=1  ', { host: 'youtube.com', subtree: true }],
    ['youtube.com:443', { host: 'youtube.com', subtree: true }],
    ['youtube.com.', { host: 'youtube.com', subtree: true }],
    ['bbc.co.uk', { host: 'bbc.co.uk', subtree: true }],
    ['mail.google.com', { host: 'mail.google.com', subtree: false }],
    ['*.mail.google.com', { host: 'mail.google.com', subtree: true }],
  ])('parses %s', (input, expected) => {
    expect(parseWebsiteTarget(input)).toEqual(expected);
  });

  it.each(['', '   ', 'localhost', 'not a domain', '127.0.0.1', 'youtube', 'a..b', '-bad.com', '# comment.com', 'evil.com 0.0.0.0'])(
    'rejects %j',
    (input) => {
      expect(parseWebsiteTarget(input)).toBeNull();
    },
  );
});

describe('app targets', () => {
  it.each([
    ['discord.exe', 'discord.exe'],
    ['Discord', 'discord.exe'],
    ['C:\\Program Files\\Steam\\Steam.exe', 'steam.exe'],
    ['battle.net.exe', 'battle.net.exe'],
  ])('normalizes %s', (input, expected) => {
    expect(parseAppTarget(input)).toBe(expected);
  });

  it.each(['', 'explorer.exe', 'svchost', 'lsass.exe', 'electron.exe', 'cmd', 'a&b.exe', 'x"y.exe'])('refuses %j', (input) => {
    expect(parseAppTarget(input)).toBeNull();
  });
});

describe('category resolution reuses the classification dataset', () => {
  it('resolves social media to sites and apps', () => {
    const social = resolveCategory('social-media');
    const hosts = social.sites.map((s) => s.host);
    expect(hosts).toEqual(expect.arrayContaining(['instagram.com', 'facebook.com', 'reddit.com', 'x.com', 'twitter.com']));
    expect(hosts).not.toContain('github.com');
  });

  it('accepts the names users actually type', () => {
    expect(resolveCategory('Social Media').sites.length).toBeGreaterThan(0);
    expect(resolveCategory('social_media')).toEqual(resolveCategory('social-media'));
    expect(resolveCategory('ENTERTAINMENT').sites.map((s) => s.host)).toContain('netflix.com');
    expect(resolveCategory('gaming').apps).toContain('steam.exe');
  });

  it('resolves an unknown category to nothing', () => {
    expect(resolveCategory('made-up')).toEqual({ sites: [], apps: [] });
  });
});

describe('compiling rules', () => {
  it('expands a site to the hostnames it is served from', () => {
    const config = compileBlockingRules([block('website', '*.youtube.com')]);
    expect(config.enabled).toBe(true);
    expect(config.domains).toEqual(expect.arrayContaining(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']));
    expect(config.apps).toEqual([]);
  });

  it('takes a specific subdomain literally', () => {
    expect(compileBlockingRules([block('website', 'mail.google.com')]).domains).toEqual(['mail.google.com']);
  });

  it('blocks apps by process name', () => {
    const config = compileBlockingRules([block('app', 'Discord'), block('app', 'steam.exe')]);
    expect(config.apps).toEqual(['discord.exe', 'steam.exe']);
    expect(config.domains).toEqual([]);
  });

  it('blocks a category through both its sites and its apps', () => {
    const config = compileBlockingRules([block('category', 'entertainment')]);
    expect(config.domains).toEqual(expect.arrayContaining(['netflix.com', 'www.netflix.com', 'twitch.tv', 'youtube.com']));
    expect(config.apps).toEqual(expect.arrayContaining(['spotify.exe']));
  });

  it('ignores duplicate and overlapping rules', () => {
    const once = compileBlockingRules([block('website', 'youtube.com')]);
    const many = compileBlockingRules([
      block('website', 'youtube.com'),
      block('website', 'YouTube.com'),
      block('website', '*.youtube.com'),
      block('website', 'https://www.youtube.com/'),
      block('category', 'entertainment'),
      block('category', 'entertainment'),
    ]);
    expect(new Set(many.domains).size).toBe(many.domains.length);
    for (const host of once.domains) expect(many.domains).toContain(host);
    expect(compileBlockingRules([block('app', 'discord'), block('app', 'DISCORD.EXE')]).apps).toEqual(['discord.exe']);
  });

  it('skips targets it cannot enforce instead of failing', () => {
    const config = compileBlockingRules([block('website', 'not a host'), block('app', 'explorer.exe'), block('category', 'nope')]);
    expect(config).toMatchObject({ enabled: false, domains: [], apps: [] });
  });

  it('is disabled when the profile has blocking turned off', () => {
    const config = compileBlockingConfig({ blocksDistractions: false, rules: [{ ...block('website', 'youtube.com'), id: 'r', profileId: 'p', createdAt: '', updatedAt: '' }] });
    expect(config).toEqual({ enabled: false, domains: [], apps: [], rules: [] });
  });

  it('is disabled when blocking is on but there is nothing to block', () => {
    expect(compileBlockingConfig({ blocksDistractions: true, rules: [] }).enabled).toBe(false);
  });
});

describe('allow / block precedence', () => {
  it('an allow rule wins over a block rule for the same site', () => {
    const config = compileBlockingRules([block('website', 'youtube.com'), allow('website', 'youtube.com')]);
    expect(config.domains).toEqual([]);
    expect(config.enabled).toBe(false);
  });

  it('an allowed subdomain is carved out of a blocked site', () => {
    const config = compileBlockingRules([block('website', '*.youtube.com'), allow('website', 'music.youtube.com')]);
    expect(config.domains).toContain('www.youtube.com');
    expect(config.domains).not.toContain('music.youtube.com');
  });

  it('an allowed site is carved out of a blocked category', () => {
    const config = compileBlockingRules([block('category', 'social-media'), allow('website', 'linkedin.com')]);
    expect(config.domains).toContain('instagram.com');
    expect(config.domains.filter((d) => d.endsWith('linkedin.com'))).toEqual([]);
  });

  it('an allowed app is carved out of a blocked category', () => {
    const config = compileBlockingRules([block('category', 'gaming'), allow('app', 'steam.exe')]);
    expect(config.apps).not.toContain('steam.exe');
    expect(config.apps).toContain('epicgameslauncher.exe');
  });

  it('an allowed category wins over individually blocked members', () => {
    const config = compileBlockingRules([block('website', 'instagram.com'), block('website', 'github.com'), allow('category', 'social-media')]);
    expect(config.domains.some((d) => d.endsWith('instagram.com'))).toBe(false);
    expect(config.domains).toContain('github.com');
  });

  it('does not depend on rule order', () => {
    const rules = [
      block('category', 'social-media'),
      allow('website', 'reddit.com'),
      block('website', '*.youtube.com'),
      allow('website', 'music.youtube.com'),
      block('app', 'discord.exe'),
      allow('app', 'discord.exe'),
      block('app', 'steam.exe'),
    ];
    const expected = compileBlockingRules(rules);
    const reversed = compileBlockingRules([...rules].reverse());
    const rotated = compileBlockingRules([...rules.slice(3), ...rules.slice(0, 3)]);
    expect(reversed).toEqual(expected);
    expect(rotated).toEqual(expected);
    expect(expected.apps).toEqual(['steam.exe']);
    expect(expected.domains.some((d) => d.endsWith('reddit.com'))).toBe(false);
  });

  it('counts block rules for the "N rules" label', () => {
    const config = compileBlockingRules([block('website', 'youtube.com'), block('app', 'discord'), allow('website', 'music.youtube.com')]);
    expect(countBlockRules(config)).toBe(2);
    expect(countBlockRules(null)).toBe(0);
  });
});

describe('matching a visited domain against the blocked hosts', () => {
  const hosts = ['youtube.com', 'www.youtube.com', 'mail.google.com'];
  it.each([
    ['youtube.com', true],
    ['www.youtube.com', true],
    ['studio.youtube.com', true],
    ['YouTube.com ', true],
    ['mail.google.com', true],
    ['google.com', false],
    ['notyoutube.com', false],
    ['', false],
  ])('%j → %s', (domain, expected) => {
    expect(isDomainBlocked(domain, hosts)).toBe(expected);
  });
});

describe('stored snapshots', () => {
  it('round-trips a compiled config', () => {
    const config = compileBlockingRules([block('website', 'youtube.com'), block('app', 'discord')]);
    expect(parseBlockingConfig(JSON.stringify(config))).toEqual(config);
  });

  it('drops anything that could not be enforced safely', () => {
    const parsed = parseBlockingConfig(
      JSON.stringify({ enabled: true, domains: ['ok.com', 'bad host', 5], apps: ['discord.exe', 'explorer.exe', '../x.exe'], rules: [{ type: 'x' }, null] }),
    );
    expect(parsed).toEqual({ enabled: true, domains: ['ok.com'], apps: ['discord.exe'], rules: [] });
  });

  it('treats missing or corrupt snapshots as absent', () => {
    expect(parseBlockingConfig(null)).toBeNull();
    expect(parseBlockingConfig('{not json')).toBeNull();
  });
});
