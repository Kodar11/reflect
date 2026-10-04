import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_FOCUS_PREFERENCES,
  MAX_NOTES_LENGTH,
  MAX_PLANNED_MINUTES,
  MAX_REASON_LENGTH,
  MAX_TASK_LENGTH,
  normalizeFocusPreferences,
  type ActiveFocusSessionDto,
  type BlockedAttempt,
  type ConfirmEndRequest,
  type EffectiveBlockingConfig,
  type EndFocusChallenge,
  type FocusBlockingStatus,
  type FocusEndReason,
  type FocusInterruption,
  type FocusPreferences,
  type FocusProfile,
  type FocusSession,
  type FocusSessionState,
  type StartFocusRequest,
} from './FocusModels.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { BlockedAttemptEvent, BlockingLeaseId, IBlockingManager } from './BlockingManager.js';
import { compileBlockingConfig, countBlockRules, isDomainBlocked } from './BlockingConfig.js';

/**
 * FocusService is the single authority over a Focus session's lifecycle.
 *
 * State machine (enforced here, never in the renderer):
 *
 *   start ──► active ◄──► paused
 *               │            │
 *               └──────┬─────┘
 *                      ▼
 *            completed / cancelled        (terminal — nothing leaves them)
 *
 * Rules that make Focus a commitment rather than a timer:
 *   - A countdown counts active work: it ends when `elapsedMs` reaches the
 *     planned duration. Pausing (manual, idle or sleep) stops the timer and
 *     pushes the end back by the time paused — the commitment is not
 *     shortened by pausing, and blocking stays on throughout.
 *   - Natural completion is generated HERE when the commitment ends. The
 *     renderer cannot complete a session.
 *   - Ending early needs a challenge issued by `requestEnd` and answered
 *     through `confirmEnd`. There is no other exit.
 *   - Pausing — manual or idle — never releases blocking.
 *   - Every mutating operation runs on one queue, so start/pause/resume/
 *     end/expiry can never interleave.
 */

export type FocusNotice =
  | { kind: 'started'; session: FocusSession; profile: FocusProfile }
  | { kind: 'idle-paused'; session: FocusSession }
  | { kind: 'idle-resumed'; session: FocusSession }
  | { kind: 'blocked'; session: FocusSession; type: BlockedAttempt['type']; target: string }
  | { kind: 'blocking-lost'; session: FocusSession; message: string }
  | { kind: 'blocking-restored'; session: FocusSession };

export type FocusServiceEvents = {
  /** State, pause or blocking status changed (not fired every second). */
  activeSessionChanged: (dto: ActiveFocusSessionDto | null) => void;
  /** A session ended. */
  summary: (session: FocusSession, profile: FocusProfile) => void;
  /** Once per timer tick while a session exists; for the tray clock. */
  tick: (dto: ActiveFocusSessionDto) => void;
  notice: (notice: FocusNotice) => void;
};

export type FocusErrorCode =
  | 'already-active'
  | 'invalid-request'
  | 'profile-not-found'
  | 'blocking-failed'
  | 'no-session'
  | 'end-not-confirmed';

/** An error whose message is safe and useful to show to the user. */
export class FocusError extends Error {
  constructor(
    readonly code: FocusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FocusError';
  }
}

export interface FocusServiceOptions {
  now?: () => number;
  /** Seconds since the last keyboard/mouse input; null when unknown. */
  getIdleSeconds?: () => number | null;
  tickMs?: number;
  /** How often the blocking lease is heartbeated. */
  leaseHeartbeatMs?: number;
  /** How often progress is written to the database. */
  persistMs?: number;
  /** A stopwatch found open on startup is resumed only if seen this recently. */
  resumeWindowMs?: number;
  /** A gap between ticks longer than this is treated as sleep, not work. */
  sleepGapMs?: number;
  endChallengeTtlMs?: number;
  log?: (message: string) => void;
}

export interface IFocusService {
  on<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void;
  off<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void;

  listProfiles(): FocusProfile[];
  getActiveSession(): ActiveFocusSessionDto | null;
  isProfileInUse(profileId: string): boolean;
  reconcileActiveSession(): Promise<void>;
  start(request: StartFocusRequest): Promise<ActiveFocusSessionDto>;
  pause(reason?: string | null): Promise<ActiveFocusSessionDto | null>;
  resume(): Promise<ActiveFocusSessionDto | null>;
  requestEnd(): Promise<EndFocusChallenge | null>;
  confirmEnd(request: ConfirmEndRequest): Promise<FocusSession>;
  restoreBlocking(): Promise<ActiveFocusSessionDto | null>;
  getPreferences(): FocusPreferences;
  setPreferences(preferences: unknown): FocusPreferences;
  hasBlockingResidue(): boolean;
  clearBlockingResidue(): Promise<void>;
  observeDomain(domain: string | null | undefined): void;
  handleSystemResume(): void;
  shutdown(): Promise<void>;
}

interface InternalState {
  session: FocusSession;
  /** Snapshot taken at start; later profile edits do not reach this session. */
  profile: FocusProfile;
  config: EffectiveBlockingConfig;
  leaseId: BlockingLeaseId | null;
  blockingStatus: FocusBlockingStatus;
  blockingMessage: string | null;
  pauseKind: 'manual' | 'idle' | null;
  timer: ReturnType<typeof setInterval>;
  lastTickAt: number;
  lastPersistAt: number;
  lastLeaseBeatAt: number;
  heartbeatInFlight: boolean;
  /** When the active-work timer last started running. */
  runningSince: number;
  /** target key → last time it was recorded, to keep attempt logs readable. */
  recentAttempts: Map<string, number>;
}

interface PendingChallenge extends EndFocusChallenge {
  expiresAtMs: number;
}

type ListenerSets = { [K in keyof FocusServiceEvents]: Set<FocusServiceEvents[K]> };

export const END_PHRASE = 'END';
/** Input newer than this means the user is back at the machine. */
const IDLE_RETURN_SECONDS = 5;
const ATTEMPT_DEDUPE_MS = 60_000;

export class FocusService implements IFocusService {
  private active: InternalState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private challenge: PendingChallenge | null = null;
  private preferences: FocusPreferences;
  private readonly listeners: ListenerSets = {
    activeSessionChanged: new Set(),
    summary: new Set(),
    tick: new Set(),
    notice: new Set(),
  };

  private readonly now: () => number;
  private readonly getIdleSeconds: () => number | null;
  private readonly tickMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly persistMs: number;
  private readonly resumeWindowMs: number;
  private readonly sleepGapMs: number;
  private readonly endChallengeTtlMs: number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly repo: IFocusRepository,
    private readonly blockingManager: IBlockingManager,
    options: FocusServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.getIdleSeconds = options.getIdleSeconds ?? (() => null);
    this.tickMs = options.tickMs ?? 1000;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 5000;
    this.persistMs = options.persistMs ?? 5000;
    this.resumeWindowMs = options.resumeWindowMs ?? 2 * 60_000;
    this.sleepGapMs = options.sleepGapMs ?? 15_000;
    this.endChallengeTtlMs = options.endChallengeTtlMs ?? 2 * 60_000;
    this.log = options.log ?? (() => {});
    try {
      this.preferences = this.repo.getPreferences();
    } catch {
      this.preferences = { ...DEFAULT_FOCUS_PREFERENCES };
    }
    this.blockingManager.onBlockedAttempt(this.handleBlockedAttempt);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  on<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  private emit<K extends keyof FocusServiceEvents>(event: K, ...args: Parameters<FocusServiceEvents[K]>): void {
    for (const listener of this.listeners[event] as Set<(...a: unknown[]) => void>) {
      try {
        listener(...args);
      } catch (err) {
        // A broken listener (tray, IPC) must never break the state machine.
        this.log(`focus listener for "${event}" failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Run `fn` after every previously requested operation has finished. */
  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  listProfiles(): FocusProfile[] {
    return this.repo.getProfiles();
  }

  getActiveSession(): ActiveFocusSessionDto | null {
    return this.active ? this.buildDto(this.active) : null;
  }

  isProfileInUse(profileId: string): boolean {
    return this.active?.session.profileId === profileId;
  }

  getPreferences(): FocusPreferences {
    return { ...this.preferences };
  }

  setPreferences(preferences: unknown): FocusPreferences {
    const next = normalizeFocusPreferences(preferences);
    this.repo.savePreferences(next);
    this.preferences = next;
    return { ...next };
  }

  // ── Start ────────────────────────────────────────────────────────────────

  start(request: StartFocusRequest): Promise<ActiveFocusSessionDto> {
    return this.enqueue(async () => {
      if (this.active) throw new FocusError('already-active', 'A Focus session is already running.');

      const task = typeof request?.task === 'string' ? request.task.trim() : '';
      if (!task) throw new FocusError('invalid-request', 'Enter what you are focusing on.');
      if (task.length > MAX_TASK_LENGTH) {
        throw new FocusError('invalid-request', `Keep the task under ${MAX_TASK_LENGTH} characters.`);
      }
      const notes = typeof request.notes === 'string' ? request.notes.trim().slice(0, MAX_NOTES_LENGTH) || null : null;

      const found = typeof request.profileId === 'string' ? this.repo.getProfileById(request.profileId) : null;
      if (!found) throw new FocusError('profile-not-found', 'That Focus profile no longer exists.');
      const profile = structuredClone(found);

      const mode = request.mode ?? profile.mode;
      if (mode !== 'countdown' && mode !== 'stopwatch') throw new FocusError('invalid-request', 'Unknown timer mode.');
      let plannedDurationMinutes: number | null = null;
      if (mode === 'countdown') {
        const minutes = request.plannedDurationMinutes ?? profile.defaultDurationMinutes ?? 25;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PLANNED_MINUTES) {
          throw new FocusError('invalid-request', `Choose a duration between 1 and ${MAX_PLANNED_MINUTES} minutes.`);
        }
        plannedDurationMinutes = minutes;
      }

      const config: EffectiveBlockingConfig =
        request.withoutBlocking === true ? { enabled: false, domains: [], apps: [], rules: [] } : compileBlockingConfig(profile);
      const createdAt = new Date(this.now()).toISOString();
      const session: FocusSession = {
        id: randomUUID(),
        profileId: profile.id,
        task,
        notes,
        mode,
        plannedDurationMinutes,
        // Not a running session until blocking is confirmed.
        state: 'planned',
        startedAt: null,
        endedAt: null,
        pausedAt: null,
        totalPauseMs: 0,
        elapsedMs: 0,
        blockingLeaseId: null,
        endReason: null,
        endNote: null,
        blockingConfig: config,
        createdAt,
        updatedAt: createdAt,
      };
      this.repo.insertSession(session);

      let leaseId: BlockingLeaseId | null = null;
      let blockingStatus: FocusBlockingStatus = 'off';
      if (config.enabled) {
        if (this.blockingManager.enforcement === 'none') {
          blockingStatus = 'unavailable';
        } else {
          try {
            leaseId = await this.blockingManager.start(config, session.id);
            blockingStatus = 'active';
          } catch (err) {
            // Never a session that claims blocking it does not have.
            this.repo.deleteSession(session.id);
            const detail = (err as Error)?.message ?? 'Blocking could not be turned on.';
            throw new FocusError('blocking-failed', `${detail} Focus was not started.`);
          }
        }
      }

      const startedAtMs = this.now();
      const startedAt = new Date(startedAtMs).toISOString();
      session.state = 'active';
      session.startedAt = startedAt;
      session.updatedAt = startedAt;
      session.blockingLeaseId = leaseId;
      try {
        this.repo.updateSession(session);
      } catch (err) {
        if (leaseId) await this.blockingManager.stop(leaseId, session.id).catch(() => {});
        try {
          this.repo.deleteSession(session.id);
        } catch {
          // Startup reconciliation removes a session that never started.
        }
        throw err;
      }

      const state = this.activate(session, profile, config, startedAtMs);
      state.leaseId = leaseId;
      state.blockingStatus = blockingStatus;
      state.blockingMessage = blockingStatus === 'unavailable' ? 'Blocking is not available on this system.' : null;

      const dto = this.buildDto(state);
      this.emit('activeSessionChanged', dto);
      this.emit('notice', { kind: 'started', session: { ...session }, profile });
      return dto;
    });
  }

  private activate(session: FocusSession, profile: FocusProfile, config: EffectiveBlockingConfig, nowMs: number): InternalState {
    const state: InternalState = {
      session,
      profile,
      config,
      leaseId: null,
      blockingStatus: 'off',
      blockingMessage: null,
      pauseKind: null,
      timer: setInterval(() => this.tick(), this.tickMs),
      lastTickAt: nowMs,
      lastPersistAt: nowMs,
      lastLeaseBeatAt: nowMs,
      heartbeatInFlight: false,
      runningSince: nowMs,
      recentAttempts: new Map(),
    };
    this.active = state;
    this.challenge = null;
    return state;
  }

  // ── Pause / resume ───────────────────────────────────────────────────────

  pause(reason: string | null = null): Promise<ActiveFocusSessionDto | null> {
    return this.enqueue(() => {
      const a = this.active;
      if (!a) return null;
      if (a.session.state === 'active') {
        const text = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_LENGTH) || null : null;
        this.pauseNow(a, 'manual', { reason: text });
      }
      return this.buildDto(a);
    });
  }

  resume(): Promise<ActiveFocusSessionDto | null> {
    return this.enqueue(() => {
      const a = this.active;
      if (!a) return null;
      if (a.session.state === 'paused') this.resumeNow(a);
      return this.buildDto(a);
    });
  }

  private pauseNow(
    a: InternalState,
    kind: 'manual' | 'idle',
    opts: { reason?: string | null; at?: number; idleMs?: number | null } = {},
  ): void {
    const { session } = a;
    if (session.state !== 'active') return;
    const now = this.now();
    const at = Math.min(now, Math.max(opts.at ?? now, a.runningSince));
    session.elapsedMs = this.activeWorkMs(session, at);
    session.state = 'paused';
    session.pausedAt = new Date(at).toISOString();
    session.updatedAt = new Date(now).toISOString();
    a.pauseKind = kind;
    this.recordInterruption(session.id, kind === 'idle' ? 'idle' : 'pause', opts.reason ?? null, opts.idleMs ?? null, at);
    this.persist(a, now);
    this.emit('activeSessionChanged', this.buildDto(a));
    if (kind === 'idle') this.emit('notice', { kind: 'idle-paused', session: { ...session } });
  }

  private resumeNow(a: InternalState): void {
    const { session } = a;
    if (session.state !== 'paused') return;
    const now = this.now();
    const wasIdle = a.pauseKind === 'idle';
    if (session.pausedAt) {
      session.totalPauseMs += Math.max(0, now - new Date(session.pausedAt).getTime());
    }
    session.state = 'active';
    session.pausedAt = null;
    session.updatedAt = new Date(now).toISOString();
    a.pauseKind = null;
    a.runningSince = now;
    this.recordInterruption(session.id, 'resume', null, null, now);
    this.persist(a, now);
    this.emit('activeSessionChanged', this.buildDto(a));
    if (wasIdle) this.emit('notice', { kind: 'idle-resumed', session: { ...session } });
  }

  // ── Ending ───────────────────────────────────────────────────────────────

  /**
   * Ask to end the session. Returns what the user must do to confirm; the
   * session keeps running until `confirmEnd` is called with this challenge.
   */
  requestEnd(): Promise<EndFocusChallenge | null> {
    return this.enqueue(() => {
      const a = this.active;
      if (!a) return null;
      const now = this.now();
      const remainingMs = this.remainingMs(a.session, now);
      const early = remainingMs !== null && remainingMs > 0;
      const challenge: PendingChallenge = {
        token: randomBytes(16).toString('hex'),
        sessionId: a.session.id,
        early,
        // Breaking a countdown commitment takes a typed phrase; a stopwatch
        // has no planned end, so finishing it only needs the confirmation.
        requiresPhrase: early,
        phrase: END_PHRASE,
        remainingMs,
        expiresAt: new Date(now + this.endChallengeTtlMs).toISOString(),
        expiresAtMs: now + this.endChallengeTtlMs,
      };
      this.challenge = challenge;
      const { expiresAtMs: _expiresAtMs, ...publicChallenge } = challenge;
      return publicChallenge;
    });
  }

  confirmEnd(request: ConfirmEndRequest): Promise<FocusSession> {
    return this.enqueue(async () => {
      const a = this.active;
      if (!a) throw new FocusError('no-session', 'There is no Focus session to end.');
      const challenge = this.challenge;
      const now = this.now();
      if (
        !challenge ||
        typeof request?.token !== 'string' ||
        request.token !== challenge.token ||
        challenge.sessionId !== a.session.id ||
        now > challenge.expiresAtMs
      ) {
        this.challenge = null;
        throw new FocusError('end-not-confirmed', 'Ending Focus was not confirmed. Try again.');
      }
      if (challenge.requiresPhrase) {
        const typed = typeof request.phrase === 'string' ? request.phrase.trim().toUpperCase() : '';
        if (typed !== challenge.phrase) {
          throw new FocusError('end-not-confirmed', `Type ${challenge.phrase} to end this Focus session.`);
        }
      }

      const plannedEnd = this.plannedEndMs(a.session);
      if (plannedEnd !== null && now >= plannedEnd) {
        // The commitment ran out while the dialog was open: that is a completion.
        return this.finish(a, 'completed', 'completed', plannedEnd, null);
      }
      if (a.session.mode === 'countdown') {
        const note = typeof request.reason === 'string' ? request.reason.trim().slice(0, MAX_REASON_LENGTH) || null : null;
        return this.finish(a, 'cancelled', 'ended-early', now, note);
      }
      return this.finish(a, 'completed', 'finished', now, null);
    });
  }

  private async completeExpired(sessionId: string): Promise<void> {
    const a = this.active;
    if (!a || a.session.id !== sessionId) return;
    const plannedEnd = this.plannedEndMs(a.session);
    if (plannedEnd === null || this.now() < plannedEnd) return;
    await this.finish(a, 'completed', 'completed', plannedEnd, null);
  }

  /** The only place a session becomes terminal. Must run on the queue. */
  private async finish(
    a: InternalState,
    state: Extract<FocusSessionState, 'completed' | 'cancelled'>,
    endReason: FocusEndReason,
    endedAtMs: number,
    note: string | null,
  ): Promise<FocusSession> {
    const { session, profile, leaseId } = a;
    clearInterval(a.timer);
    this.challenge = null;

    const now = this.now();
    this.closeSession(session, state, endReason, endedAtMs, note, now);
    this.repo.updateSession(session);
    this.active = null;

    const ended = { ...session };
    this.emit('activeSessionChanged', null);
    this.emit('summary', ended, profile);

    if (leaseId) {
      try {
        await this.blockingManager.stop(leaseId, session.id);
      } catch (err) {
        // The session is over either way. Leftover blocking is surfaced to
        // the user through `hasBlockingResidue`, and the enforcement side
        // releases an un-heartbeated lease by itself.
        this.log(`failed to release blocking for session ${session.id}: ${(err as Error)?.message ?? err}`);
      }
    }
    return ended;
  }

  private closeSession(
    session: FocusSession,
    state: Extract<FocusSessionState, 'completed' | 'cancelled'>,
    endReason: FocusEndReason,
    endedAtMs: number,
    note: string | null,
    nowMs: number,
  ): void {
    if (session.state === 'active') {
      session.elapsedMs = this.activeWorkMs(session, endedAtMs);
    } else if (session.state === 'paused' && session.pausedAt) {
      session.totalPauseMs += Math.max(0, endedAtMs - new Date(session.pausedAt).getTime());
    }
    session.state = state;
    session.endReason = endReason;
    session.endNote = note;
    session.endedAt = new Date(endedAtMs).toISOString();
    session.pausedAt = null;
    session.blockingLeaseId = null;
    session.updatedAt = new Date(nowMs).toISOString();
  }

  // ── Timer ────────────────────────────────────────────────────────────────

  private tick(): void {
    const a = this.active;
    if (!a) return;
    const now = this.now();

    // Sleep, hibernation or a frozen process: the time we did not observe is
    // not active work.
    if (now - a.lastTickAt > this.sleepGapMs) this.accountForGap(a, a.lastTickAt, now, 'sleep');
    a.lastTickAt = now;

    const plannedEnd = this.plannedEndMs(a.session);
    if (plannedEnd !== null && now >= plannedEnd) {
      void this.enqueue(() => this.completeExpired(a.session.id)).catch((err) =>
        this.log(`failed to complete expired session: ${(err as Error)?.message ?? err}`),
      );
      return;
    }

    this.checkIdle(a, now);

    if (now - a.lastPersistAt >= this.persistMs) {
      if (a.session.state === 'active') a.session.elapsedMs = this.activeWorkMs(a.session, now);
      a.session.updatedAt = new Date(now).toISOString();
      this.persist(a, now);
    }

    // The lease is heartbeated while paused too: a paused session is still
    // a committed session and keeps its blocking.
    if (now - a.lastLeaseBeatAt >= this.leaseHeartbeatMs) this.beatLease(a, now);

    this.emit('tick', this.buildDto(a));
  }

  private accountForGap(a: InternalState, fromMs: number, toMs: number, reason: string): void {
    const { session } = a;
    if (session.state !== 'active') return;
    const gap = toMs - fromMs;
    if (gap <= 0) return;
    session.totalPauseMs += gap;
    a.runningSince = toMs;
    this.recordInterruption(session.id, 'idle', reason, gap, fromMs);
  }

  private checkIdle(a: InternalState, now: number): void {
    const idleSeconds = this.getIdleSeconds();
    if (idleSeconds === null || !Number.isFinite(idleSeconds)) return;
    const prefs = this.preferences;
    if (a.session.state === 'active') {
      if (prefs.idleAutoPause && idleSeconds >= prefs.idleThresholdSeconds) {
        // The work stopped when the input stopped, not when we noticed.
        this.pauseNow(a, 'idle', { at: now - idleSeconds * 1000, idleMs: idleSeconds * 1000 });
      }
    } else if (a.session.state === 'paused' && a.pauseKind === 'idle') {
      // Only an idle pause resumes on its own. A manual pause waits for the user.
      if (prefs.idleAutoResume && idleSeconds < IDLE_RETURN_SECONDS) this.resumeNow(a);
    }
  }

  /** Called when the machine wakes from sleep: reconcile immediately. */
  handleSystemResume(): void {
    this.tick();
    const a = this.active;
    if (a) this.beatLease(a, this.now());
  }

  // ── Blocking lease ───────────────────────────────────────────────────────

  private beatLease(a: InternalState, now: number): void {
    if (!a.leaseId || a.blockingStatus !== 'active' || a.heartbeatInFlight) return;
    a.lastLeaseBeatAt = now;
    a.heartbeatInFlight = true;
    const leaseId = a.leaseId;
    this.blockingManager
      .heartbeat(leaseId, a.session.id)
      .catch((err) => {
        if (this.active !== a || a.leaseId !== leaseId || a.blockingStatus !== 'active') return;
        this.log(`blocking lease lost: ${(err as Error)?.message ?? err}`);
        a.leaseId = null;
        a.blockingStatus = 'recovering';
        a.blockingMessage = 'Restoring blocking…';
        this.emit('activeSessionChanged', this.buildDto(a));
        // One automatic attempt. If it fails the UI says so and offers a retry.
        void this.enqueue(() => this.reacquire(a));
      })
      .finally(() => {
        a.heartbeatInFlight = false;
      });
  }

  private async reacquire(a: InternalState): Promise<void> {
    if (this.active !== a || a.blockingStatus === 'active') return;
    const wasRestoring = a.blockingStatus === 'recovering';
    try {
      const leaseId = await this.blockingManager.start(a.config, a.session.id);
      if (this.active !== a) {
        await this.blockingManager.stop(leaseId, a.session.id).catch(() => {});
        return;
      }
      a.leaseId = leaseId;
      a.blockingStatus = 'active';
      a.blockingMessage = null;
      a.lastLeaseBeatAt = this.now();
      a.session.blockingLeaseId = leaseId;
      this.persist(a, this.now());
      this.emit('activeSessionChanged', this.buildDto(a));
      if (!wasRestoring) this.emit('notice', { kind: 'blocking-restored', session: { ...a.session } });
    } catch (err) {
      if (this.active !== a) return;
      const message = (err as Error)?.message ?? 'Blocking could not be restored.';
      a.leaseId = null;
      a.blockingStatus = 'degraded';
      a.blockingMessage = message;
      a.session.blockingLeaseId = null;
      this.persist(a, this.now());
      this.emit('activeSessionChanged', this.buildDto(a));
      this.emit('notice', { kind: 'blocking-lost', session: { ...a.session }, message });
    }
  }

  /** User-initiated retry after blocking was lost. */
  restoreBlocking(): Promise<ActiveFocusSessionDto | null> {
    return this.enqueue(async () => {
      const a = this.active;
      if (!a) return null;
      if (a.blockingStatus === 'degraded' || a.blockingStatus === 'recovering') {
        a.blockingStatus = 'degraded';
        await this.reacquire(a);
      }
      return this.active === a ? this.buildDto(a) : null;
    });
  }

  hasBlockingResidue(): boolean {
    if (this.active) return false;
    try {
      return this.blockingManager.hasResidue();
    } catch {
      return false;
    }
  }

  clearBlockingResidue(): Promise<void> {
    return this.enqueue(async () => {
      // Never while a session owns the blocking state.
      if (this.active) return;
      await this.blockingManager.clearResidue();
    });
  }

  // ── Blocked attempts ─────────────────────────────────────────────────────

  /**
   * The tracker reports the domain of the foreground browser tab. If Focus is
   * blocking it, that is an attempt (the page itself fails to load — this
   * only records it).
   */
  observeDomain(domain: string | null | undefined): void {
    const a = this.active;
    if (!a || !domain || a.blockingStatus !== 'active' || a.config.domains.length === 0) return;
    if (!isDomainBlocked(domain, a.config.domains)) return;
    this.handleBlockedAttempt({ type: 'website', target: domain.trim().toLowerCase(), sessionId: a.session.id });
  }

  private handleBlockedAttempt = (attempt: BlockedAttemptEvent): void => {
    const a = this.active;
    if (!a || attempt.sessionId !== a.session.id) return;
    const now = this.now();
    const key = `${attempt.type}:${attempt.target}`;
    const last = a.recentAttempts.get(key);
    if (last !== undefined && now - last < ATTEMPT_DEDUPE_MS) return;
    a.recentAttempts.set(key, now);

    const at = new Date(now).toISOString();
    const blocked: BlockedAttempt = {
      id: randomUUID(),
      sessionId: a.session.id,
      type: attempt.type,
      target: attempt.target,
      attemptedAt: at,
      createdAt: at,
    };
    try {
      this.repo.insertBlockedAttempt(blocked);
    } catch (err) {
      this.log(`failed to record blocked attempt: ${(err as Error)?.message ?? err}`);
    }
    this.emit('notice', { kind: 'blocked', session: { ...a.session }, type: attempt.type, target: attempt.target });
  };

  // ── Startup recovery ─────────────────────────────────────────────────────

  /**
   * Called on app startup. Deterministic policy for a session left open by a
   * crash, a quit or a reboot:
   *
   *   - never started (`planned`)                        → removed
   *   - countdown, commitment still running              → restored, blocking re-acquired
   *   - countdown, commitment ended while we were away:
   *       seen alive within `resumeWindowMs` of its end  → completed at the planned end
   *       otherwise                                      → abandoned at last-seen
   *   - stopwatch, seen within `resumeWindowMs`          → restored, blocking re-acquired
   *   - stopwatch, older                                 → abandoned at last-seen
   *
   * Time the app was away is never counted as active work.
   */
  reconcileActiveSession(): Promise<void> {
    return this.enqueue(async () => {
      if (this.active) return;
      const now = this.now();

      let candidate: FocusSession | null = null;
      for (const session of this.repo.getOpenSessions()) {
        if (session.state === 'planned' || !session.startedAt) {
          this.repo.deleteSession(session.id);
        } else if (!candidate) {
          candidate = session;
        } else {
          // There can only be one live session; older strays are closed.
          this.closeStale(session, 'cancelled', 'abandoned', new Date(session.updatedAt).getTime(), now);
        }
      }
      if (!candidate) return;

      const lastSeen = Math.min(now, new Date(candidate.updatedAt).getTime());
      const found = this.repo.getProfileById(candidate.profileId);
      if (!found) {
        this.closeStale(candidate, 'cancelled', 'abandoned', lastSeen, now);
        return;
      }
      const profile = structuredClone(found);

      // A countdown is worth resuming for as long as it had left when last
      // seen; after that the user has clearly moved on.
      const remainingAtLastSeen = this.remainingMs(candidate, lastSeen);
      if (remainingAtLastSeen !== null) {
        const deadline = lastSeen + remainingAtLastSeen;
        if (now >= deadline) {
          if (candidate.state === 'active' && remainingAtLastSeen <= this.resumeWindowMs) {
            this.closeStale(candidate, 'completed', 'completed', deadline, now);
          } else {
            this.closeStale(candidate, 'cancelled', 'abandoned', lastSeen, now);
          }
          return;
        }
      } else if (now - lastSeen > this.resumeWindowMs) {
        this.closeStale(candidate, 'cancelled', 'abandoned', lastSeen, now);
        return;
      }

      const config = candidate.blockingConfig ?? compileBlockingConfig(profile);
      candidate.blockingConfig = config;
      candidate.blockingLeaseId = null;
      const a = this.activate(candidate, profile, config, now);
      if (candidate.state === 'paused') {
        a.pauseKind = this.lastPauseKind(candidate.id);
      } else if (now - lastSeen > this.sleepGapMs) {
        this.accountForGap(a, lastSeen, now, 'app-closed');
      }
      candidate.updatedAt = new Date(now).toISOString();

      if (!config.enabled) {
        a.blockingStatus = 'off';
      } else if (this.blockingManager.enforcement === 'none') {
        a.blockingStatus = 'unavailable';
        a.blockingMessage = 'Blocking is not available on this system.';
      } else {
        a.blockingStatus = 'recovering';
        a.blockingMessage = 'Restoring blocking…';
      }
      this.persist(a, now);
      this.emit('activeSessionChanged', this.buildDto(a));
      if (a.blockingStatus === 'recovering') await this.reacquire(a);
    });
  }

  private closeStale(
    session: FocusSession,
    state: Extract<FocusSessionState, 'completed' | 'cancelled'>,
    endReason: FocusEndReason,
    endedAtMs: number,
    nowMs: number,
  ): void {
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : endedAtMs;
    this.closeSession(session, state, endReason, Math.max(startedAt, endedAtMs), null, nowMs);
    this.repo.updateSession(session);
  }

  private lastPauseKind(sessionId: string): 'manual' | 'idle' {
    const interruptions = this.repo.getInterruptions(sessionId);
    for (let i = interruptions.length - 1; i >= 0; i -= 1) {
      const type = interruptions[i].type;
      if (type === 'idle') return 'idle';
      if (type === 'pause' || type === 'user') return 'manual';
    }
    return 'manual';
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  /**
   * App is quitting. The session is NOT ended — it stays open in the database
   * and startup reconciliation decides what to do with it. Blocking is
   * released so that a machine that is shutting down is never left blocked.
   */
  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      this.blockingManager.offBlockedAttempt(this.handleBlockedAttempt);
      const a = this.active;
      if (a) {
        clearInterval(a.timer);
        const now = this.now();
        if (a.session.state === 'active') a.session.elapsedMs = this.activeWorkMs(a.session, now);
        a.session.updatedAt = new Date(now).toISOString();
        try {
          this.repo.updateSession(a.session);
        } catch (err) {
          this.log(`failed to persist session on shutdown: ${(err as Error)?.message ?? err}`);
        }
        this.active = null;
        this.challenge = null;
        if (a.leaseId) await this.blockingManager.stop(a.leaseId, a.session.id).catch(() => {});
      }
      await this.blockingManager.dispose().catch(() => {});
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private persist(a: InternalState, now: number): void {
    a.lastPersistAt = now;
    try {
      this.repo.updateSession(a.session);
    } catch (err) {
      this.log(`failed to persist focus session: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Active work time at `at`: wall time since start minus everything paused. */
  private activeWorkMs(session: FocusSession, at: number): number {
    if (session.state !== 'active') return session.elapsedMs;
    if (!session.startedAt) return 0;
    return Math.max(0, at - new Date(session.startedAt).getTime() - session.totalPauseMs);
  }

  /**
   * When a running countdown will end if it is not paused again: start +
   * planned duration + everything paused so far. Null for a stopwatch and
   * while paused (a paused countdown has no end until it is resumed).
   */
  private plannedEndMs(session: FocusSession): number | null {
    if (session.mode !== 'countdown' || session.plannedDurationMinutes === null || !session.startedAt) return null;
    if (session.state !== 'active') return null;
    return new Date(session.startedAt).getTime() + session.plannedDurationMinutes * 60_000 + session.totalPauseMs;
  }

  /** Planned duration minus active work so far; frozen while paused. */
  private remainingMs(session: FocusSession, now: number): number | null {
    if (session.mode !== 'countdown' || session.plannedDurationMinutes === null) return null;
    return Math.max(0, session.plannedDurationMinutes * 60_000 - this.activeWorkMs(session, now));
  }

  private buildDto(a: InternalState): ActiveFocusSessionDto {
    const now = this.now();
    const { session } = a;
    const plannedEnd = this.plannedEndMs(session);
    return {
      session: { ...session },
      profile: a.profile,
      liveElapsedMs: this.activeWorkMs(session, now),
      isRunning: session.state === 'active',
      remainingMs: this.remainingMs(session, now),
      plannedEndsAt: plannedEnd === null ? null : new Date(plannedEnd).toISOString(),
      pauseKind: session.state === 'paused' ? a.pauseKind ?? 'manual' : null,
      blocking: {
        status: a.blockingStatus,
        ruleCount: countBlockRules(a.config),
        message: a.blockingMessage,
      },
    };
  }

  private recordInterruption(
    sessionId: string,
    type: FocusInterruption['type'],
    reason: string | null,
    idleMs: number | null,
    atMs: number,
  ): void {
    const interruption: FocusInterruption = {
      id: randomUUID(),
      sessionId,
      type,
      reason,
      occurredAt: new Date(atMs).toISOString(),
      idleMs: idleMs === null ? null : Math.round(idleMs),
      createdAt: new Date(this.now()).toISOString(),
    };
    try {
      this.repo.insertInterruption(interruption);
    } catch (err) {
      this.log(`failed to record interruption: ${(err as Error)?.message ?? err}`);
    }
  }
}
