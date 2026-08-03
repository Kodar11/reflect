import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFocusRepository } from '../../src/database/FocusRepository.js';
import type { IBlockingManager } from '../../src/focus/BlockingManager.js';
import { FocusService } from '../../src/focus/FocusService.js';
import type { FocusProfile, FocusSession, StartFocusRequest } from '../../src/focus/FocusModels.js';

class FakeRepo implements IFocusRepository {
  profiles: FocusProfile[] = [createTestProfile()];
  sessions: FocusSession[] = [];
  interruptions = [];
  blockedAttempts = [];

  getProfiles() { return this.profiles; }
  getProfileById(id: string) { return this.profiles.find((p) => p.id === id) ?? null; }
  getDefaultProfile() { return this.profiles.find((p) => p.isDefault) ?? null; }
  insertProfile(p: FocusProfile, _ruleIds?: string[]) { this.profiles.push(p); }
  updateProfile(p: FocusProfile, _ruleIds?: string[]) {
    const idx = this.profiles.findIndex((x) => x.id === p.id);
    if (idx !== -1) this.profiles[idx] = p;
  }
  deleteProfile(id: string) { this.profiles = this.profiles.filter((p) => p.id !== id); }

  getRules() { return []; }
  getRuleById() { return null; }
  insertRule() { }
  updateRule() { }
  deleteRule() { }
  getProfileRuleIds() { return []; }

  getSessionById(id: string) { return this.sessions.find((s) => s.id === id) ?? null; }
  getActiveSession() { return this.sessions.find((s) => s.state === 'active' || s.state === 'paused') ?? null; }
  getSessionsByRange(from: string, to: string) {
    return this.sessions.filter((s) => s.startedAt && s.startedAt >= from && s.startedAt < to);
  }
  getSessionsForDay() { return this.sessions; }
  insertSession(s: FocusSession) { this.sessions.push(s); }
  updateSession(s: FocusSession) {
    const idx = this.sessions.findIndex((x) => x.id === s.id);
    if (idx !== -1) this.sessions[idx] = s;
  }

  getInterruptions(sessionId: string) { return this.interruptions.filter((i) => (i as any).sessionId === sessionId); }
  insertInterruption(i: any) { this.interruptions.push(i); }
  getBlockedAttempts(sessionId: string) { return this.blockedAttempts.filter((a) => (a as any).sessionId === sessionId); }
  insertBlockedAttempt(a: any) { this.blockedAttempts.push(a); }
}

class FakeBlockingManager implements IBlockingManager {
  leases: { leaseId: string; sessionId: string; stopped: boolean }[] = [];
  heartbeats: { leaseId: string; sessionId: string }[] = [];
  private callbacks: Array<(attempt: { type: any; target: string; sessionId: string }) => void> = [];

  async start(profile: FocusProfile, sessionId: string) {
    const leaseId = `lease-${this.leases.length + 1}`;
    this.leases.push({ leaseId, sessionId, stopped: false });
    return leaseId;
  }

  async heartbeat(leaseId: string, sessionId: string) {
    this.heartbeats.push({ leaseId, sessionId });
  }

  async stop(leaseId: string, sessionId: string) {
    const l = this.leases.find((x) => x.leaseId === leaseId);
    if (l) l.stopped = true;
  }

  onBlockedAttempt(cb: any) { this.callbacks.push(cb); }
  offBlockedAttempt(cb: any) { this.callbacks = this.callbacks.filter((c) => c !== cb); }

  simulateBlockedAttempt(sessionId: string, target: string) {
    for (const cb of this.callbacks) {
      cb({ type: 'website', target, sessionId });
    }
  }
}

function createTestProfile(): FocusProfile {
  return {
    id: 'profile-1',
    name: 'Deep Work',
    description: null,
    isDefault: true,
    mode: 'countdown',
    defaultDurationMinutes: 25,
    blocksDistractions: true,
    soundCue: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rules: [
      { id: 'rule-1', profileId: 'profile-1', type: 'category', target: 'social-media', action: 'block', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
  };
}

function setup(nowMs = 0, idleThresholdMs = 2 * 60 * 1000, reconcileThresholdMs = 2 * 60 * 1000) {
  const repo = new FakeRepo();
  const blocking = new FakeBlockingManager();
  const clock = { now: nowMs };
  const service = new FocusService(repo, blocking, () => clock.now, reconcileThresholdMs, idleThresholdMs);
  return { repo, blocking, service, clock };
}

function request(overrides: Partial<StartFocusRequest> = {}): StartFocusRequest {
  return { profileId: 'profile-1', task: 'Write tests', ...overrides };
}

describe('FocusService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('starts a countdown session and persists it', async () => {
    const { service, repo } = setup();
    const dto = await service.start(request());
    expect(dto.session.task).toBe('Write tests');
    expect(dto.session.mode).toBe('countdown');
    expect(dto.session.plannedDurationMinutes).toBe(25);
    expect(dto.session.state).toBe('active');
    expect(dto.isRunning).toBe(true);
    expect(dto.remainingMs).toBe(25 * 60_000);
    expect(repo.sessions.length).toBe(1);
    expect(repo.sessions[0].blockingLeaseId).toBeTruthy();
  });

  it('can use stopwatch mode', async () => {
    const { service } = setup();
    const dto = await service.start(request({ mode: 'stopwatch' }));
    expect(dto.session.mode).toBe('stopwatch');
    expect(dto.remainingMs).toBeNull();
  });

  it('refuses to start a second session', async () => {
    const { service } = setup();
    await service.start(request());
    await expect(service.start(request({ task: 'Another' }))).rejects.toThrow('already active');
  });

  it('updates elapsed time and remaining time', async () => {
    const { service, clock } = setup();
    const dto = await service.start(request());
    clock.now = 60_000;
    const next = service.getActiveSession();
    expect(next?.liveElapsedMs).toBe(60_000);
    expect(next?.remainingMs).toBe(24 * 60_000);
  });

  it('pauses and resumes tracking', async () => {
    const { service, clock, repo } = setup();
    await service.start(request());
    clock.now = 60_000;
    service.pause('quick break');
    expect(service.getActiveSession()?.isRunning).toBe(false);
    expect(repo.interruptions.length).toBe(1);
    expect(repo.interruptions[0].type).toBe('pause');

    clock.now = 90_000;
    service.resume();
    expect(service.getActiveSession()?.isRunning).toBe(true);
    expect(repo.interruptions.length).toBe(2);
    expect(repo.interruptions[1].type).toBe('resume');

    clock.now = 120_000;
    expect(service.getActiveSession()?.liveElapsedMs).toBe(90_000); // 120s - 30s pause
  });

  it('stops a session and emits a summary', async () => {
    const { service, clock, repo } = setup();
    const emitted = vi.fn();
    service.on('summary', (session, profile) => emitted({ session, profile }));
    await service.start(request());
    clock.now = 120_000;
    const stopped = service.stop('completed');
    expect(stopped?.state).toBe('completed');
    expect(stopped?.elapsedMs).toBe(120_000);
    expect(service.getActiveSession()).toBeNull();
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0][0].session.id).toBe(stopped?.id);
    expect(repo.sessions[0].state).toBe('completed');
  });

  it('records blocked attempts', async () => {
    const { service, blocking, repo } = setup();
    await service.start(request());
    blocking.simulateBlockedAttempt(repo.sessions[0].id, 'twitter.com');
    expect(repo.blockedAttempts.length).toBe(1);
    expect(repo.blockedAttempts[0].target).toBe('twitter.com');
  });

  it('acquires and releases a blocking lease', async () => {
    const { service, blocking, clock } = setup();
    await service.start(request());
    expect(blocking.leases.length).toBe(1);
    expect(blocking.leases[0].stopped).toBe(false);

    clock.now = 1_000;
    vi.advanceTimersByTime(1000);
    expect(blocking.heartbeats.length).toBeGreaterThan(0);

    service.stop('completed');
    expect(blocking.leases[0].stopped).toBe(true);
  });

  it('reconciles a recent active session on startup', async () => {
    const { repo, service, clock } = setup(0);
    const session: FocusSession = {
      id: 'old-session',
      profileId: 'profile-1',
      task: 'Resume me',
      notes: null,
      mode: 'stopwatch',
      plannedDurationMinutes: null,
      state: 'active',
      startedAt: new Date(0).toISOString(),
      endedAt: null,
      pausedAt: null,
      totalPauseMs: 0,
      elapsedMs: 0,
      blockingLeaseId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    repo.sessions.push(session);

    clock.now = 60_000;
    const changed = vi.fn();
    service.on('activeSessionChanged', changed);
    await service.reconcileActiveSession();
    expect(service.getActiveSession()?.session.id).toBe('old-session');
    expect(changed).toHaveBeenCalled();
  });

  it('closes a stale active session on startup', async () => {
    const { repo, service, clock } = setup(0);
    const session: FocusSession = {
      id: 'stale-session',
      profileId: 'profile-1',
      task: 'Stale',
      notes: null,
      mode: 'stopwatch',
      plannedDurationMinutes: null,
      state: 'active',
      startedAt: new Date(0).toISOString(),
      endedAt: null,
      pausedAt: null,
      totalPauseMs: 0,
      elapsedMs: 0,
      blockingLeaseId: 'old-lease',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    repo.sessions.push(session);

    clock.now = 5 * 60_000;
    const summary = vi.fn();
    service.on('summary', summary);
    await service.reconcileActiveSession();
    expect(service.getActiveSession()).toBeNull();
    expect(repo.sessions[0].state).toBe('completed');
    expect(summary).toHaveBeenCalled();
  });

  it('auto-pauses after idle and auto-resumes on activity', async () => {
    const { service, clock, repo } = setup(0, 1000);
    await service.start(request());
    clock.now = 500;
    vi.advanceTimersByTime(500);
    expect(service.getActiveSession()?.isRunning).toBe(true);

    clock.now = 2000;
    vi.advanceTimersByTime(1500);
    expect(service.getActiveSession()?.isRunning).toBe(false);
    expect(repo.interruptions.some((i) => (i as any).type === 'idle')).toBe(true);

    // Simulate activity returning
    service.recordActivity();
    expect(service.getActiveSession()?.isRunning).toBe(true);
  });
});
