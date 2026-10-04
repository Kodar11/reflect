import type { EffectiveBlockingConfig, FocusProfileRule } from './FocusModels.js';

export type BlockingLeaseId = string;

export interface BlockedAttemptEvent {
  type: FocusProfileRule['type'];
  target: string;
  sessionId: string;
}

export type BlockedAttemptCallback = (attempt: BlockedAttemptEvent) => void;

export type BlockingFailureCode =
  | 'elevation-declined'
  | 'helper-unavailable'
  | 'disconnected'
  | 'timeout'
  | 'lease-lost'
  | 'rejected';

/** A blocking failure the user can be told about in plain language. */
export class BlockingError extends Error {
  constructor(
    readonly code: BlockingFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlockingError';
  }
}

/**
 * Abstraction over the privileged enforcement layer. A lease means: "this
 * Focus session currently owns this blocking state". The enforcement side
 * releases a lease on its own if it is not heartbeated, so an orphaned
 * session can never block the machine permanently.
 */
export interface IBlockingManager {
  /** 'none' when this manager cannot enforce anything on this platform. */
  readonly enforcement: 'real' | 'none';

  /**
   * Start enforcing `config` for a session. Resolves only once enforcement
   * is confirmed; rejects with a `BlockingError` otherwise.
   */
  start(config: EffectiveBlockingConfig, sessionId: string): Promise<BlockingLeaseId>;

  /** Extend the lease. Rejects if the lease is no longer held. */
  heartbeat(leaseId: BlockingLeaseId, sessionId: string): Promise<void>;

  /** Stop blocking and restore the machine. */
  stop(leaseId: BlockingLeaseId, sessionId: string): Promise<void>;

  /** True if blocking from an earlier session is still in place on disk. */
  hasResidue(): boolean;

  /** Remove leftover blocking when no session owns it. */
  clearResidue(): Promise<void>;

  /** Release everything this manager holds (app shutdown). */
  dispose(): Promise<void>;

  /** Subscribe to attempts the enforcement layer stopped. */
  onBlockedAttempt(callback: BlockedAttemptCallback): void;
  offBlockedAttempt(callback: BlockedAttemptCallback): void;
}

/**
 * Blocking manager for platforms without an enforcement implementation. It
 * enforces nothing and says so (`enforcement: 'none'`), so the UI reports
 * blocking as unavailable instead of pretending.
 */
export class NoopBlockingManager implements IBlockingManager {
  readonly enforcement = 'none' as const;

  async start(): Promise<BlockingLeaseId> {
    throw new BlockingError('helper-unavailable', 'Blocking is not available on this platform.');
  }

  async heartbeat(): Promise<void> {}

  async stop(): Promise<void> {}

  hasResidue(): boolean {
    return false;
  }

  async clearResidue(): Promise<void> {}

  async dispose(): Promise<void> {}

  onBlockedAttempt(): void {}

  offBlockedAttempt(): void {}
}
