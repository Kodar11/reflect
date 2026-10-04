import { vi } from 'vitest';
import type { IFocusRepository } from '../../src/database/FocusRepository.js';
import {
  BlockingError,
  type BlockedAttemptCallback,
  type IBlockingManager,
} from '../../src/focus/BlockingManager.js';
import {
  DEFAULT_FOCUS_PREFERENCES,
  type BlockedAttempt,
  type EffectiveBlockingConfig,
  type FocusInterruption,
  type FocusPreferences,
  type FocusProfile,
  type FocusProfileRule,
  type FocusRule,
  type FocusSession,
  type StartFocusRequest,
} from '../../src/focus/FocusModels.js';
import { FocusService, type FocusNotice, type FocusServiceOptions } from '../../src/focus/FocusService.js';

export const T0 = Date.parse('2026-03-02T09:00:00.000Z');
export const MIN = 60_000;

export class FakeRepo implements IFocusRepository {
  profiles: FocusProfile[] = [makeProfile()];
  rules: FocusRule[] = [];
  sessions: FocusSession[] = [];
  interruptions: FocusInterruption[] = [];
  blockedAttempts: BlockedAttempt[] = [];
  preferences: FocusPreferences = { ...DEFAULT_FOCUS_PREFERENCES };
  failNextUpdate = false;

  getProfiles() { return this.profiles; }
  getProfileById(id: string) { return this.profiles.find((p) => p.id === id) ?? null; }
  getDefaultProfile() { return this.profiles.find((p) => p.isDefault) ?? null; }
  insertProfile(p: FocusProfile) { this.profiles.push(p); }
  updateProfile(p: FocusProfile) {
    const idx = this.profiles.findIndex((x) => x.id === p.id);
    if (idx !== -1) this.profiles[idx] = p;
  }
  deleteProfile(id: string) { this.profiles = this.profiles.filter((p) => p.id !== id); }

  getRules() { return this.rules; }
  getRuleById(id: string) { return this.rules.find((r) => r.id === id) ?? null; }
  insertRule(r: FocusRule) { this.rules.push(r); }
  updateRule(r: FocusRule) {
    const idx = this.rules.findIndex((x) => x.id === r.id);
    if (idx !== -1) this.rules[idx] = r;
  }
  deleteRule(id: string) { this.rules = this.rules.filter((r) => r.id !== id); }
  getProfileRuleIds(profileId: string) { return this.getProfileById(profileId)?.rules.map((r) => r.id) ?? []; }

  // Rows are copied in and out, like a real database: the service must
  // persist explicitly for a change to be visible here.
  getSessionById(id: string) { return clone(this.sessions.find((s) => s.id === id) ?? null); }
  getActiveSession() { return clone(this.getOpenSessions()[0] ?? null); }
  getOpenSessions() {
    return this.sessions
      .filter((s) => ['planned', 'active', 'paused'].includes(s.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => clone(s));
  }
  getSessionsByRange(from: string, to: string) {
    return this.sessions.filter((s) => s.startedAt && s.startedAt >= from && s.startedAt < to).map((s) => clone(s));
  }
  getSessionsForDay() { return this.sessions.map((s) => clone(s)); }
  getAllSessions() { return this.sessions.map((s) => clone(s)); }
  insertSession(s: FocusSession) { this.sessions.push(clone(s)); }
  updateSession(s: FocusSession) {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('disk full');
    }
    const idx = this.sessions.findIndex((x) => x.id === s.id);
    if (idx !== -1) this.sessions[idx] = clone(s);
  }
  deleteSession(id: string) { this.sessions = this.sessions.filter((s) => s.id !== id); }

  getInterruptions(sessionId: string) { return this.interruptions.filter((i) => i.sessionId === sessionId); }
  insertInterruption(i: FocusInterruption) { this.interruptions.push(i); }
  getBlockedAttempts(sessionId: string) { return this.blockedAttempts.filter((a) => a.sessionId === sessionId); }
  insertBlockedAttempt(a: BlockedAttempt) { this.blockedAttempts.push(a); }

  getPreferences() { return { ...this.preferences }; }
  savePreferences(p: FocusPreferences) { this.preferences = { ...p }; }

  /** The stored row for the only/first session. */
  get row(): FocusSession { return this.sessions[0]; }
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

interface FakeLease {
  leaseId: string;
  sessionId: string;
  config: EffectiveBlockingConfig;
  stopped: boolean;
}

export class FakeBlockingManager implements IBlockingManager {
  enforcement: 'real' | 'none' = 'real';
  leases: FakeLease[] = [];
  heartbeats: string[] = [];
  residue = false;
  disposed = false;
  /** Make the next `start` reject with this error. */
  failStartWith: Error | null = null;
  failStartAlways = false;
  /** Make `heartbeat` reject (the helper is gone / lease lost). */
  heartbeatFails = false;
  failStop = false;
  /** When set, `start` waits until `releaseStart()` is called. */
  holdStart = false;
  private pendingStarts: Array<() => void> = [];
  private callbacks = new Set<BlockedAttemptCallback>();

  get activeLeases(): FakeLease[] { return this.leases.filter((l) => !l.stopped); }

  async start(config: EffectiveBlockingConfig, sessionId: string) {
    if (this.holdStart) await new Promise<void>((resolve) => this.pendingStarts.push(resolve));
    if (this.failStartWith || this.failStartAlways) {
      const err = this.failStartWith ?? new BlockingError('helper-unavailable', 'The blocker is unavailable.');
      this.failStartWith = null;
      throw err;
    }
    const leaseId = `lease-${this.leases.length + 1}`;
    this.leases.push({ leaseId, sessionId, config, stopped: false });
    return leaseId;
  }

  releaseStart() {
    this.holdStart = false;
    for (const resolve of this.pendingStarts.splice(0)) resolve();
  }

  async heartbeat(leaseId: string) {
    if (this.heartbeatFails) throw new BlockingError('lease-lost', 'Blocking was released.');
    const lease = this.leases.find((l) => l.leaseId === leaseId);
    if (!lease || lease.stopped) throw new BlockingError('lease-lost', 'Blocking was released.');
    this.heartbeats.push(leaseId);
  }

  async stop(leaseId: string) {
    if (this.failStop) {
      this.residue = true;
      throw new BlockingError('disconnected', 'The blocker stopped responding.');
    }
    const lease = this.leases.find((l) => l.leaseId === leaseId);
    if (lease) lease.stopped = true;
  }

  hasResidue() { return this.residue; }
  async clearResidue() { this.residue = false; }
  async dispose() { this.disposed = true; }

  onBlockedAttempt(cb: BlockedAttemptCallback) { this.callbacks.add(cb); }
  offBlockedAttempt(cb: BlockedAttemptCallback) { this.callbacks.delete(cb); }

  simulateBlockedAttempt(sessionId: string, target: string, type: FocusProfileRule['type'] = 'app') {
    for (const cb of this.callbacks) cb({ type, target, sessionId });
  }
}

export function makeRule(overrides: Partial<FocusProfileRule> = {}): FocusProfileRule {
  const now = new Date(T0).toISOString();
  return { id: 'rule-1', profileId: 'profile-1', type: 'website', target: 'youtube.com', action: 'block', createdAt: now, updatedAt: now, ...overrides };
}

export function makeProfile(overrides: Partial<FocusProfile> = {}): FocusProfile {
  const now = new Date(T0).toISOString();
  return {
    id: 'profile-1',
    name: 'Deep Work',
    description: null,
    isDefault: true,
    mode: 'countdown',
    defaultDurationMinutes: 25,
    blocksDistractions: true,
    soundCue: null,
    createdAt: now,
    updatedAt: now,
    rules: [makeRule(), makeRule({ id: 'rule-2', type: 'app', target: 'discord.exe' })],
    ...overrides,
  };
}

export function makeSession(overrides: Partial<FocusSession> = {}): FocusSession {
  const now = new Date(T0).toISOString();
  return {
    id: 'session-1',
    profileId: 'profile-1',
    task: 'Resume me',
    notes: null,
    mode: 'countdown',
    plannedDurationMinutes: 60,
    state: 'active',
    startedAt: now,
    endedAt: null,
    pausedAt: null,
    totalPauseMs: 0,
    elapsedMs: 0,
    blockingLeaseId: 'old-lease',
    endReason: null,
    endNote: null,
    blockingConfig: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function request(overrides: Partial<StartFocusRequest> = {}): StartFocusRequest {
  return { profileId: 'profile-1', task: 'Write tests', ...overrides };
}

export interface Harness {
  repo: FakeRepo;
  blocking: FakeBlockingManager;
  service: FocusService;
  clock: { now: number };
  idle: { seconds: number | null };
  notices: FocusNotice[];
  summaries: FocusSession[];
  changes: Array<string | null>;
  /** Move the clock forward one second at a time, running timers as it goes. */
  advance(ms: number): Promise<void>;
  /** Jump the clock (machine asleep) and then let one tick observe it. */
  sleep(ms: number): Promise<void>;
}

/** Requires `vi.useFakeTimers()` to be active. */
export function setup(options: FocusServiceOptions = {}, prepare?: (repo: FakeRepo, blocking: FakeBlockingManager) => void): Harness {
  const repo = new FakeRepo();
  const blocking = new FakeBlockingManager();
  prepare?.(repo, blocking);
  const clock = { now: T0 };
  const idle: { seconds: number | null } = { seconds: 0 };
  const service = new FocusService(repo, blocking, {
    now: () => clock.now,
    getIdleSeconds: () => idle.seconds,
    ...options,
  });
  const notices: FocusNotice[] = [];
  const summaries: FocusSession[] = [];
  const changes: Array<string | null> = [];
  service.on('notice', (n) => notices.push(n));
  service.on('summary', (s) => summaries.push(s));
  service.on('activeSessionChanged', (dto) => changes.push(dto ? dto.session.state : null));

  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(1000, left);
      clock.now += step;
      await vi.advanceTimersByTimeAsync(step);
      left -= step;
    }
  };
  const sleep = async (ms: number) => {
    clock.now += ms + 1000;
    await vi.advanceTimersByTimeAsync(1000);
  };
  return { repo, blocking, service, clock, idle, notices, summaries, changes, advance, sleep };
}
