import { randomUUID } from 'node:crypto';
import type {
  ActiveFocusSessionDto,
  BlockedAttempt,
  FocusInterruption,
  FocusProfile,
  FocusProfileRule,
  FocusSession,
  FocusSessionState,
  StartFocusRequest,
} from './FocusModels.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { IBlockingManager, BlockingLeaseId } from './BlockingManager.js';

export type FocusServiceEvents = {
  activeSessionChanged: (dto: ActiveFocusSessionDto | null) => void;
  summary: (session: FocusSession, profile: FocusProfile) => void;
};

export interface IFocusService {
  on<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void;
  off<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void;

  listProfiles(): FocusProfile[];
  getActiveSession(): ActiveFocusSessionDto | null;
  reconcileActiveSession(): Promise<void>;
  start(request: StartFocusRequest): Promise<ActiveFocusSessionDto>;
  pause(reason?: string | null): ActiveFocusSessionDto | null;
  resume(): ActiveFocusSessionDto | null;
  stop(state: Extract<FocusSessionState, 'completed' | 'cancelled'>): FocusSession | null;
  recordActivity(): void;
}

interface InternalState {
  session: FocusSession;
  profile: FocusProfile;
  leaseId: BlockingLeaseId;
  timer: ReturnType<typeof setInterval>;
}

type ListenerSet = {
  activeSessionChanged: Set<(dto: ActiveFocusSessionDto | null) => void>;
  summary: Set<(session: FocusSession, profile: FocusProfile) => void>;
};

export class FocusService implements IFocusService {
  private active: InternalState | null = null;
  private readonly listeners: ListenerSet = {
    activeSessionChanged: new Set(),
    summary: new Set(),
  };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInterruptionType: FocusInterruption['type'] | null = null;

  constructor(
    private readonly repo: IFocusRepository,
    private readonly blockingManager: IBlockingManager,
    private readonly now: () => number = () => Date.now(),
    private readonly reconcileThresholdMs = 2 * 60 * 1000,
    private readonly idleThresholdMs = 2 * 60 * 1000,
  ) {
    this.blockingManager.onBlockedAttempt(this.handleBlockedAttempt);
  }

  destroy(): void {
    this.clearIdleTimer();
    this.blockingManager.offBlockedAttempt(this.handleBlockedAttempt);
    if (this.active) {
      this.stop('cancelled');
    }
  }

  /** Called on app startup to recover any active session left by a crash. */
  async reconcileActiveSession(): Promise<void> {
    if (this.active) return;
    const session = this.repo.getActiveSession();
    if (!session) return;

    const profile = this.repo.getProfileById(session.profileId);
    if (!profile) {
      await this.completePersistedSession(session, 'cancelled');
      return;
    }

    const now = this.now();
    const updatedAt = new Date(session.updatedAt).getTime();
    const age = now - updatedAt;

    if (age > this.reconcileThresholdMs) {
      // The session was abandoned (app crash, sleep, or force close). Close it
      // so the user does not return to a multi-hour stale session.
      await this.completePersistedSession(session, 'completed');
      return;
    }

    // Recent enough to rejoin. Restore the session and re-acquire a lease.
    if (session.state === 'active') {
      const leaseId = await this.blockingManager.start(profile, session.id);
      session.blockingLeaseId = leaseId;
      session.updatedAt = new Date(now).toISOString();
      this.repo.updateSession(session);
      const timer = setInterval(() => this.heartbeat(), 1000);
      this.active = { session, profile, leaseId, timer };
      this.resetIdleTimer();
      this.emit('activeSessionChanged', this.buildDto(session, profile));
    } else {
      // Paused session: restore state without a lease. User can resume manually.
      const timer = setInterval(() => this.heartbeat(), 1000);
      this.active = { session, profile, leaseId: session.blockingLeaseId ?? '', timer };
      this.emit('activeSessionChanged', this.buildDto(session, profile));
    }
  }

  private async completePersistedSession(session: FocusSession, state: Extract<FocusSessionState, 'completed' | 'cancelled'>): Promise<void> {
    const now = this.now();
    const profile = this.repo.getProfileById(session.profileId);
    if (session.state === 'active') {
      session.elapsedMs = this.computeElapsedMs(session, now);
    } else if (session.state === 'paused' && session.pausedAt) {
      session.totalPauseMs += Math.max(0, now - new Date(session.pausedAt).getTime());
    }
    session.state = state;
    session.endedAt = new Date(now).toISOString();
    session.pausedAt = null;
    session.updatedAt = new Date(now).toISOString();
    if (session.blockingLeaseId) {
      await this.blockingManager.stop(session.blockingLeaseId, session.id).catch(() => {});
    }
    this.repo.updateSession(session);
    if (profile) {
      this.emit('summary', session, profile);
    }
  }

  on<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void {
    (this.listeners[event] as Set<typeof listener>).add(listener);
  }

  off<K extends keyof FocusServiceEvents>(event: K, listener: FocusServiceEvents[K]): void {
    (this.listeners[event] as Set<typeof listener>).delete(listener);
  }

  private emit<K extends keyof FocusServiceEvents>(
    event: K,
    ...args: Parameters<FocusServiceEvents[K]>
  ): void {
    for (const listener of this.listeners[event] as Set<(...args: unknown[]) => void>) {
      listener(...args);
    }
  }

  listProfiles(): FocusProfile[] {
    return this.repo.getProfiles();
  }

  getActiveSession(): ActiveFocusSessionDto | null {
    if (!this.active) return null;
    const { session, profile } = this.active;
    return this.buildDto(session, profile);
  }

  async start(request: StartFocusRequest): Promise<ActiveFocusSessionDto> {
    if (this.active) {
      throw new Error('A focus session is already active');
    }

    const profile = this.repo.getProfileById(request.profileId);
    if (!profile) {
      throw new Error(`Focus profile not found: ${request.profileId}`);
    }

    const mode = request.mode ?? profile.mode;
    const plannedDurationMinutes = request.plannedDurationMinutes ??
      (mode === 'countdown' ? profile.defaultDurationMinutes : null);

    const now = new Date(this.now()).toISOString();
    const session: FocusSession = {
      id: randomUUID(),
      profileId: profile.id,
      task: request.task.trim(),
      notes: request.notes ?? null,
      mode,
      plannedDurationMinutes,
      state: 'active',
      startedAt: now,
      endedAt: null,
      pausedAt: null,
      totalPauseMs: 0,
      elapsedMs: 0,
      blockingLeaseId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.repo.insertSession(session);

    const leaseId = await this.blockingManager.start(profile, session.id);
    session.blockingLeaseId = leaseId;
    this.repo.updateSession(session);

    const timer = setInterval(() => this.heartbeat(), 1000);
    this.active = { session, profile, leaseId, timer };
    this.lastInterruptionType = null;
    this.resetIdleTimer();

    this.emit('activeSessionChanged', this.buildDto(session, profile));
    return this.buildDto(session, profile);
  }

  pause(reason: string | null = null): ActiveFocusSessionDto | null {
    if (!this.active) return null;
    const { session, profile } = this.active;
    if (session.state !== 'active') return this.buildDto(session, profile);

    const now = this.now();
    session.elapsedMs = this.computeElapsedMs(session, now);
    session.state = 'paused';
    session.pausedAt = new Date(now).toISOString();
    session.updatedAt = new Date(now).toISOString();

    const type: FocusInterruption['type'] = reason === 'idle' ? 'idle' : 'pause';
    this.lastInterruptionType = type;
    this.recordInterruption(session.id, type, reason);
    this.clearIdleTimer();
    this.repo.updateSession(session);
    this.emit('activeSessionChanged', this.buildDto(session, profile));
    return this.buildDto(session, profile);
  }

  resume(): ActiveFocusSessionDto | null {
    if (!this.active) return null;
    const { session, profile } = this.active;
    if (session.state !== 'paused') return this.buildDto(session, profile);

    const now = this.now();
    if (session.pausedAt) {
      const pauseMs = now - new Date(session.pausedAt).getTime();
      session.totalPauseMs += Math.max(0, pauseMs);
    }
    session.state = 'active';
    session.pausedAt = null;
    session.updatedAt = new Date(now).toISOString();

    this.recordInterruption(session.id, 'resume', null);
    this.lastInterruptionType = 'resume';
    this.resetIdleTimer();
    this.repo.updateSession(session);
    this.emit('activeSessionChanged', this.buildDto(session, profile));
    return this.buildDto(session, profile);
  }

  stop(state: Extract<FocusSessionState, 'completed' | 'cancelled'>): FocusSession | null {
    if (!this.active) return null;
    const { session, profile, leaseId, timer } = this.active;
    clearInterval(timer);
    this.clearIdleTimer();
    this.lastInterruptionType = null;

    const now = this.now();
    if (session.state === 'active') {
      session.elapsedMs = this.computeElapsedMs(session, now);
    } else if (session.state === 'paused' && session.pausedAt) {
      session.totalPauseMs += Math.max(0, now - new Date(session.pausedAt).getTime());
    }
    session.state = state;
    session.endedAt = new Date(now).toISOString();
    session.pausedAt = null;
    session.updatedAt = new Date(now).toISOString();

    this.blockingManager.stop(leaseId, session.id).catch((err) => {
      console.error('Failed to stop blocking manager lease:', err);
    });

    this.repo.updateSession(session);
    this.active = null;

    this.emit('activeSessionChanged', null);
    this.emit('summary', session, profile);
    return session;
  }

  private heartbeat(): void {
    if (!this.active) return;
    const { session, profile, leaseId } = this.active;
    if (session.state !== 'active') return;

    const now = this.now();
    session.elapsedMs = this.computeElapsedMs(session, now);
    session.updatedAt = new Date(now).toISOString();

    this.repo.updateSession(session);
    this.blockingManager.heartbeat(leaseId, session.id).catch((err) => {
      console.error('Failed to extend blocking manager lease:', err);
    });

    this.emit('activeSessionChanged', this.buildDto(session, profile));
  }

  private computeElapsedMs(session: FocusSession, now: number): number {
    if (!session.startedAt) return 0;
    return Math.max(0, now - new Date(session.startedAt).getTime() - session.totalPauseMs);
  }

  private buildDto(session: FocusSession, profile: FocusProfile): ActiveFocusSessionDto {
    const now = this.now();
    const isRunning = session.state === 'active';
    const elapsedMs = isRunning ? this.computeElapsedMs(session, now) : session.elapsedMs;
    let remainingMs: number | null = null;
    if (session.mode === 'countdown' && session.plannedDurationMinutes !== null) {
      remainingMs = Math.max(0, session.plannedDurationMinutes * 60_000 - elapsedMs);
    }
    return { session, profile, liveElapsedMs: elapsedMs, isRunning, remainingMs };
  }

  recordActivity(): void {
    if (!this.active) return;
    const { session, profile } = this.active;
    if (session.state === 'active') {
      this.resetIdleTimer();
      return;
    }
    // Auto-resume only when the user was paused automatically due to idle.
    if (session.state === 'paused' && this.lastInterruptionType === 'idle') {
      this.resume();
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.active || this.idleThresholdMs <= 0) return;
    if (this.active.session.state !== 'active') return;
    this.idleTimer = setTimeout(() => {
      this.pause('idle');
    }, this.idleThresholdMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private recordInterruption(sessionId: string, type: FocusInterruption['type'], reason: string | null): void {
    const now = new Date(this.now()).toISOString();
    const interruption: FocusInterruption = {
      id: randomUUID(),
      sessionId,
      type,
      reason,
      occurredAt: now,
      idleMs: null,
      createdAt: now,
    };
    this.repo.insertInterruption(interruption);
  }

  private handleBlockedAttempt = (attempt: {
    type: FocusProfileRule['type'];
    target: string;
    sessionId: string;
  }): void => {
    const now = new Date(this.now()).toISOString();
    const blocked: BlockedAttempt = {
      id: randomUUID(),
      sessionId: attempt.sessionId,
      type: attempt.type,
      target: attempt.target,
      attemptedAt: now,
      createdAt: now,
    };
    this.repo.insertBlockedAttempt(blocked);
  };
}
