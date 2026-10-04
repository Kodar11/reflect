import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockingError } from '../../src/focus/BlockingManager.js';
import { FocusError, FocusService } from '../../src/focus/FocusService.js';
import { MIN, T0, makeProfile, makeRule, makeSession, request, setup } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number) => new Date(ms).toISOString();

/** End the running session through the real two-step flow. */
async function endDeliberately(service: FocusService, reason: string | null = null) {
  const challenge = await service.requestEnd();
  if (!challenge) throw new Error('no session to end');
  return service.confirmEnd({ token: challenge.token, phrase: challenge.requiresPhrase ? challenge.phrase : null, reason });
}

describe('FocusService — start', () => {
  it('starts a countdown, persists it and confirms blocking', async () => {
    const { service, repo, blocking, notices } = setup();
    const dto = await service.start(request());

    expect(dto.session.task).toBe('Write tests');
    expect(dto.session.mode).toBe('countdown');
    expect(dto.session.plannedDurationMinutes).toBe(25);
    expect(dto.session.state).toBe('active');
    expect(dto.isRunning).toBe(true);
    expect(dto.remainingMs).toBe(25 * MIN);
    expect(dto.plannedEndsAt).toBe(iso(T0 + 25 * MIN));
    expect(dto.blocking).toEqual({ status: 'active', ruleCount: 2, message: null });

    expect(repo.sessions).toHaveLength(1);
    expect(repo.row.state).toBe('active');
    expect(repo.row.startedAt).toBe(iso(T0));
    expect(repo.row.blockingLeaseId).toBe('lease-1');
    expect(blocking.activeLeases).toHaveLength(1);
    expect(notices.map((n) => n.kind)).toEqual(['started']);
  });

  it('stores the task exactly as entered (trimmed) and keeps notes optional', async () => {
    const { service, repo } = setup();
    await service.start(request({ task: '  Finish authentication implementation  ', notes: '   ' }));
    expect(repo.row.task).toBe('Finish authentication implementation');
    expect(repo.row.notes).toBeNull();
  });

  it('uses the request duration over the profile default', async () => {
    const { service } = setup();
    const dto = await service.start(request({ plannedDurationMinutes: 60 }));
    expect(dto.session.plannedDurationMinutes).toBe(60);
    expect(dto.remainingMs).toBe(60 * MIN);
  });

  it('snapshots the blocking it enforces on the session', async () => {
    const { service, repo, blocking } = setup();
    await service.start(request());
    expect(repo.row.blockingConfig?.domains).toContain('youtube.com');
    expect(repo.row.blockingConfig?.domains).toContain('www.youtube.com');
    expect(repo.row.blockingConfig?.apps).toEqual(['discord.exe']);
    expect(blocking.leases[0].config).toEqual(repo.row.blockingConfig);
  });

  it.each([
    ['an empty task', request({ task: '   ' })],
    ['a task that is too long', request({ task: 'x'.repeat(201) })],
    ['a zero duration', request({ plannedDurationMinutes: 0 })],
    ['a fractional duration', request({ plannedDurationMinutes: 12.5 })],
    ['an absurd duration', request({ plannedDurationMinutes: 100_000 })],
    ['an unknown mode', request({ mode: 'forever' as never })],
  ])('rejects %s without creating a session', async (_label, bad) => {
    const { service, repo, blocking } = setup();
    await expect(service.start(bad)).rejects.toBeInstanceOf(FocusError);
    expect(repo.sessions).toHaveLength(0);
    expect(blocking.leases).toHaveLength(0);
    expect(service.getActiveSession()).toBeNull();
  });

  it('rejects an unknown profile', async () => {
    const { service, repo } = setup();
    await expect(service.start(request({ profileId: 'nope' }))).rejects.toMatchObject({ code: 'profile-not-found' });
    expect(repo.sessions).toHaveLength(0);
  });

  it('refuses a second session while one is running', async () => {
    const { service, repo } = setup();
    await service.start(request());
    await expect(service.start(request({ task: 'Another' }))).rejects.toMatchObject({ code: 'already-active' });
    expect(repo.sessions).toHaveLength(1);
  });

  it('does not acquire a lease when the profile blocks nothing', async () => {
    const { service, blocking } = setup({}, (repo) => {
      repo.profiles = [makeProfile({ blocksDistractions: false })];
    });
    const dto = await service.start(request());
    expect(dto.blocking.status).toBe('off');
    expect(blocking.leases).toHaveLength(0);
  });

  it('reports blocking as unavailable, never active, when the platform cannot enforce', async () => {
    const { service, blocking } = setup({}, (_repo, b) => {
      b.enforcement = 'none';
    });
    const dto = await service.start(request());
    expect(dto.blocking.status).toBe('unavailable');
    expect(blocking.leases).toHaveLength(0);
  });
});

describe('FocusService — transactional start', () => {
  it('leaves no session behind when blocking cannot be acquired', async () => {
    const { service, repo, blocking, changes } = setup({}, (_repo, b) => {
      b.failStartWith = new BlockingError('elevation-declined', 'Administrator permission was declined.');
    });
    await expect(service.start(request())).rejects.toMatchObject({
      code: 'blocking-failed',
      message: expect.stringContaining('Administrator permission was declined'),
    });
    expect(repo.sessions).toHaveLength(0);
    expect(service.getActiveSession()).toBeNull();
    expect(blocking.activeLeases).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it('releases blocking again when the session cannot be persisted', async () => {
    const { service, repo, blocking } = setup();
    repo.failNextUpdate = true;
    await expect(service.start(request())).rejects.toThrow('disk full');
    expect(blocking.leases).toHaveLength(1);
    expect(blocking.activeLeases).toHaveLength(0);
    expect(repo.sessions).toHaveLength(0);
    expect(service.getActiveSession()).toBeNull();
  });

  it('can start again after a failed start', async () => {
    const { service, repo } = setup({}, (_repo, b) => {
      b.failStartWith = new BlockingError('helper-unavailable', 'nope');
    });
    await expect(service.start(request())).rejects.toBeInstanceOf(FocusError);
    const dto = await service.start(request());
    expect(dto.blocking.status).toBe('active');
    expect(repo.sessions).toHaveLength(1);
  });

  it('counts the session from when blocking was confirmed, not from the request', async () => {
    const { service, blocking, clock, repo } = setup({}, (_repo, b) => {
      b.holdStart = true;
    });
    const starting = service.start(request());
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.row.state).toBe('planned');
    expect(service.getActiveSession()).toBeNull();
    clock.now += 20_000; // the user took 20s to answer the UAC prompt
    blocking.releaseStart();
    const dto = await starting;
    expect(dto.session.startedAt).toBe(iso(T0 + 20_000));
    expect(dto.remainingMs).toBe(25 * MIN);
  });
});

describe('FocusService — pause and resume', () => {
  it('pauses and resumes, counting only active work', async () => {
    const { service, repo, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(60_000);
    const paused = await service.pause('Quick break');
    expect(paused?.isRunning).toBe(false);
    expect(paused?.pauseKind).toBe('manual');
    expect(repo.interruptions.map((i) => [i.type, i.reason])).toEqual([['pause', 'Quick break']]);

    await advance(30_000);
    expect(service.getActiveSession()?.liveElapsedMs).toBe(60_000);

    const resumed = await service.resume();
    expect(resumed?.isRunning).toBe(true);
    expect(repo.interruptions.map((i) => i.type)).toEqual(['pause', 'resume']);

    await advance(30_000);
    expect(service.getActiveSession()?.liveElapsedMs).toBe(90_000);
    expect(repo.row.totalPauseMs).toBe(30_000);
  });

  it('keeps the blocking lease alive while paused', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request());
    await service.pause('Meeting');
    const before = blocking.heartbeats.length;
    await advance(30_000);
    expect(blocking.activeLeases).toHaveLength(1);
    expect(blocking.heartbeats.length).toBeGreaterThan(before);
    expect(service.getActiveSession()?.blocking.status).toBe('active');
  });

  it('stops the countdown while paused and picks up where it left off', async () => {
    const { service, repo, advance } = setup();
    await service.start(request());
    await advance(5 * MIN);
    const paused = await service.pause('Phone call');
    expect(paused?.remainingMs).toBe(20 * MIN);
    expect(paused?.plannedEndsAt).toBeNull();

    await advance(5 * MIN);
    const still = service.getActiveSession();
    expect(still?.remainingMs).toBe(20 * MIN);
    expect(still?.liveElapsedMs).toBe(5 * MIN);

    const resumed = await service.resume();
    expect(resumed?.remainingMs).toBe(20 * MIN);
    // The end moves back by exactly the time paused.
    expect(resumed?.plannedEndsAt).toBe(iso(T0 + 30 * MIN));
    await advance(MIN);
    expect(service.getActiveSession()?.remainingMs).toBe(19 * MIN);
    expect(repo.row.state).toBe('active');
  });

  it('treats redundant transitions as no-ops', async () => {
    const { service, repo } = setup();
    expect(await service.pause('x')).toBeNull();
    expect(await service.resume()).toBeNull();

    await service.start(request());
    expect((await service.resume())?.isRunning).toBe(true);
    expect(repo.interruptions).toHaveLength(0);

    await service.pause('Other');
    await service.pause('Other');
    expect(repo.interruptions).toHaveLength(1);
  });

  it('cannot be told by the renderer that a pause was "idle"', async () => {
    const { service, repo, idle, advance } = setup();
    await service.start(request());
    const dto = await service.pause('idle');
    expect(dto?.pauseKind).toBe('manual');
    expect(repo.interruptions[0].type).toBe('pause');
    // …and therefore it does not auto-resume.
    idle.seconds = 0;
    await advance(10_000);
    expect(service.getActiveSession()?.isRunning).toBe(false);
  });
});

describe('FocusService — countdown completion', () => {
  it('is still running just before the planned end', async () => {
    const { service, advance, summaries } = setup();
    await service.start(request());
    await advance(25 * MIN - 1000);
    expect(service.getActiveSession()?.remainingMs).toBe(1000);
    expect(summaries).toHaveLength(0);
  });

  it('completes by itself at the planned end, releases blocking and emits a summary', async () => {
    const { service, repo, blocking, advance, summaries, changes } = setup();
    await service.start(request());
    await advance(25 * MIN);

    expect(service.getActiveSession()).toBeNull();
    expect(repo.row.state).toBe('completed');
    expect(repo.row.endReason).toBe('completed');
    expect(repo.row.endedAt).toBe(iso(T0 + 25 * MIN));
    expect(repo.row.elapsedMs).toBe(25 * MIN);
    expect(repo.row.blockingLeaseId).toBeNull();
    expect(blocking.activeLeases).toHaveLength(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].endReason).toBe('completed');
    expect(changes.at(-1)).toBeNull();
  });

  it('completes exactly once however long the timers keep running', async () => {
    const { service, advance, summaries, blocking } = setup();
    await service.start(request());
    await advance(40 * MIN);
    expect(summaries).toHaveLength(1);
    expect(blocking.leases).toHaveLength(1);
    expect(service.getActiveSession()).toBeNull();
  });

  it('a pause pushes the end back: the full planned time is still worked', async () => {
    const { service, repo, advance, summaries } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(30 * MIN);
    await service.pause('Meeting');
    await advance(6 * MIN);
    await service.resume();
    await advance(24 * MIN);
    // 60 minutes on the wall clock, but only 54 worked: not done yet.
    expect(repo.row.state).toBe('active');
    expect(service.getActiveSession()?.remainingMs).toBe(6 * MIN);
    expect(summaries).toHaveLength(0);

    await advance(6 * MIN);
    expect(repo.row.state).toBe('completed');
    expect(repo.row.endedAt).toBe(iso(T0 + 66 * MIN));
    expect(repo.row.elapsedMs).toBe(60 * MIN);
    expect(repo.row.totalPauseMs).toBe(6 * MIN);
  });

  it('never completes while paused, however long the pause', async () => {
    const { service, repo, blocking, advance, summaries } = setup();
    await service.start(request());
    await advance(10 * MIN);
    await service.pause('Other');
    await advance(3 * 60 * MIN);
    expect(repo.row.state).toBe('paused');
    expect(service.getActiveSession()?.remainingMs).toBe(15 * MIN);
    expect(summaries).toHaveLength(0);
    expect(blocking.activeLeases).toHaveLength(1); // still committed, still blocked

    await service.resume();
    await advance(15 * MIN);
    expect(repo.row.state).toBe('completed');
    expect(repo.row.elapsedMs).toBe(25 * MIN);
    expect(blocking.activeLeases).toHaveLength(0);
  });

  it('time asleep does not run the countdown down', async () => {
    const { service, repo, blocking, advance, sleep } = setup();
    await service.start(request());
    await advance(10 * MIN);
    await sleep(3 * 60 * MIN);

    const dto = service.getActiveSession();
    expect(dto?.isRunning).toBe(true);
    expect(dto?.remainingMs).toBe(15 * MIN);
    expect(repo.row.state).toBe('active');
    expect(blocking.activeLeases).toHaveLength(1);

    await advance(15 * MIN);
    expect(repo.row.state).toBe('completed');
    expect(repo.row.elapsedMs).toBe(25 * MIN);
  });
});

describe('FocusService — stopwatch', () => {
  it('starts with no planned end and keeps counting', async () => {
    const { service, advance, summaries } = setup();
    const dto = await service.start(request({ mode: 'stopwatch' }));
    expect(dto.remainingMs).toBeNull();
    expect(dto.plannedEndsAt).toBeNull();
    expect(dto.session.plannedDurationMinutes).toBeNull();
    await advance(3 * 60 * MIN);
    expect(service.getActiveSession()?.liveElapsedMs).toBe(3 * 60 * MIN);
    expect(summaries).toHaveLength(0);
  });

  it('is finished deliberately, without a typed phrase, and counts as completed', async () => {
    const { service, repo, blocking, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(52 * MIN);
    const challenge = await service.requestEnd();
    expect(challenge).toMatchObject({ early: false, requiresPhrase: false, remainingMs: null });
    const ended = await service.confirmEnd({ token: challenge!.token });
    expect(ended.state).toBe('completed');
    expect(ended.endReason).toBe('finished');
    expect(ended.elapsedMs).toBe(52 * MIN);
    expect(repo.row.state).toBe('completed');
    expect(blocking.activeLeases).toHaveLength(0);
  });

  it('excludes pause time when finished while paused', async () => {
    const { service, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(10 * MIN);
    await service.pause('Quick break');
    await advance(5 * MIN);
    const ended = await endDeliberately(service);
    expect(ended.elapsedMs).toBe(10 * MIN);
    expect(ended.totalPauseMs).toBe(5 * MIN);
  });
});

describe('FocusService — deliberate exit', () => {
  it('has no way to end a session without a challenge', async () => {
    const { service, repo } = setup();
    await service.start(request());
    expect((service as unknown as Record<string, unknown>).stop).toBeUndefined();
    await expect(service.confirmEnd({ token: 'made-up' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    await expect(service.confirmEnd({ token: '' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    await expect(service.confirmEnd(undefined as never)).rejects.toMatchObject({ code: 'end-not-confirmed' });
    expect(repo.row.state).toBe('active');
    expect(service.getActiveSession()).not.toBeNull();
  });

  it('requires the typed phrase to end a countdown early', async () => {
    const { service, repo, advance } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(22 * MIN);
    const challenge = await service.requestEnd();
    expect(challenge).toMatchObject({ early: true, requiresPhrase: true, phrase: 'END', remainingMs: 38 * MIN });

    await expect(service.confirmEnd({ token: challenge!.token })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    await expect(service.confirmEnd({ token: challenge!.token, phrase: 'stop' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    expect(repo.row.state).toBe('active');

    // A wrong phrase does not burn the challenge; the right one ends it.
    const ended = await service.confirmEnd({ token: challenge!.token, phrase: ' end ', reason: 'Meeting' });
    expect(ended.state).toBe('cancelled');
    expect(ended.endReason).toBe('ended-early');
    expect(ended.endNote).toBe('Meeting');
  });

  it('records an early end as cancelled, never as completed', async () => {
    const { service, repo, blocking, advance, summaries } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(17 * MIN);
    await endDeliberately(service, 'Changed task');

    expect(repo.row.state).toBe('cancelled');
    expect(repo.row.endReason).toBe('ended-early');
    expect(repo.row.endNote).toBe('Changed task');
    expect(repo.row.elapsedMs).toBe(17 * MIN);
    expect(repo.row.endedAt).toBe(iso(T0 + 17 * MIN));
    expect(blocking.activeLeases).toHaveLength(0);
    expect(summaries[0].endReason).toBe('ended-early');
    expect(service.getActiveSession()).toBeNull();
  });

  it('rejects an expired challenge', async () => {
    const { service, repo, advance } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    const challenge = await service.requestEnd();
    await advance(3 * MIN);
    await expect(service.confirmEnd({ token: challenge!.token, phrase: 'END' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    expect(repo.row.state).toBe('active');
  });

  it("rejects a challenge issued for an earlier session", async () => {
    const { service, repo } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    const stale = await service.requestEnd();
    await service.confirmEnd({ token: stale!.token });

    await service.start(request({ task: 'Next' }));
    await expect(service.confirmEnd({ token: stale!.token, phrase: 'END' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    expect(repo.sessions[1].state).toBe('active');
  });

  it('only honours the most recent challenge', async () => {
    const { service } = setup();
    await service.start(request());
    const first = await service.requestEnd();
    const second = await service.requestEnd();
    await expect(service.confirmEnd({ token: first!.token, phrase: 'END' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    // A failed confirmation with a bad token drops the challenge altogether.
    await expect(service.confirmEnd({ token: second!.token, phrase: 'END' })).rejects.toMatchObject({ code: 'end-not-confirmed' });
    expect(service.getActiveSession()).not.toBeNull();
  });

  it('has nothing to request or confirm without a session', async () => {
    const { service } = setup();
    expect(await service.requestEnd()).toBeNull();
    await expect(service.confirmEnd({ token: 'x' })).rejects.toMatchObject({ code: 'no-session' });
  });

  it('cannot end a session twice', async () => {
    const { service, summaries } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    const challenge = await service.requestEnd();
    await service.confirmEnd({ token: challenge!.token });
    await expect(service.confirmEnd({ token: challenge!.token })).rejects.toMatchObject({ code: 'no-session' });
    expect(summaries).toHaveLength(1);
  });

  it('caps the early-end reason', async () => {
    const { service } = setup();
    await service.start(request());
    const ended = await endDeliberately(service, 'x'.repeat(500));
    expect(ended.endNote).toHaveLength(120);
  });
});

describe('FocusService — idle', () => {
  it('pauses when the user has been away and resumes when they return', async () => {
    const { service, repo, blocking, idle, advance, notices } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(5 * MIN);

    idle.seconds = 120; // away for the whole threshold
    await advance(1000);
    const paused = service.getActiveSession();
    expect(paused?.isRunning).toBe(false);
    expect(paused?.pauseKind).toBe('idle');
    // Work stopped when the input stopped, two minutes before we noticed.
    expect(paused?.liveElapsedMs).toBe(5 * MIN + 1000 - 120_000);
    expect(repo.interruptions.at(-1)).toMatchObject({ type: 'idle', idleMs: 120_000 });
    expect(blocking.activeLeases).toHaveLength(1);

    idle.seconds = 400;
    await advance(4 * MIN);
    expect(service.getActiveSession()?.isRunning).toBe(false);
    expect(blocking.activeLeases).toHaveLength(1);

    idle.seconds = 0; // back at the keyboard
    await advance(1000);
    expect(service.getActiveSession()?.isRunning).toBe(true);
    expect(repo.interruptions.at(-1)?.type).toBe('resume');
    expect(notices.map((n) => n.kind)).toEqual(['started', 'idle-paused', 'idle-resumed']);
  });

  it('never auto-resumes a manual pause', async () => {
    const { service, idle, advance } = setup();
    await service.start(request());
    await service.pause('Phone call');
    idle.seconds = 0;
    await advance(MIN);
    expect(service.getActiveSession()?.isRunning).toBe(false);
    expect(service.getActiveSession()?.pauseKind).toBe('manual');
  });

  it('stays paused after idle when auto-resume is off', async () => {
    const { service, idle, advance } = setup();
    service.setPreferences({ ...service.getPreferences(), idleAutoResume: false });
    await service.start(request());
    idle.seconds = 300;
    await advance(1000);
    expect(service.getActiveSession()?.pauseKind).toBe('idle');
    idle.seconds = 0;
    await advance(10_000);
    expect(service.getActiveSession()?.isRunning).toBe(false);
    // The user can still resume by hand.
    expect((await service.resume())?.isRunning).toBe(true);
  });

  it('does not pause for idleness when auto-pause is off', async () => {
    const { service, idle, advance } = setup();
    service.setPreferences({ ...service.getPreferences(), idleAutoPause: false });
    await service.start(request());
    idle.seconds = 3000;
    await advance(10_000);
    expect(service.getActiveSession()?.isRunning).toBe(true);
  });

  it('honours the configured idle threshold', async () => {
    const { service, idle, advance } = setup();
    service.setPreferences({ ...service.getPreferences(), idleThresholdSeconds: 300 });
    await service.start(request());
    idle.seconds = 200;
    await advance(1000);
    expect(service.getActiveSession()?.isRunning).toBe(true);
    idle.seconds = 300;
    await advance(1000);
    expect(service.getActiveSession()?.isRunning).toBe(false);
  });

  it('never backdates an idle pause before the session started', async () => {
    const { service, idle, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    idle.seconds = 900; // idle since before Focus began
    await advance(1000);
    const dto = service.getActiveSession();
    expect(dto?.isRunning).toBe(false);
    expect(dto?.liveElapsedMs).toBe(0);
  });
});

describe('FocusService — sleep and wake', () => {
  it('does not count time asleep as active work and keeps the session committed', async () => {
    const { service, repo, blocking, advance, sleep } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(10 * MIN);
    await sleep(45 * MIN);

    const dto = service.getActiveSession();
    expect(dto?.isRunning).toBe(true);
    expect(dto?.liveElapsedMs).toBe(10 * MIN);
    expect(repo.interruptions.at(-1)).toMatchObject({ type: 'idle', reason: 'sleep', idleMs: 45 * MIN + 1000 });
    expect(blocking.activeLeases).toHaveLength(1);
  });

  it('reconciles immediately when told the system resumed', async () => {
    const { service, repo, clock } = setup();
    await service.start(request());
    clock.now += 5 * 60 * MIN;
    service.handleSystemResume();
    await vi.advanceTimersByTimeAsync(0);
    // The five hours asleep were not Focus time: nothing was lost or completed.
    const dto = service.getActiveSession();
    expect(dto?.remainingMs).toBe(25 * MIN);
    expect(dto?.liveElapsedMs).toBe(0);
    expect(repo.interruptions.at(-1)).toMatchObject({ type: 'idle', reason: 'sleep' });
  });
});

describe('FocusService — blocking lease', () => {
  it('heartbeats the lease and releases it when the session ends', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await advance(30_000);
    expect(blocking.heartbeats.length).toBeGreaterThanOrEqual(5);
    await endDeliberately(service);
    expect(blocking.leases[0].stopped).toBe(true);
  });

  it('re-acquires blocking when the lease is lost, and says so meanwhile', async () => {
    const { service, repo, blocking, advance, changes } = setup();
    await service.start(request());
    blocking.leases[0].stopped = true; // the helper dropped it
    await advance(6000);

    const dto = service.getActiveSession();
    expect(dto?.blocking.status).toBe('active');
    expect(blocking.activeLeases.map((l) => l.leaseId)).toEqual(['lease-2']);
    expect(repo.row.blockingLeaseId).toBe('lease-2');
    expect(changes.length).toBeGreaterThanOrEqual(3); // started → recovering → active
  });

  it('never keeps claiming "active" when blocking cannot be restored', async () => {
    const { service, blocking, advance, notices } = setup();
    await service.start(request());
    blocking.heartbeatFails = true;
    blocking.failStartAlways = true;
    await advance(6000);

    const dto = service.getActiveSession();
    expect(dto?.blocking.status).toBe('degraded');
    expect(dto?.blocking.message).toBeTruthy();
    expect(dto?.isRunning).toBe(true); // the commitment itself stands
    expect(notices.some((n) => n.kind === 'blocking-lost')).toBe(true);

    // It does not hammer the blocker (and the UAC prompt) in a loop.
    const attempts = blocking.leases.length;
    await advance(60_000);
    expect(blocking.leases.length).toBe(attempts);
  });

  it('restores blocking on request after it was lost', async () => {
    const { service, repo, blocking, advance, notices } = setup();
    await service.start(request());
    blocking.heartbeatFails = true;
    blocking.failStartAlways = true;
    await advance(6000);
    expect(service.getActiveSession()?.blocking.status).toBe('degraded');

    blocking.heartbeatFails = false;
    blocking.failStartAlways = false;
    const dto = await service.restoreBlocking();
    expect(dto?.blocking.status).toBe('active');
    expect(notices.at(-1)?.kind).toBe('blocking-restored');
    expect(blocking.leases.at(-1)).toMatchObject({ leaseId: repo.row.blockingLeaseId, stopped: false });
  });

  it('reports leftover blocking when the release fails, and can clear it', async () => {
    const { service, blocking } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    expect(service.hasBlockingResidue()).toBe(false);
    blocking.failStop = true;
    const ended = await endDeliberately(service);
    expect(ended.state).toBe('completed'); // the session is over regardless
    expect(service.hasBlockingResidue()).toBe(true);
    await service.clearBlockingResidue();
    expect(service.hasBlockingResidue()).toBe(false);
  });

  it('will not clear blocking out from under a running session', async () => {
    const { service, blocking } = setup();
    await service.start(request());
    blocking.residue = true;
    await service.clearBlockingResidue();
    expect(blocking.residue).toBe(true);
  });
});

describe('FocusService — frozen blocking configuration', () => {
  it('keeps enforcing the original rules when the profile is edited mid-session', async () => {
    const { service, repo, blocking, advance } = setup();
    await service.start(request());
    const original = structuredClone(repo.row.blockingConfig);

    // The user edits the profile while Focus is running.
    repo.profiles[0].rules = [makeRule({ id: 'rule-9', target: 'example.org' })];
    repo.profiles[0].name = 'Renamed';

    // Even a lost lease is re-acquired with the snapshot, not the new rules.
    blocking.leases[0].stopped = true;
    await advance(6000);
    expect(blocking.leases[1].config).toEqual(original);
    expect(service.getActiveSession()?.profile.name).toBe('Deep Work');

    // The next session picks up the edit.
    await endDeliberately(service);
    await service.start(request({ task: 'Next' }));
    expect(blocking.leases[2].config.domains).toContain('example.org');
    expect(blocking.leases[2].config.domains).not.toContain('youtube.com');
  });
});

describe('FocusService — blocked attempts', () => {
  it('records attempts reported by the blocker', async () => {
    const { service, blocking, repo, notices } = setup();
    const dto = await service.start(request());
    blocking.simulateBlockedAttempt(dto.session.id, 'discord.exe');
    expect(repo.blockedAttempts).toHaveLength(1);
    expect(repo.blockedAttempts[0]).toMatchObject({ type: 'app', target: 'discord.exe', sessionId: dto.session.id });
    expect(notices.at(-1)).toMatchObject({ kind: 'blocked', target: 'discord.exe' });
  });

  it('does not flood the log when an app is relaunched over and over', async () => {
    const { service, blocking, repo, advance } = setup();
    const dto = await service.start(request());
    for (let i = 0; i < 10; i += 1) {
      blocking.simulateBlockedAttempt(dto.session.id, 'discord.exe');
      await advance(2000);
    }
    expect(repo.blockedAttempts).toHaveLength(1);
    await advance(MIN);
    blocking.simulateBlockedAttempt(dto.session.id, 'discord.exe');
    expect(repo.blockedAttempts).toHaveLength(2);
  });

  it('records a visit to a blocked site seen by the tracker, and ignores other sites', async () => {
    const { service, repo } = setup();
    await service.start(request());
    service.observeDomain('github.com');
    service.observeDomain(undefined);
    expect(repo.blockedAttempts).toHaveLength(0);
    service.observeDomain('www.youtube.com');
    expect(repo.blockedAttempts).toEqual([expect.objectContaining({ type: 'website', target: 'www.youtube.com' })]);
  });

  it('ignores attempts for another session or when nothing is running', async () => {
    const { service, blocking, repo } = setup();
    blocking.simulateBlockedAttempt('ghost', 'discord.exe');
    service.observeDomain('youtube.com');
    await service.start(request());
    blocking.simulateBlockedAttempt('ghost', 'discord.exe');
    expect(repo.blockedAttempts).toHaveLength(0);
  });
});

describe('FocusService — startup recovery', () => {
  it('restores a countdown that still had time left and re-acquires blocking', async () => {
    const { service, repo, blocking, clock } = setup({}, (r) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + 10 * MIN), elapsedMs: 10 * MIN }));
    });
    clock.now = T0 + 30 * MIN; // the app was gone for 20 minutes
    await service.reconcileActiveSession();

    const dto = service.getActiveSession();
    expect(dto?.session.id).toBe('session-1');
    expect(dto?.isRunning).toBe(true);
    // The 20 minutes without the app are not active work, so nothing was used up.
    expect(dto?.remainingMs).toBe(50 * MIN);
    expect(dto?.liveElapsedMs).toBe(10 * MIN);
    expect(dto?.blocking.status).toBe('active');
    expect(blocking.activeLeases).toHaveLength(1);
    expect(repo.row.blockingLeaseId).toBe('lease-1');
    expect(repo.interruptions.at(-1)).toMatchObject({ type: 'idle', reason: 'app-closed' });
  });

  it('restores a paused session as paused, with its blocking', async () => {
    const { service, repo, blocking, clock, idle, advance } = setup({}, (r) => {
      r.sessions.push(makeSession({ state: 'paused', pausedAt: iso(T0 + 5 * MIN), elapsedMs: 5 * MIN, updatedAt: iso(T0 + 5 * MIN) }));
      r.interruptions.push({ id: 'i1', sessionId: 'session-1', type: 'pause', reason: 'Meeting', occurredAt: iso(T0 + 5 * MIN), idleMs: null, createdAt: iso(T0) });
    });
    clock.now = T0 + 12 * MIN;
    await service.reconcileActiveSession();

    const dto = service.getActiveSession();
    expect(dto?.isRunning).toBe(false);
    expect(dto?.pauseKind).toBe('manual');
    expect(dto?.liveElapsedMs).toBe(5 * MIN);
    expect(blocking.activeLeases).toHaveLength(1);
    // A manual pause is still a manual pause after a restart.
    idle.seconds = 0;
    await advance(5000);
    expect(service.getActiveSession()?.isRunning).toBe(false);
    expect(repo.row.state).toBe('paused');
  });

  it('remembers that a restored pause was an idle pause', async () => {
    const { service, clock, idle, advance } = setup({}, (r) => {
      r.sessions.push(makeSession({ state: 'paused', pausedAt: iso(T0 + 5 * MIN), elapsedMs: 5 * MIN, updatedAt: iso(T0 + 5 * MIN) }));
      r.interruptions.push({ id: 'i1', sessionId: 'session-1', type: 'idle', reason: null, occurredAt: iso(T0 + 5 * MIN), idleMs: 120_000, createdAt: iso(T0) });
    });
    clock.now = T0 + 6 * MIN;
    await service.reconcileActiveSession();
    expect(service.getActiveSession()?.pauseKind).toBe('idle');
    idle.seconds = 0;
    await advance(1000);
    expect(service.getActiveSession()?.isRunning).toBe(true);
  });

  it('completes a countdown that ran out moments after the app went away', async () => {
    const { service, repo, blocking, clock } = setup({}, (r) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + 59 * MIN) }));
    });
    clock.now = T0 + 5 * 60 * MIN;
    await service.reconcileActiveSession();
    expect(service.getActiveSession()).toBeNull();
    expect(repo.row).toMatchObject({ state: 'completed', endReason: 'completed', endedAt: iso(T0 + 60 * MIN) });
    expect(blocking.leases).toHaveLength(0);
  });

  it('marks a countdown abandoned when the app was gone for most of it', async () => {
    const { service, repo, clock } = setup({}, (r) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + 10 * MIN) }));
    });
    clock.now = T0 + 5 * 60 * MIN;
    await service.reconcileActiveSession();
    expect(service.getActiveSession()).toBeNull();
    expect(repo.row).toMatchObject({ state: 'cancelled', endReason: 'abandoned', endedAt: iso(T0 + 10 * MIN), elapsedMs: 10 * MIN });
  });

  it('restores a recent stopwatch and abandons a stale one', async () => {
    const recent = setup({}, (r) => {
      r.sessions.push(makeSession({ mode: 'stopwatch', plannedDurationMinutes: null, updatedAt: iso(T0 + 10 * MIN) }));
    });
    recent.clock.now = T0 + 11 * MIN;
    await recent.service.reconcileActiveSession();
    expect(recent.service.getActiveSession()?.isRunning).toBe(true);

    const stale = setup({}, (r) => {
      r.sessions.push(makeSession({ mode: 'stopwatch', plannedDurationMinutes: null, updatedAt: iso(T0 + 10 * MIN) }));
    });
    stale.clock.now = T0 + 3 * 60 * MIN;
    await stale.service.reconcileActiveSession();
    expect(stale.service.getActiveSession()).toBeNull();
    expect(stale.repo.row).toMatchObject({ state: 'cancelled', endReason: 'abandoned', elapsedMs: 10 * MIN });
  });

  it('removes a session that never got past starting', async () => {
    const { service, repo } = setup({}, (r) => {
      r.sessions.push(makeSession({ state: 'planned', startedAt: null }));
    });
    await service.reconcileActiveSession();
    expect(repo.sessions).toHaveLength(0);
    expect(service.getActiveSession()).toBeNull();
  });

  it('keeps the session but reports degraded blocking when the lease cannot be re-acquired', async () => {
    const { service, clock } = setup({}, (r, b) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + MIN) }));
      b.failStartAlways = true;
    });
    clock.now = T0 + 2 * MIN;
    await service.reconcileActiveSession();
    const dto = service.getActiveSession();
    expect(dto?.isRunning).toBe(true);
    expect(dto?.blocking.status).toBe('degraded');
  });

  it('re-acquires the snapshot the session started with, not the current profile', async () => {
    const snapshot = { enabled: true, domains: ['old.example.com'], apps: [], rules: [{ type: 'website' as const, target: 'old.example.com', action: 'block' as const }] };
    const { service, blocking, clock } = setup({}, (r) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + MIN), blockingConfig: snapshot }));
    });
    clock.now = T0 + 2 * MIN;
    await service.reconcileActiveSession();
    expect(blocking.leases[0].config).toEqual(snapshot);
  });

  it('abandons a session whose profile no longer exists', async () => {
    const { service, repo } = setup({}, (r) => {
      r.sessions.push(makeSession({ profileId: 'deleted', updatedAt: iso(T0) }));
    });
    await service.reconcileActiveSession();
    expect(service.getActiveSession()).toBeNull();
    expect(repo.row).toMatchObject({ state: 'cancelled', endReason: 'abandoned' });
  });

  it('closes older strays so only one session is ever live', async () => {
    const { service, repo, clock } = setup({}, (r) => {
      r.sessions.push(makeSession({ id: 'old', createdAt: iso(T0 - 60 * MIN), updatedAt: iso(T0 - 50 * MIN), startedAt: iso(T0 - 60 * MIN) }));
      r.sessions.push(makeSession({ id: 'new', updatedAt: iso(T0 + MIN) }));
    });
    clock.now = T0 + 2 * MIN;
    await service.reconcileActiveSession();
    expect(service.getActiveSession()?.session.id).toBe('new');
    expect(repo.sessions.find((s) => s.id === 'old')).toMatchObject({ state: 'cancelled', endReason: 'abandoned' });
  });

  it('queues a start behind recovery instead of racing it', async () => {
    const { service, clock } = setup({}, (r, b) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + MIN) }));
      b.holdStart = true;
    });
    clock.now = T0 + 2 * MIN;
    const recovering = service.reconcileActiveSession();
    const starting = service.start(request({ task: 'Sneak in' }));
    const outcome = starting.then(() => 'started', (e) => (e as FocusError).code);
    await vi.advanceTimersByTimeAsync(0);
    (service as unknown as { blockingManager: { releaseStart(): void } }).blockingManager.releaseStart();
    await recovering;
    expect(await outcome).toBe('already-active');
    expect(service.getActiveSession()?.session.id).toBe('session-1');
  });
});

describe('FocusService — shutdown', () => {
  it('releases blocking but leaves the session open for the next launch', async () => {
    const { service, repo, blocking, advance, summaries } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(10 * MIN);
    await service.shutdown();

    expect(blocking.activeLeases).toHaveLength(0);
    expect(blocking.disposed).toBe(true);
    expect(repo.row.state).toBe('active');
    expect(repo.row.endReason).toBeNull();
    expect(repo.row.elapsedMs).toBe(10 * MIN);
    expect(summaries).toHaveLength(0);
  });

  it('stops ticking after shutdown', async () => {
    const { service, repo, advance } = setup();
    await service.start(request());
    await service.shutdown();
    await advance(60 * MIN);
    expect(repo.row.state).toBe('active');
  });
});

describe('FocusService — races', () => {
  it('start + start → exactly one session', async () => {
    const { service, repo, blocking } = setup();
    const results = await Promise.allSettled([service.start(request()), service.start(request({ task: 'Second' }))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(repo.sessions).toHaveLength(1);
    expect(blocking.leases).toHaveLength(1);
  });

  it('pause + pause and pause + resume stay consistent', async () => {
    const { service, repo } = setup();
    await service.start(request());
    await Promise.all([service.pause('a'), service.pause('b')]);
    expect(repo.interruptions.map((i) => i.type)).toEqual(['pause']);

    const [, resumed] = await Promise.all([service.pause('c'), service.resume()]);
    expect(resumed?.isRunning).toBe(true);
    expect(repo.row.state).toBe('active');
    expect(repo.interruptions.map((i) => i.type)).toEqual(['pause', 'resume']);
  });

  it('end + end → one summary', async () => {
    const { service, summaries, blocking } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    const challenge = await service.requestEnd();
    const results = await Promise.allSettled([
      service.confirmEnd({ token: challenge!.token }),
      service.confirmEnd({ token: challenge!.token }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(summaries).toHaveLength(1);
    expect(blocking.leases.filter((l) => l.stopped)).toHaveLength(1);
  });

  it('expiry wins over an end confirmed at the same moment: it is a completion', async () => {
    const { service, repo, clock, summaries, advance } = setup();
    await service.start(request());
    await advance(24 * MIN);
    const challenge = await service.requestEnd();
    clock.now = T0 + 25 * MIN; // the commitment ran out with the dialog open
    const ended = await service.confirmEnd({ token: challenge!.token, phrase: 'END', reason: 'Other' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ended.state).toBe('completed');
    expect(ended.endReason).toBe('completed');
    expect(ended.endNote).toBeNull();
    expect(repo.row.state).toBe('completed');
    expect(summaries).toHaveLength(1);
  });

  it('pause and resume around expiry cannot revive a finished session', async () => {
    const { service, repo, advance, summaries } = setup();
    await service.start(request());
    await advance(25 * MIN);
    expect(repo.row.state).toBe('completed');
    expect(await service.resume()).toBeNull();
    expect(await service.pause('Other')).toBeNull();
    expect(repo.row.state).toBe('completed');
    expect(summaries).toHaveLength(1);
  });

  it('a slow blocking release holds back the next start until it is done', async () => {
    const { service, repo, blocking } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    const challenge = await service.requestEnd();
    const order: string[] = [];
    const originalStop = blocking.stop.bind(blocking);
    blocking.stop = async (leaseId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      order.push('released');
      return originalStop(leaseId);
    };
    const ending = service.confirmEnd({ token: challenge!.token });
    const starting = service.start(request({ task: 'Next' })).then(() => order.push('started'));
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all([ending, starting]);
    expect(order).toEqual(['released', 'started']);
    expect(repo.sessions.map((s) => s.state)).toEqual(['completed', 'active']);
  });
});

describe('FocusService — preferences', () => {
  it('persists normalized preferences', () => {
    const { service, repo } = setup();
    const saved = service.setPreferences({ idleThresholdSeconds: 1, notifyStart: true, bogus: 1 });
    expect(saved.idleThresholdSeconds).toBe(30);
    expect(saved.notifyStart).toBe(true);
    expect(saved.idleAutoPause).toBe(true);
    expect(repo.preferences).toEqual(saved);
    expect('bogus' in saved).toBe(false);
  });

  it('knows whether a profile is in use', async () => {
    const { service } = setup();
    expect(service.isProfileInUse('profile-1')).toBe(false);
    await service.start(request());
    expect(service.isProfileInUse('profile-1')).toBe(true);
    expect(service.isProfileInUse('other')).toBe(false);
  });
});
