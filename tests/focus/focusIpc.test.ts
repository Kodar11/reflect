import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// focusIpc only needs Electron's `webContents.send`; keep Electron out of Node.
vi.mock('../../src/electron/util.js', () => ({
  ipcWebContentsSend: (channel: string, wc: { send: (c: string, p: unknown) => void }, payload: unknown) => wc.send(channel, payload),
}));

import { registerFocusIpc } from '../../src/focus/focusIpc.js';
import type { FocusSummaryDto } from '../../src/focus/FocusModels.js';
import { MIN, makeProfile, request, setup, type Harness } from './helpers.js';

type Handler = (payload?: unknown) => unknown;

interface Ipc extends Harness {
  handlers: Map<string, Handler>;
  invoke: (channel: string, payload?: unknown) => Promise<any>;
  pushed: Array<{ channel: string; payload: any }>;
  api: ReturnType<typeof registerFocusIpc>;
}

function ipc(): Ipc {
  const harness = setup();
  const handlers = new Map<string, Handler>();
  const pushed: Array<{ channel: string; payload: any }> = [];
  const wc = { send: (channel: string, payload: unknown) => pushed.push({ channel, payload }) };
  const api = registerFocusIpc(
    harness.service,
    harness.repo,
    (key, handler) => handlers.set(key, handler),
    () => [wc as never],
    (session): FocusSummaryDto => ({
      session,
      profile: harness.repo.getProfileById(session.profileId) ?? makeProfile(),
      trackedSessionIds: [],
      interruptionCount: harness.repo.getInterruptions(session.id).length,
      blockedAttemptCount: harness.repo.getBlockedAttempts(session.id).length,
      productiveMs: 0,
    }),
  );
  const invoke = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(payload);
  };
  return { ...harness, handlers, invoke, pushed, api };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Focus IPC — the renderer cannot dictate state', () => {
  it('exposes no channel that stops, completes or sets a session', () => {
    const { handlers } = ipc();
    const channels = [...handlers.keys()];
    expect(channels).not.toContain('focus:stop');
    expect(channels.filter((c) => /stop|complete|cancel|setState|finish/i.test(c))).toEqual([]);
    expect(channels).toEqual(expect.arrayContaining(['focus:start', 'focus:pause', 'focus:resume', 'focus:requestEnd', 'focus:confirmEnd']));
  });

  it('ignores state smuggled into a start request', async () => {
    const { invoke, repo } = ipc();
    const dto = await invoke('focus:start', {
      ...request(),
      state: 'completed',
      id: 'chosen-by-renderer',
      startedAt: '2001-01-01T00:00:00.000Z',
      elapsedMs: 999_999,
      endReason: 'completed',
      blockingConfig: { enabled: false, domains: [], apps: [], rules: [] },
    });
    expect(dto.session.state).toBe('active');
    expect(dto.session.id).not.toBe('chosen-by-renderer');
    expect(dto.session.elapsedMs).toBe(0);
    expect(dto.session.endReason).toBeNull();
    expect(repo.row.blockingConfig?.enabled).toBe(true);
    expect(dto.blocking.status).toBe('active');
  });

  it('will not end a session on a confirmation alone', async () => {
    const { invoke, repo } = ipc();
    await invoke('focus:start', request({ plannedDurationMinutes: 60 }));
    await expect(invoke('focus:confirmEnd', { token: 'guess', phrase: 'END' })).rejects.toThrow();
    await expect(invoke('focus:confirmEnd', { state: 'completed' })).rejects.toThrow();
    await expect(invoke('focus:confirmEnd')).rejects.toThrow();
    expect(repo.row.state).toBe('active');
  });

  it('ends early only through request → typed confirmation, and records it as an early end', async () => {
    const { invoke, repo, advance, pushed } = ipc();
    await invoke('focus:start', request({ plannedDurationMinutes: 60 }));
    await advance(17 * MIN);
    const challenge = await invoke('focus:requestEnd');
    expect(challenge).toMatchObject({ early: true, requiresPhrase: true, remainingMs: 43 * MIN });
    expect(challenge).not.toHaveProperty('expiresAtMs');

    await expect(invoke('focus:confirmEnd', { token: challenge.token })).rejects.toThrow(/END/);
    const ended = await invoke('focus:confirmEnd', { token: challenge.token, phrase: 'end', reason: 'Meeting' });
    expect(ended).toMatchObject({ state: 'cancelled', endReason: 'ended-early', endNote: 'Meeting' });
    expect(repo.row.state).toBe('cancelled');

    await vi.advanceTimersByTimeAsync(0);
    const summary = pushed.find((p) => p.channel === 'focus:summary');
    expect(summary?.payload.session).toMatchObject({ endReason: 'ended-early', elapsedMs: 17 * MIN });
    expect(pushed.filter((p) => p.channel === 'focus:activeSessionChanged').at(-1)?.payload).toBeNull();
  });

  it('pushes the natural completion without the renderer asking', async () => {
    const { invoke, advance, pushed } = ipc();
    await invoke('focus:start', request());
    await advance(25 * MIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(await invoke('focus:getActiveSession')).toBeNull();
    const summary = pushed.find((p) => p.channel === 'focus:summary');
    expect(summary?.payload.session).toMatchObject({ state: 'completed', endReason: 'completed' });
  });

  it('cannot pause as "idle" from the renderer', async () => {
    const { invoke, repo } = ipc();
    await invoke('focus:start', request());
    const dto = await invoke('focus:pause', { reason: 'idle' });
    expect(dto.pauseKind).toBe('manual');
    expect(repo.interruptions[0].type).toBe('pause');
  });

  it('pause, resume and requestEnd are harmless with nothing running', async () => {
    const { invoke } = ipc();
    expect(await invoke('focus:pause', { reason: 'x' })).toBeNull();
    expect(await invoke('focus:resume')).toBeNull();
    expect(await invoke('focus:requestEnd')).toBeNull();
    expect(await invoke('focus:restoreBlocking')).toBeNull();
  });

  it('does not leak the enforcement snapshot or internal fields to the renderer', async () => {
    const { invoke } = ipc();
    const dto = await invoke('focus:start', request());
    expect(dto.session).not.toHaveProperty('blockingConfig');
    expect(dto.profile.blocking).toMatchObject({ enabled: true, ruleCount: 2, appCount: 1 });
    expect(dto.profile.blocking.siteCount).toBeGreaterThan(1);
  });
});

describe('Focus IPC — profiles and rules', () => {
  it('refuses to delete the profile a running session uses', async () => {
    const { invoke, repo } = ipc();
    repo.profiles.push(makeProfile({ id: 'profile-2', name: 'Writing', isDefault: false }));
    await invoke('focus:start', request());
    await expect(invoke('focus:deleteProfile', { id: 'profile-1' })).rejects.toThrow(/in use/);
    expect(repo.profiles).toHaveLength(2);
    await invoke('focus:deleteProfile', { id: 'profile-2' });
    expect(repo.profiles).toHaveLength(1);
  });

  it('refuses to delete the last profile', async () => {
    const { invoke } = ipc();
    await expect(invoke('focus:deleteProfile', { id: 'profile-1' })).rejects.toThrow(/at least one/);
  });

  it('editing a profile mid-session does not change what the session enforces', async () => {
    const { invoke, repo, blocking } = ipc();
    await invoke('focus:start', request());
    const before = structuredClone(blocking.leases[0].config);
    await invoke('focus:saveProfile', {
      profile: { ...repo.profiles[0], name: 'Edited', blocksDistractions: false },
      ruleIds: [],
    });
    const dto = await invoke('focus:getActiveSession');
    expect(dto.blocking.status).toBe('active');
    expect(dto.profile.name).toBe('Deep Work');
    expect(blocking.activeLeases[0].config).toEqual(before);
  });

  it('validates rules and profiles', async () => {
    const { invoke, repo } = ipc();
    await expect(invoke('focus:saveRule', { id: 'r', type: 'bogus', target: 'x', action: 'block', enabled: true })).rejects.toThrow();
    await expect(invoke('focus:saveRule', { id: 'r', type: 'website', target: '   ', action: 'block', enabled: true })).rejects.toThrow();
    await expect(invoke('focus:saveProfile', { profile: { id: 'p', name: '  ' }, ruleIds: [] })).rejects.toThrow();
    await invoke('focus:saveRule', { id: 'r', type: 'website', target: ' reddit.com ', action: 'block', enabled: true });
    expect(repo.rules[0]).toMatchObject({ target: 'reddit.com', type: 'website' });
  });

  it('round-trips preferences through normalization', async () => {
    const { invoke } = ipc();
    const saved = await invoke('focus:savePreferences', { idleThresholdSeconds: 999_999, notifyBlocked: false, evil: true });
    expect(saved.idleThresholdSeconds).toBe(3600);
    expect(saved.notifyBlocked).toBe(false);
    expect(saved).not.toHaveProperty('evil');
    expect(await invoke('focus:getPreferences')).toEqual(saved);
  });

  it('routes tray intents to the renderer', () => {
    const { api, pushed } = ipc();
    api.sendIntent('end');
    expect(pushed).toEqual([{ channel: 'focus:intent', payload: 'end' }]);
  });
});
