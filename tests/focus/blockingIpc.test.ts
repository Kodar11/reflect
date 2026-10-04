import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/electron/util.js', () => ({
  ipcWebContentsSend: () => {},
}));

import { appDisplayName, blockLabel, canonicalBlockTarget, listCategoryOptions } from '../../src/focus/BlockingConfig.js';
import { registerFocusIpc, type BlockingContext } from '../../src/focus/focusIpc.js';
import { makeProfile, request, setup } from './helpers.js';

function ipc(context: BlockingContext = { openApps: [], recentSites: [] }) {
  const harness = setup({}, (repo) => {
    repo.profiles = [makeProfile({ rules: [], blocksDistractions: false }), makeProfile({ id: 'profile-2', name: 'Study', isDefault: false, rules: [], blocksDistractions: false })];
    // The fake stores a profile's rules on the profile; mirror the real join table.
    const attached = new Map<string, string[]>();
    repo.getProfileRuleIds = (id: string) => attached.get(id) ?? [];
    repo.updateProfile = (p, ruleIds = []) => {
      attached.set(p.id, [...ruleIds]);
      const rules = repo.rules.filter((r) => ruleIds.includes(r.id) && r.enabled).map((r) => ({ id: r.id, profileId: p.id, type: r.type, target: r.target, action: r.action, createdAt: r.createdAt, updatedAt: r.updatedAt }));
      const idx = repo.profiles.findIndex((x) => x.id === p.id);
      repo.profiles[idx] = { ...p, rules };
    };
  });
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  registerFocusIpc(harness.service, harness.repo, (key, handler) => handlers.set(key, handler), () => [], () => {
    throw new Error('unused');
  }, () => context);
  const invoke = async (channel: string, payload?: unknown): Promise<any> => handlers.get(channel)!(payload);
  const profiles = async () => (await invoke('focus:listProfiles')) as Array<{ id: string; ruleIds: string[]; blocksDistractions: boolean; blocking: { enabled: boolean; ruleCount: number } }>;
  return { ...harness, invoke, profiles };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('canonical block targets', () => {
  it.each([
    ['website', 'youtube.com', 'youtube.com'],
    ['website', 'www.youtube.com', 'youtube.com'],
    ['website', 'https://youtube.com/watch?v=abc', 'youtube.com'],
    ['website', '*.YouTube.com', 'youtube.com'],
    ['website', 'mail.google.com', 'mail.google.com'],
    ['app', 'Discord', 'discord.exe'],
    ['app', 'DISCORD.EXE', 'discord.exe'],
    ['app', 'C:\\Users\\me\\AppData\\Local\\Discord\\Discord.exe', 'discord.exe'],
    ['category', 'Social Media', 'social-media'],
    ['category', 'social', 'social-media'],
    ['category', 'games', 'gaming'],
  ] as const)('%s %j → %s', (type, raw, expected) => {
    expect(canonicalBlockTarget(type, raw)).toBe(expected);
  });

  it.each([
    ['website', 'not a site'],
    ['website', ''],
    ['app', 'explorer.exe'],
    ['category', 'made-up'],
  ] as const)('rejects %s %j', (type, raw) => {
    expect(canonicalBlockTarget(type, raw)).toBeNull();
  });

  it('shows people names, not identifiers', () => {
    expect(appDisplayName('discord.exe')).toBe('Discord');
    expect(appDisplayName('steam.exe')).toBe('Steam');
    expect(appDisplayName('someapp.exe')).toBe('Someapp');
    expect(blockLabel('category', 'social-media')).toBe('Social media');
    expect(blockLabel('category', 'gaming')).toBe('Games');
    expect(blockLabel('website', '*.youtube.com')).toBe('youtube.com');
    expect(blockLabel('app', 'DISCORD.EXE')).toBe('Discord');
  });

  it('only offers categories that block something', () => {
    const options = listCategoryOptions();
    expect(options.map((c) => c.label)).toEqual(expect.arrayContaining(['Social media', 'Entertainment', 'Games']));
    expect(options.every((c) => c.siteCount + c.appCount > 0)).toBe(true);
  });
});

describe('Focus IPC — blocking editor', () => {
  it('adding a website creates the block and switches it on for the preset in one step', async () => {
    const { invoke, repo, profiles } = ipc();
    const result = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'https://www.youtube.com/watch?v=1' });
    expect(result.created).toBe(true);
    expect(repo.rules).toEqual([expect.objectContaining({ type: 'website', target: 'youtube.com', action: 'block', enabled: true })]);
    const [deepWork, study] = await profiles();
    expect(deepWork.ruleIds).toEqual([result.ruleId]);
    expect(deepWork.blocksDistractions).toBe(true);
    expect(deepWork.blocking).toMatchObject({ enabled: true, ruleCount: 1 });
    expect(study.ruleIds).toEqual([]);
  });

  it('never duplicates: different spellings of the same thing reuse one block', async () => {
    const { invoke, repo } = ipc();
    const first = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'youtube.com' });
    for (const target of ['www.youtube.com', 'YouTube.com', 'https://youtube.com/feed', '*.youtube.com']) {
      const again = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target });
      expect(again).toEqual({ ruleId: first.ruleId, created: false });
    }
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'app', target: 'Discord' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'app', target: 'discord.exe' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'category', target: 'social' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'category', target: 'Social Media' });
    expect(repo.rules.map((r) => `${r.type}:${r.target}`)).toEqual(['website:youtube.com', 'app:discord.exe', 'category:social-media']);
  });

  it('an existing block is reused by another preset rather than recreated', async () => {
    const { invoke, repo, profiles } = ipc();
    const a = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'reddit.com' });
    const b = await invoke('focus:addBlock', { profileId: 'profile-2', type: 'website', target: 'reddit.com' });
    expect(b).toEqual({ ruleId: a.ruleId, created: false });
    expect(repo.rules).toHaveLength(1);
    expect((await profiles()).map((p) => p.ruleIds)).toEqual([[a.ruleId], [a.ruleId]]);
  });

  it('block and allow for the same site are separate things', async () => {
    const { invoke, repo } = ipc();
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'youtube.com' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'youtube.com', action: 'allow' });
    expect(repo.rules.map((r) => r.action)).toEqual(['block', 'allow']);
  });

  it('an allow rule overrides a blocked category for that preset', async () => {
    const { invoke, profiles, service, blocking } = ipc();
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'category', target: 'social-media' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'linkedin.com', action: 'allow' });
    expect((await profiles())[0].blocking.enabled).toBe(true);
    await service.start(request());
    const { domains } = blocking.leases[0].config;
    expect(domains).toContain('instagram.com');
    expect(domains.some((d) => d.endsWith('linkedin.com'))).toBe(false);
  });

  it('switching a block off detaches it from the preset only', async () => {
    const { invoke, repo, profiles } = ipc();
    const { ruleId } = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'app', target: 'Steam' });
    await invoke('focus:addBlock', { profileId: 'profile-2', type: 'app', target: 'Steam' });
    await invoke('focus:setProfileBlock', { profileId: 'profile-1', ruleId, on: false });
    const [deepWork, study] = await profiles();
    expect(deepWork.ruleIds).toEqual([]);
    expect(deepWork.blocksDistractions).toBe(false);
    expect(deepWork.blocking.enabled).toBe(false);
    expect(study.ruleIds).toEqual([ruleId]);
    expect(repo.rules).toHaveLength(1);
  });

  it('re-adding a disabled block enables it again', async () => {
    const { invoke, repo } = ipc();
    const { ruleId } = await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'reddit.com' });
    repo.rules[0] = { ...repo.rules[0], enabled: false };
    expect(await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'reddit.com' })).toEqual({ ruleId, created: false });
    expect(repo.rules[0].enabled).toBe(true);
  });

  it('refuses what cannot be blocked, with a message a person can act on', async () => {
    const { invoke, repo } = ipc();
    await expect(invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'not a site' })).rejects.toThrow('Enter a website like youtube.com.');
    await expect(invoke('focus:addBlock', { profileId: 'profile-1', type: 'app', target: 'explorer.exe' })).rejects.toThrow('That app cannot be blocked.');
    await expect(invoke('focus:addBlock', { profileId: 'profile-1', type: 'category', target: 'nope' })).rejects.toThrow();
    await expect(invoke('focus:addBlock', { profileId: 'gone', type: 'website', target: 'x.com' })).rejects.toThrow(/preset/);
    await expect(invoke('focus:setProfileBlock', { profileId: 'profile-1', ruleId: 'nope', on: true })).rejects.toThrow();
    expect(repo.rules).toEqual([]);
  });

  it('offers open apps and recent sites, normalized, deduplicated and never a protected process', async () => {
    const { invoke } = ipc({
      openApps: [
        { name: 'Discord', process: 'Discord.exe' },
        { name: 'Discord', process: 'discord.exe' },
        { name: 'Windows Explorer', process: 'explorer.exe' },
        { name: 'Spotify', process: 'Spotify.exe' },
      ],
      recentSites: ['www.youtube.com', 'youtube.com', 'news.ycombinator.com', 'not a host'],
    });
    const options = await invoke('focus:getBlockingOptions');
    expect(options.openApps).toEqual([{ process: 'discord.exe', name: 'Discord' }, { process: 'spotify.exe', name: 'Spotify' }]);
    expect(options.recentSites).toEqual(['youtube.com', 'news.ycombinator.com']);
    expect(options.categories.length).toBeGreaterThan(2);
  });

  it('rules carry a human label', async () => {
    const { invoke } = ipc();
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'app', target: 'discord.exe' });
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'category', target: 'gaming' });
    expect((await invoke('focus:listRules')).map((r: { label: string }) => r.label)).toEqual(['Discord', 'Games']);
  });

  it('editing blocks during a session changes the next session, not the running one', async () => {
    const { invoke, service, blocking } = ipc();
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'youtube.com' });
    await service.start(request());
    const before = structuredClone(blocking.leases[0].config);
    await invoke('focus:addBlock', { profileId: 'profile-1', type: 'website', target: 'reddit.com' });
    expect(blocking.activeLeases[0].config).toEqual(before);
    expect(blocking.leases).toHaveLength(1);
  });
});

describe('starting without blocking', () => {
  it('enforces nothing and says so, even though the preset has blocks', async () => {
    const { service, blocking, repo } = setup();
    const dto = await service.start(request({ withoutBlocking: true }));
    expect(dto.blocking.status).toBe('off');
    expect(blocking.leases).toHaveLength(0);
    expect(repo.row.blockingConfig).toEqual({ enabled: false, domains: [], apps: [], rules: [] });
  });

  it('is the way out when blocking cannot be turned on', async () => {
    const { service, blocking } = setup({}, (_r, b) => {
      b.failStartAlways = true;
    });
    await expect(service.start(request())).rejects.toMatchObject({ code: 'blocking-failed' });
    const dto = await service.start(request({ withoutBlocking: true }));
    expect(dto.session.state).toBe('active');
    expect(dto.blocking.status).toBe('off');
    expect(blocking.leases).toHaveLength(0);
  });
});
