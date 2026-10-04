import { execFile } from 'node:child_process';
import { isValidHostname, MAX_BLOCKED_APPS, MAX_BLOCKED_DOMAINS, PROTECTED_PROCESSES } from '../BlockingConfig.js';
import { HostsFileError, setBlockedHosts } from './HostsFile.js';
import { BlockerError, MAX_LEASE_TTL_MS, MIN_LEASE_TTL_MS, type BlockerEvent } from './protocol.js';

/**
 * The enforcement engine that runs inside the elevated helper.
 *
 * It holds at most one lease. While the lease is alive, every `tick()`:
 *   - re-asserts the blocked hostnames in the hosts file (so a manual edit
 *     during Focus does not stick), and
 *   - terminates any running process whose image name is blocked.
 *
 * A lease that is not heartbeated within its TTL is released by the engine
 * itself — an app that crashed can never leave the machine blocked.
 *
 * All system access goes through `BlockerDeps`, so the engine is fully
 * testable without privileges.
 */

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Windows session the process belongs to; null if unknown. */
  sessionId: number | null;
}

export interface BlockerDeps {
  /** Make Reflect's block in the hosts file equal `hosts`; true if it changed. */
  applyHosts(hosts: readonly string[]): Promise<boolean>;
  flushDns(): Promise<void>;
  listProcesses(): Promise<ProcessInfo[]>;
  killProcess(pid: number): Promise<boolean>;
  now(): number;
  ownPid: number;
  log(message: string): void;
}

export interface StartLeaseRequest {
  leaseId: string;
  sessionId: string;
  domains: string[];
  apps: string[];
  ttlMs: number;
}

interface Lease {
  leaseId: string;
  sessionId: string;
  domains: string[];
  apps: Set<string>;
  ttlMs: number;
  expiresAt: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const PROCESS_RE = /^[a-z0-9][a-z0-9 ._+-]{0,62}\.exe$/;
/** A tick gap longer than this means the machine slept; don't count it against the lease. */
const SLEEP_GAP_MS = 15_000;

export class BlockerCore {
  private lease: Lease | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastTickAt: number | null = null;

  constructor(private readonly deps: BlockerDeps) {}

  get hasLease(): boolean {
    return this.lease !== null;
  }

  /** Serialize every operation: they all read-modify-write the hosts file. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  start(request: StartLeaseRequest): Promise<void> {
    return this.run(async () => {
      const { leaseId, sessionId } = request;
      if (!ID_RE.test(String(leaseId)) || !ID_RE.test(String(sessionId))) {
        throw new BlockerError('invalid-request', 'Invalid lease or session id.');
      }
      if (!Array.isArray(request.domains) || !Array.isArray(request.apps)) {
        throw new BlockerError('invalid-request', 'Domains and apps must be lists.');
      }
      if (request.domains.length > MAX_BLOCKED_DOMAINS || request.apps.length > MAX_BLOCKED_APPS) {
        throw new BlockerError('invalid-request', 'Too many blocked entries.');
      }
      const domains = [...new Set(request.domains.map((d) => String(d).trim().toLowerCase()))];
      const apps = [...new Set(request.apps.map((a) => String(a).trim().toLowerCase()))];
      const badDomain = domains.find((d) => !isValidHostname(d));
      if (badDomain !== undefined) throw new BlockerError('invalid-request', `Not a hostname: ${badDomain.slice(0, 80)}`);
      const badApp = apps.find((a) => !PROCESS_RE.test(a) || PROTECTED_PROCESSES.has(a));
      if (badApp !== undefined) throw new BlockerError('invalid-request', `Not a blockable process: ${badApp.slice(0, 80)}`);
      const ttlMs = Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, Number(request.ttlMs) || 0));

      try {
        const changed = await this.deps.applyHosts(domains);
        if (changed) await this.deps.flushDns().catch(() => {});
      } catch (err) {
        // Never leave a half-applied block behind a failed start.
        if (!this.lease) await this.deps.applyHosts([]).catch(() => {});
        throw toBlockerError(err);
      }

      this.lease = { leaseId, sessionId, domains: domains.sort(), apps: new Set(apps), ttlMs, expiresAt: this.deps.now() + ttlMs };
      this.lastTickAt = this.deps.now();
      this.deps.log(`lease ${leaseId} started: ${domains.length} hosts, ${apps.length} apps`);
    });
  }

  heartbeat(leaseId: string): Promise<void> {
    return this.run(async () => {
      if (!this.lease || this.lease.leaseId !== leaseId) {
        throw new BlockerError('unknown-lease', 'This blocking lease is no longer held.');
      }
      this.lease.expiresAt = this.deps.now() + this.lease.ttlMs;
    });
  }

  stop(leaseId: string): Promise<void> {
    return this.run(async () => {
      if (this.lease && this.lease.leaseId !== leaseId) {
        throw new BlockerError('unknown-lease', 'A different blocking lease is active.');
      }
      await this.release('stopped');
    });
  }

  /**
   * Release whatever is held and remove every Reflect entry, unconditionally.
   * Used on helper shutdown and when the app clears leftover blocking (it
   * only does so while no Focus session is active).
   */
  releaseAll(): Promise<void> {
    return this.run(() => this.release('release-all'));
  }

  private async release(why: string): Promise<void> {
    const had = this.lease;
    this.lease = null;
    try {
      const changed = await this.deps.applyHosts([]);
      if (changed) await this.deps.flushDns().catch(() => {});
    } catch (err) {
      throw toBlockerError(err);
    }
    if (had) this.deps.log(`lease ${had.leaseId} released (${why})`);
  }

  /** One enforcement pass. Returns the events to report to the app. */
  tick(): Promise<BlockerEvent[]> {
    return this.run(async () => {
      const lease = this.lease;
      if (!lease) return [];
      const now = this.deps.now();

      if (this.lastTickAt !== null && now - this.lastTickAt > SLEEP_GAP_MS) {
        lease.expiresAt += now - this.lastTickAt;
      }
      this.lastTickAt = now;

      if (now >= lease.expiresAt) {
        this.deps.log(`lease ${lease.leaseId} expired without a heartbeat`);
        await this.release('expired').catch((err) => this.deps.log(`release failed: ${(err as Error).message}`));
        return [{ event: 'lease-expired', leaseId: lease.leaseId }];
      }

      try {
        const changed = await this.deps.applyHosts(lease.domains);
        if (changed) await this.deps.flushDns().catch(() => {});
      } catch (err) {
        this.deps.log(`hosts re-assert failed: ${(err as Error).message}`);
      }

      const events: BlockerEvent[] = [];
      if (lease.apps.size === 0) return events;

      let processes: ProcessInfo[];
      try {
        processes = await this.deps.listProcesses();
      } catch (err) {
        this.deps.log(`process list failed: ${(err as Error).message}`);
        return events;
      }
      // Only the session of the person who started Focus is enforced; other
      // logged-in users and services are left alone.
      const ownSession = processes.find((p) => p.pid === this.deps.ownPid)?.sessionId ?? null;
      const reported = new Set<string>();
      for (const proc of processes) {
        const name = proc.name.toLowerCase();
        if (!lease.apps.has(name) || PROTECTED_PROCESSES.has(name)) continue;
        if (proc.pid === this.deps.ownPid || proc.pid <= 4) continue;
        if (ownSession !== null && proc.sessionId !== null && proc.sessionId !== ownSession) continue;
        const killed = await this.deps.killProcess(proc.pid).catch(() => false);
        if (killed && !reported.has(name)) {
          reported.add(name);
          events.push({ event: 'blocked', leaseId: lease.leaseId, sessionId: lease.sessionId, type: 'app', target: name });
        }
      }
      return events;
    });
  }
}

function toBlockerError(err: unknown): BlockerError {
  if (err instanceof BlockerError) return err;
  if (err instanceof HostsFileError) {
    const code = err.code === 'permission' ? 'hosts-permission' : err.code === 'unreadable' ? 'hosts-unreadable' : 'hosts-io';
    return new BlockerError(code, err.message);
  }
  return new BlockerError('internal', (err as Error)?.message ?? String(err));
}

/** Parse `tasklist /FO CSV /NH` output. */
export function parseTasklistCsv(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (fields.length < 4) continue;
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) continue;
    const sessionId = Number(fields[3]);
    processes.push({ pid, name: fields[0], sessionId: Number.isInteger(sessionId) ? sessionId : null });
  }
  return processes;
}

function exec(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** The real, Windows-backed dependencies. */
export function createSystemBlockerDeps(hostsPath: string, log: (message: string) => void): BlockerDeps {
  return {
    applyHosts: (hosts) => setBlockedHosts(hostsPath, hosts),
    // Clears the OS resolver cache so a just-blocked (or just-released) name
    // is looked up again. Browsers keep their own short-lived caches.
    flushDns: async () => {
      if (process.platform === 'win32') await exec('ipconfig', ['/flushdns']);
    },
    listProcesses: async () => {
      if (process.platform !== 'win32') return [];
      return parseTasklistCsv(await exec('tasklist', ['/FO', 'CSV', '/NH']));
    },
    killProcess: async (pid) => {
      if (process.platform !== 'win32') return false;
      await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
      return true;
    },
    now: () => Date.now(),
    ownPid: process.pid,
    log,
  };
}
