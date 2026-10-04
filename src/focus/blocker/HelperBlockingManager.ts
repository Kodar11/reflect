import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BlockingError,
  type BlockedAttemptCallback,
  type BlockingLeaseId,
  type IBlockingManager,
} from '../BlockingManager.js';
import type { EffectiveBlockingConfig } from '../FocusModels.js';
import { getHostsFilePath, hostsFileHasReflectEntriesSync } from './HostsFile.js';
import {
  LineDecoder,
  PIPE_PREFIX,
  encodeMessage,
  type BlockerCommand,
  type BlockerErrorCode,
  type HelperMessage,
} from './protocol.js';

/**
 * Starts the elevated helper so that it connects back to `pipePath` with
 * `token`. Resolves once the process was started; rejects with a
 * `BlockingError('elevation-declined')` if the user refused elevation.
 */
export type HelperLauncher = (params: { pipePath: string; token: string }) => Promise<void>;

export interface HelperBlockingManagerOptions {
  launch: HelperLauncher;
  hostsPath?: string;
  /** How long the helper keeps a lease without a heartbeat. */
  leaseTtlMs?: number;
  /** How long to wait for the launched helper to connect. */
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

type CommandBody = BlockerCommand extends infer C ? (C extends { id: number } ? Omit<C, 'id'> : never) : never;

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The app side of real enforcement: owns a named pipe, launches the elevated
 * helper on demand (one UAC prompt per app run) and drives it with leases.
 * The renderer never talks to this — only `FocusService` does.
 */
export class HelperBlockingManager implements IBlockingManager {
  readonly enforcement = 'real' as const;

  private readonly hostsPath: string;
  private readonly leaseTtlMs: number;
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly log: (message: string) => void;

  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly callbacks = new Set<BlockedAttemptCallback>();
  private disposed = false;

  constructor(private readonly options: HelperBlockingManagerOptions) {
    this.hostsPath = options.hostsPath ?? getHostsFilePath();
    this.leaseTtlMs = options.leaseTtlMs ?? 45_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 20_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.log = options.log ?? (() => {});
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async start(config: EffectiveBlockingConfig, sessionId: string): Promise<BlockingLeaseId> {
    const leaseId = randomUUID();
    await this.ensureHelper();
    await this.request({ cmd: 'start', leaseId, sessionId, domains: config.domains, apps: config.apps, ttlMs: this.leaseTtlMs });
    return leaseId;
  }

  async heartbeat(leaseId: BlockingLeaseId): Promise<void> {
    if (!this.connected) throw new BlockingError('disconnected', 'The blocker is not running.');
    await this.request({ cmd: 'heartbeat', leaseId });
  }

  async stop(leaseId: BlockingLeaseId): Promise<void> {
    if (this.connected) {
      try {
        await this.request({ cmd: 'stop', leaseId });
        return;
      } catch (err) {
        // A lease the helper no longer holds is already released.
        if (err instanceof BlockingError && err.code === 'lease-lost') return;
        if (this.connected) throw err;
      }
    }
    // No helper. A helper that lost us releases on its own when the lease
    // TTL runs out; only step in if entries are still on disk.
    if (this.hasResidue()) await this.clearResidue();
  }

  hasResidue(): boolean {
    return hostsFileHasReflectEntriesSync(this.hostsPath);
  }

  async clearResidue(): Promise<void> {
    await this.ensureHelper();
    await this.request({ cmd: 'cleanup' });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.connected) {
      await this.request({ cmd: 'shutdown' }, 5000).catch(() => {});
    }
    this.socket?.destroy();
    this.socket = null;
  }

  onBlockedAttempt(callback: BlockedAttemptCallback): void {
    this.callbacks.add(callback);
  }

  offBlockedAttempt(callback: BlockedAttemptCallback): void {
    this.callbacks.delete(callback);
  }

  private ensureHelper(): Promise<void> {
    if (this.disposed) return Promise.reject(new BlockingError('helper-unavailable', 'Blocking is shutting down.'));
    if (this.connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const pipePath = `${PIPE_PREFIX}${randomUUID()}`;
    const token = randomBytes(32).toString('hex');
    const server = net.createServer();

    // The clock for "did the helper connect" only starts once it has been
    // launched — answering the UAC prompt can take as long as the user needs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let startHelloTimer: () => void = () => {};
    const accepted = new Promise<net.Socket>((resolve, reject) => {
      startHelloTimer = () => {
        timer = setTimeout(
          () => reject(new BlockingError('helper-unavailable', 'The blocker did not start in time.')),
          this.helloTimeoutMs,
        );
      };
      server.on('connection', (candidate) => {
        const decoder = new LineDecoder(64 * 1024);
        const onData = (chunk: Buffer) => {
          const [first] = decoder.push(chunk) as HelperMessage[];
          if (!first) return;
          candidate.off('data', onData);
          if ('event' in first && first.event === 'hello' && tokensMatch(first.token, token)) {
            clearTimeout(timer);
            resolve(candidate);
          } else {
            // Something else found the pipe. It gets nothing.
            candidate.destroy();
          }
        };
        candidate.on('data', onData);
        candidate.on('error', () => candidate.destroy());
      });
      server.on('error', (err) => {
        clearTimeout(timer);
        reject(new BlockingError('helper-unavailable', `Could not open the blocker channel: ${err.message}`));
      });
    });
    // Attach a handler now so an early rejection is never "unhandled".
    accepted.catch(() => {});

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => resolve());
      });
      await this.options.launch({ pipePath, token });
      startHelloTimer();
      const socket = await accepted;
      this.adopt(socket);
      this.log('blocker helper connected');
    } catch (err) {
      if (err instanceof BlockingError) throw err;
      throw new BlockingError('helper-unavailable', (err as Error)?.message ?? String(err));
    } finally {
      clearTimeout(timer);
      // One helper per channel: stop accepting once it is in (or failed).
      server.close();
    }
  }

  private adopt(socket: net.Socket): void {
    const decoder = new LineDecoder();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) this.onMessage(raw as HelperMessage);
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new BlockingError('disconnected', 'The blocker stopped responding.'));
        this.pending.delete(id);
      }
      this.log('blocker helper disconnected');
    });
  }

  private onMessage(message: HelperMessage): void {
    if (!message || typeof message !== 'object') return;
    if ('event' in message) {
      if (message.event === 'blocked') {
        for (const cb of this.callbacks) cb({ type: message.type, target: message.target, sessionId: message.sessionId });
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve();
    else entry.reject(new BlockingError(mapErrorCode(message.code), describeError(message.code, message.error)));
  }

  private request(body: CommandBody, timeoutMs = this.requestTimeoutMs): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new BlockingError('disconnected', 'The blocker is not running.'));
    }
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BlockingError('timeout', 'The blocker did not respond.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeMessage({ ...body, id } as BlockerCommand));
    });
  }
}

function tokensMatch(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function mapErrorCode(code: BlockerErrorCode): BlockingError['code'] {
  return code === 'unknown-lease' ? 'lease-lost' : 'rejected';
}

function describeError(code: BlockerErrorCode, fallback: string): string {
  switch (code) {
    case 'hosts-permission':
      return 'Reflect could not change the hosts file. Another program (often antivirus) may be protecting it.';
    case 'hosts-unreadable':
      return 'The hosts file is in a format Reflect will not modify.';
    case 'unknown-lease':
      return 'Blocking was released.';
    default:
      return fallback || 'The blocker rejected the request.';
  }
}
