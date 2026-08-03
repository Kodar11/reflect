import type { FocusProfile, FocusProfileRule } from './FocusModels.js';

export type BlockingLeaseId = string;

/**
 * Abstraction over the external Windows Service that controls distraction
 * blocking. The real implementation will call the service via named pipes or a
 * local HTTP loopback; the stub logs and records commands so the app can still
 * be tested and developed without the service installed.
 */
export interface IBlockingManager {
  /**
   * Start a blocking lease with the given profile rules.
   * Returns a lease id that can be used to extend/release it.
   */
  start(profile: FocusProfile, sessionId: string): Promise<BlockingLeaseId>;

  /** Extend the lease. The service may release the lease if this is missed. */
  heartbeat(leaseId: BlockingLeaseId, sessionId: string): Promise<void>;

  /** Stop blocking and release the lease. */
  stop(leaseId: BlockingLeaseId, sessionId: string): Promise<void>;

  /** Record an attempt that was blocked by the service. */
  onBlockedAttempt(callback: (attempt: { type: FocusProfileRule['type']; target: string; sessionId: string }) => void): void;
  offBlockedAttempt(callback: (attempt: { type: FocusProfileRule['type']; target: string; sessionId: string }) => void): void;
}

/**
 * Stub blocking manager that does not actually block anything. It still issues
 * lease ids and logs commands so the FocusService can be developed without the
 * external Windows Service.
 */
export class StubBlockingManager implements IBlockingManager {
  private nextLeaseId = 1;
  private readonly callbacks: Array<(attempt: { type: FocusProfileRule['type']; target: string; sessionId: string }) => void> = [];

  async start(profile: FocusProfile, sessionId: string): Promise<BlockingLeaseId> {
    const leaseId = `stub-lease-${this.nextLeaseId++}`;
    console.log(`[StubBlockingManager] start lease ${leaseId} for session ${sessionId} with profile ${profile.name} (${profile.rules.length} rules)`);
    return leaseId;
  }

  async heartbeat(leaseId: BlockingLeaseId, sessionId: string): Promise<void> {
    console.log(`[StubBlockingManager] heartbeat lease ${leaseId} for session ${sessionId}`);
  }

  async stop(leaseId: BlockingLeaseId, sessionId: string): Promise<void> {
    console.log(`[StubBlockingManager] stop lease ${leaseId} for session ${sessionId}`);
  }

  onBlockedAttempt(callback: (attempt: { type: FocusProfileRule['type']; target: string; sessionId: string }) => void): void {
    this.callbacks.push(callback);
  }

  offBlockedAttempt(callback: (attempt: { type: FocusProfileRule['type']; target: string; sessionId: string }) => void): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx !== -1) this.callbacks.splice(idx, 1);
  }
}
