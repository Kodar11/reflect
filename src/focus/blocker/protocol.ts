/**
 * Wire protocol between the Reflect app and its elevated blocker helper.
 *
 * Transport: one named-pipe connection, newline-delimited JSON. The
 * unprivileged app owns the pipe (it is the server); the helper connects to
 * it and proves it is the process the app launched by echoing `token`.
 *
 * The helper is deliberately narrow: it can only sink a validated list of
 * hostnames in the hosts file and terminate a validated list of process
 * names, and only while a lease is alive. It never takes a file path, an IP
 * address or a command line from the pipe.
 */

export const PIPE_PREFIX = '\\\\.\\pipe\\reflect-focus-';
export const HELPER_FLAG = '--focus-blocker';

export const MIN_LEASE_TTL_MS = 10_000;
export const MAX_LEASE_TTL_MS = 10 * 60_000;

export type BlockerCommand =
  | { id: number; cmd: 'start'; leaseId: string; sessionId: string; domains: string[]; apps: string[]; ttlMs: number }
  | { id: number; cmd: 'heartbeat'; leaseId: string }
  | { id: number; cmd: 'stop'; leaseId: string }
  /** Release any lease and remove every leftover Reflect entry. */
  | { id: number; cmd: 'cleanup' }
  | { id: number; cmd: 'ping' }
  /** Release everything and exit. */
  | { id: number; cmd: 'shutdown' };

export type BlockerErrorCode =
  | 'invalid-request'
  | 'unknown-lease'
  | 'hosts-permission'
  | 'hosts-unreadable'
  | 'hosts-io'
  | 'internal';

export type BlockerReply =
  | { id: number; ok: true }
  | { id: number; ok: false; code: BlockerErrorCode; error: string };

export type BlockerEvent =
  | { event: 'hello'; token: string; pid: number }
  | { event: 'blocked'; leaseId: string; sessionId: string; type: 'app'; target: string }
  | { event: 'lease-expired'; leaseId: string };

export type HelperMessage = BlockerReply | BlockerEvent;

export function encodeMessage(message: BlockerCommand | HelperMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a byte stream into parsed JSON lines; malformed lines are dropped. */
export class LineDecoder {
  private buffer = '';

  constructor(private readonly maxLineLength = 1024 * 1024) {}

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Not ours; ignore.
      }
    }
    // A peer that never sends a newline must not grow the buffer forever.
    if (this.buffer.length > this.maxLineLength) this.buffer = '';
    return out;
  }
}

export class BlockerError extends Error {
  constructor(
    readonly code: BlockerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlockerError';
  }
}
