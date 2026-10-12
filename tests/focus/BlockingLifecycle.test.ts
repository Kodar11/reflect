import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockingError } from '../../src/focus/BlockingManager.js';
import { FocusService } from '../../src/focus/FocusService.js';
import { MIN, T0, makeSession, request, setup } from './helpers.js';

/**
 * The blocking lease across a session's whole life: acquired at start, kept
 * through pauses, released — by the session that owns it, and only that one —
 * when the session becomes terminal, and honestly reported when a release
 * does not work.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number) => new Date(ms).toISOString();

async function endDeliberately(service: FocusService, reason: string | null = null) {
  const challenge = await service.requestEnd();
  if (!challenge) throw new Error('no session to end');
  return service.confirmEnd({ token: challenge.token, phrase: challenge.requiresPhrase ? challenge.phrase : null, reason });
}

describe('Blocking lifecycle — every terminal transition releases the session\'s own lease', () => {
  it('countdown completion releases the lease it acquired', async () => {
    const { service, repo, blocking, advance, cleanups } = setup();
    const dto = await service.start(request());
    await advance(25 * MIN);

    expect(repo.row.state).toBe('completed');
    expect(blocking.stops).toEqual([{ leaseId: 'lease-1', sessionId: dto.session.id }]);
    expect(blocking.activeLeases).toHaveLength(0);
    expect(repo.row.blockingLeaseId).toBeNull();
    expect(service.hasBlockingResidue()).toBe(false);
    expect(cleanups).toEqual([]); // nothing was ever left behind, so nothing to report
  });

  it('finishing a stopwatch releases the lease', async () => {
    const { service, repo, blocking, advance } = setup();
    const dto = await service.start(request({ mode: 'stopwatch' }));
    await advance(10 * MIN);
    await endDeliberately(service);
    expect(repo.row).toMatchObject({ state: 'completed', endReason: 'finished', blockingLeaseId: null });
    expect(blocking.stops).toEqual([{ leaseId: 'lease-1', sessionId: dto.session.id }]);
  });

  it('a confirmed early end (cancellation) releases the lease', async () => {
    const { service, repo, blocking, advance } = setup();
    const dto = await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(5 * MIN);
    await endDeliberately(service, 'Meeting');
    expect(repo.row).toMatchObject({ state: 'cancelled', endReason: 'ended-early', blockingLeaseId: null });
    expect(blocking.stops).toEqual([{ leaseId: 'lease-1', sessionId: dto.session.id }]);
    expect(service.hasBlockingResidue()).toBe(false);
  });

  it('ending while paused releases the lease too', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(5 * MIN);
    await service.pause('Meeting');
    await advance(5 * MIN);
    await endDeliberately(service);
    expect(blocking.activeLeases).toHaveLength(0);
    expect(blocking.stops).toHaveLength(1);
  });

  it('releases the lease that replaced a lost one, not the one the session started with', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request());
    blocking.leases[0].stopped = true; // the helper dropped it; the service re-acquires
    await advance(6000);
    await endDeliberately(service);
    expect(blocking.stops.map((s) => s.leaseId)).toEqual(['lease-2']);
    expect(blocking.activeLeases).toHaveLength(0);
  });

  it('a session that blocked nothing has nothing to release', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ withoutBlocking: true }));
    await advance(25 * MIN);
    expect(blocking.leases).toHaveLength(0);
    expect(blocking.stops).toHaveLength(0);
  });

  it('repeated terminal events release once', async () => {
    const { service, blocking, advance, summaries } = setup();
    await service.start(request());
    await advance(24 * MIN);
    const challenge = await service.requestEnd();
    await advance(MIN); // expires with the dialog open
    await expect(service.confirmEnd({ token: challenge!.token, phrase: 'END' })).rejects.toMatchObject({ code: 'no-session' });
    await advance(10 * MIN);
    expect(summaries).toHaveLength(1);
    expect(blocking.stops).toHaveLength(1);
  });
});

describe('Blocking lifecycle — a normal end never asks the user to clean up', () => {
  it('does not report leftovers while the release is still in flight', async () => {
    const { service, blocking, advance, cleanups } = setup();
    await service.start(request());
    blocking.residue = true; // the session's entries are on disk, as they should be

    const seenAtEnd: boolean[] = [];
    service.on('activeSessionChanged', (dto) => {
      // This is the moment the renderer used to ask — before the release finished.
      if (!dto) seenAtEnd.push(service.hasBlockingResidue());
    });
    const release = blocking.stop.bind(blocking);
    blocking.stop = async (leaseId: string, sessionId?: string) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return release(leaseId, sessionId);
    };

    await advance(25 * MIN);
    expect(seenAtEnd).toEqual([false]);
    expect(service.getBlockingCleanup()).toEqual({ residue: false, message: null });

    await advance(2000);
    expect(blocking.activeLeases).toHaveLength(0);
    expect(service.hasBlockingResidue()).toBe(false);
    expect(cleanups.filter((c) => c.residue)).toEqual([]);
  });
});

describe('Blocking lifecycle — start', () => {
  it('a failed start holds no lease, leaves no session and reports nothing left behind', async () => {
    const { service, repo, blocking, cleanups } = setup({}, (_repo, b) => {
      b.failStartWith = new BlockingError('rejected', 'Reflect could not change the hosts file.');
    });
    await expect(service.start(request())).rejects.toMatchObject({ code: 'blocking-failed' });
    expect(blocking.activeLeases).toHaveLength(0);
    expect(repo.sessions).toHaveLength(0);
    expect(service.hasBlockingResidue()).toBe(false);
    expect(cleanups).toEqual([]);
  });

  it('a start that cannot be persisted gives its lease back', async () => {
    const { service, repo, blocking } = setup();
    repo.failNextUpdate = true;
    await expect(service.start(request())).rejects.toThrow('disk full');
    expect(blocking.stops.map((s) => s.leaseId)).toEqual(['lease-1']);
    expect(blocking.activeLeases).toHaveLength(0);
    expect(service.hasBlockingResidue()).toBe(false);
  });
});

describe('Blocking lifecycle — pause is not end', () => {
  it('pause and resume keep the one lease and never acquire another', async () => {
    const { service, blocking, advance, idle } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    for (let i = 0; i < 3; i += 1) {
      await advance(2 * MIN);
      await service.pause('Quick break');
      await advance(MIN);
      expect(blocking.activeLeases.map((l) => l.leaseId)).toEqual(['lease-1']);
      await service.resume();
    }
    // An idle pause and its automatic resume behave the same way.
    idle.seconds = 300;
    await advance(1000);
    expect(service.getActiveSession()?.pauseKind).toBe('idle');
    idle.seconds = 0;
    await advance(1000);
    expect(service.getActiveSession()?.isRunning).toBe(true);

    expect(blocking.leases).toHaveLength(1);
    expect(blocking.stops).toHaveLength(0);
    expect(service.getActiveSession()?.blocking.status).toBe('active');
  });
});

describe('Blocking lifecycle — a release that fails', () => {
  it('is recorded, reported with its reason, and retried once without the user', async () => {
    const logged: string[] = [];
    const { service, blocking, advance, cleanups } = setup({ log: (m) => logged.push(m) });
    const dto = await service.start(request({ mode: 'stopwatch' }));
    blocking.failStopWith = [new BlockingError('rejected', 'Reflect could not change the hosts file. Another program (often antivirus) may be protecting it.')];
    const ended = await endDeliberately(service);

    expect(ended.state).toBe('completed'); // the session is over regardless
    expect(service.getBlockingCleanup()).toEqual({ residue: true, message: expect.stringContaining('hosts file') });
    expect(cleanups.at(-1)).toMatchObject({ residue: true });
    // Enough to investigate: which session, which lease, what kind of failure.
    expect(logged.join('\n')).toContain(dto.session.id);
    expect(logged.join('\n')).toContain('lease-1');
    expect(logged.join('\n')).toContain('rejected');

    await advance(20_000);
    expect(blocking.stops).toEqual([
      { leaseId: 'lease-1', sessionId: dto.session.id },
      { leaseId: 'lease-1', sessionId: dto.session.id },
    ]);
    expect(service.getBlockingCleanup()).toEqual({ residue: false, message: null });
    expect(cleanups.at(-1)).toEqual({ residue: false, message: null });
  });

  it('never claims success, and stops trying after a bounded number of attempts', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    blocking.failStopWith = [new BlockingError('rejected', 'nope'), new BlockingError('rejected', 'still nope')];
    await endDeliberately(service);

    const checks = vi.spyOn(blocking, 'hasResidue');
    await advance(60 * MIN);
    expect(blocking.stops).toHaveLength(2); // the release and its one retry
    expect(service.hasBlockingResidue()).toBe(true);
    const settled = checks.mock.calls.length;
    await advance(60 * MIN);
    expect(checks.mock.calls.length).toBe(settled); // no endless loop
    expect(service.getBlockingCleanup()).toEqual({ residue: true, message: 'still nope' });
  });

  it('does not retry by itself when that would mean another elevation prompt', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    blocking.failStop = true; // the blocker is gone
    await endDeliberately(service);
    blocking.failStop = false;
    await advance(5 * MIN);
    expect(blocking.stops).toHaveLength(1);
    expect(service.hasBlockingResidue()).toBe(true);

    // The user's "Remove it" is the retry, and it is safe to repeat.
    await service.clearBlockingResidue();
    await service.clearBlockingResidue();
    expect(service.getBlockingCleanup()).toEqual({ residue: false, message: null });
  });

  it('notices when the blocker lets go by itself', async () => {
    const { service, blocking, advance, cleanups } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    blocking.failStop = true;
    await endDeliberately(service);
    expect(cleanups.at(-1)).toMatchObject({ residue: true });

    blocking.residue = false; // its lease ran out and it restored the machine
    await advance(20_000);
    expect(cleanups.at(-1)).toEqual({ residue: false, message: null });
  });

  it('reports a manual removal that fails, with the reason', async () => {
    const { service, blocking } = setup();
    blocking.residue = true;
    blocking.clearResidue = async () => {
      throw new BlockingError('elevation-declined', 'Administrator permission was declined.');
    };
    await expect(service.clearBlockingResidue()).rejects.toThrow('declined');
    expect(service.getBlockingCleanup()).toEqual({ residue: true, message: 'Administrator permission was declined.' });
  });
});

describe('Blocking lifecycle — ownership', () => {
  it('a retry never touches the blocking of a session started meanwhile', async () => {
    const { service, blocking, advance } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    blocking.failStopWith = [new BlockingError('timeout', 'The blocker did not respond.')];
    await endDeliberately(service);
    expect(service.hasBlockingResidue()).toBe(true);

    const next = await service.start(request({ task: 'Next' }));
    expect(service.hasBlockingResidue()).toBe(false); // it has an owner again
    await advance(5 * MIN);

    expect(blocking.stops).toHaveLength(1);
    expect(blocking.leases.find((l) => l.sessionId === next.session.id)?.stopped).toBe(false);
    expect(service.getActiveSession()?.blocking.status).toBe('active');
  });

  it('leftover removal is refused while a session owns the blocking state', async () => {
    const { service, blocking } = setup();
    await service.start(request());
    blocking.residue = true;
    await service.clearBlockingResidue();
    expect(blocking.residue).toBe(true);
    expect(blocking.activeLeases).toHaveLength(1);
  });

  it('ending one session leaves the next one\'s lease alone', async () => {
    const { service, blocking } = setup();
    await service.start(request({ mode: 'stopwatch' }));
    await endDeliberately(service);
    const second = await service.start(request({ task: 'Second', mode: 'stopwatch' }));
    expect(blocking.activeLeases.map((l) => l.sessionId)).toEqual([second.session.id]);
    expect(blocking.stops.map((s) => s.leaseId)).toEqual(['lease-1']);
  });
});

describe('Blocking lifecycle — crash and restart', () => {
  it('a restored session owns its blocking again: no leftovers are reported', async () => {
    const { service, blocking, clock, cleanups } = setup({}, (r, b) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + 10 * MIN), elapsedMs: 10 * MIN }));
      b.residue = true; // the entries of the session that is about to be restored
    });
    clock.now = T0 + 11 * MIN;
    await service.reconcileActiveSession();
    expect(service.getActiveSession()?.blocking.status).toBe('active');
    expect(blocking.activeLeases).toHaveLength(1);
    expect(service.hasBlockingResidue()).toBe(false);
    expect(cleanups).toEqual([]);
  });

  it('an abandoned session keeps no lease; a blocker that outlived the crash lets go and that is noticed', async () => {
    const { service, repo, blocking, clock, advance, cleanups } = setup({}, (r, b) => {
      r.sessions.push(makeSession({ updatedAt: iso(T0 + 10 * MIN) }));
      b.residue = true;
    });
    clock.now = T0 + 5 * 60 * MIN;
    await service.reconcileActiveSession();

    expect(repo.row).toMatchObject({ state: 'cancelled', endReason: 'abandoned', blockingLeaseId: null });
    expect(blocking.leases).toHaveLength(0);
    expect(cleanups.at(-1)).toEqual({ residue: true, message: null });

    blocking.residue = false; // the orphaned lease expired
    await advance(20_000);
    expect(cleanups.at(-1)).toEqual({ residue: false, message: null });
    expect(service.hasBlockingResidue()).toBe(false);
  });

  it('true orphans (crash plus power loss) stay reported until the user removes them', async () => {
    const { service, blocking, advance, cleanups } = setup({}, (_r, b) => {
      b.residue = true;
    });
    await service.reconcileActiveSession();
    await advance(10 * MIN);
    expect(service.hasBlockingResidue()).toBe(true);
    expect(cleanups.filter((c) => c.residue)).toHaveLength(1); // said once, not repeatedly

    await service.clearBlockingResidue();
    expect(blocking.residue).toBe(false);
    expect(cleanups.at(-1)).toEqual({ residue: false, message: null });
  });

  it('shutdown releases the lease but does not end the session', async () => {
    const { service, repo, blocking, advance } = setup();
    await service.start(request({ plannedDurationMinutes: 60 }));
    await advance(10 * MIN);
    await service.shutdown();
    expect(blocking.stops.map((s) => s.leaseId)).toEqual(['lease-1']);
    expect(repo.row.state).toBe('active');
  });
});
