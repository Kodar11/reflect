import net from 'node:net';
import { BlockerCore, createSystemBlockerDeps, type BlockerDeps } from './BlockerCore.js';
import { getHostsFilePath } from './HostsFile.js';
import {
  BlockerError,
  HELPER_FLAG,
  LineDecoder,
  PIPE_PREFIX,
  encodeMessage,
  type BlockerCommand,
  type BlockerReply,
} from './protocol.js';

/**
 * The elevated blocker helper: a second instance of the Reflect executable
 * started with `--focus-blocker` through a UAC prompt. It is the only part of
 * Reflect that runs with administrator rights, and it does nothing but run a
 * `BlockerCore` on behalf of the app that launched it.
 *
 * Lifecycle:
 *   - connects to the app's named pipe and identifies itself with the token;
 *   - serves start / heartbeat / stop / cleanup / shutdown commands;
 *   - enforces every `tickMs` while a lease is alive;
 *   - if the app disappears, keeps enforcing until the lease's TTL runs out,
 *     then restores the hosts file and exits;
 *   - on any exit path it restores the hosts file first.
 */

export interface HelperArgs {
  pipePath: string;
  token: string;
}

export function isBlockerHelperInvocation(argv: readonly string[]): boolean {
  return argv.includes(HELPER_FLAG);
}

export function parseHelperArgs(argv: readonly string[]): HelperArgs | null {
  const value = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const pipePath = value('pipe');
  const token = value('token');
  if (!pipePath || !token) return null;
  // Only ever connect to a pipe in our own namespace.
  if (!pipePath.startsWith(PIPE_PREFIX) || !/^[A-Za-z0-9-]{8,80}$/.test(pipePath.slice(PIPE_PREFIX.length))) return null;
  if (!/^[a-f0-9]{32,128}$/.test(token)) return null;
  return { pipePath, token };
}

export interface HelperSessionOptions {
  args: HelperArgs;
  deps: BlockerDeps;
  /** Called once when the helper has nothing left to do. */
  onExit: (code: number) => void;
  tickMs?: number;
  connectTimeoutMs?: number;
}

export interface HelperSession {
  core: BlockerCore;
  /** Release everything and stop (signals, fatal errors, tests). */
  shutdown(code?: number): Promise<void>;
}

/** Run the helper protocol over the pipe. Testable: no Electron, no globals. */
export function startHelperSession(options: HelperSessionOptions): HelperSession {
  const { args, deps, onExit } = options;
  const tickMs = options.tickMs ?? 2000;
  const core = new BlockerCore(deps);
  const decoder = new LineDecoder();
  let connected = false;
  let exited = false;
  let ticking = false;

  const socket = net.connect(args.pipePath);
  const connectTimer = setTimeout(() => {
    if (!connected) void finish(2);
  }, options.connectTimeoutMs ?? 15_000);

  const timer = setInterval(() => {
    if (ticking || exited) return;
    ticking = true;
    core
      .tick()
      .then((events) => {
        for (const event of events) send(event);
        // The app is gone and the lease has run out: nothing left to guard.
        if (!connected && !core.hasLease) void finish(0);
      })
      .catch((err) => deps.log(`tick failed: ${(err as Error).message}`))
      .finally(() => {
        ticking = false;
      });
  }, tickMs);

  function send(message: Parameters<typeof encodeMessage>[0]): void {
    if (!connected || socket.destroyed) return;
    try {
      socket.write(encodeMessage(message));
    } catch {
      // The pipe went away; the close handler deals with it.
    }
  }

  let finishing: Promise<void> | null = null;

  /** Restore the machine, then exit. Every caller waits for the same run. */
  function finish(code: number): Promise<void> {
    if (!finishing) {
      exited = true;
      clearInterval(timer);
      clearTimeout(connectTimer);
      finishing = core
        .releaseAll()
        .catch((err) => deps.log(`final release failed: ${(err as Error).message}`))
        .then(() => {
          socket.destroy();
          onExit(code);
        });
    }
    return finishing;
  }

  async function handle(command: BlockerCommand): Promise<void> {
    const reply = (r: BlockerReply) => send(r);
    try {
      switch (command.cmd) {
        case 'start':
          await core.start(command);
          break;
        case 'heartbeat':
          await core.heartbeat(String(command.leaseId));
          break;
        case 'stop':
          await core.stop(String(command.leaseId));
          break;
        case 'cleanup':
          await core.releaseAll();
          break;
        case 'ping':
          break;
        case 'shutdown':
          await core.releaseAll();
          reply({ id: command.id, ok: true });
          await finish(0);
          return;
        default:
          throw new BlockerError('invalid-request', 'Unknown command.');
      }
      reply({ id: command.id, ok: true });
    } catch (err) {
      const e = err instanceof BlockerError ? err : new BlockerError('internal', (err as Error)?.message ?? String(err));
      reply({ id: command.id, ok: false, code: e.code, error: e.message });
    }
  }

  socket.on('connect', () => {
    connected = true;
    clearTimeout(connectTimer);
    send({ event: 'hello', token: args.token, pid: deps.ownPid });
  });
  socket.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const command = message as BlockerCommand;
      if (!command || typeof command !== 'object' || typeof command.id !== 'number' || typeof command.cmd !== 'string') continue;
      void handle(command);
    }
  });
  socket.on('error', (err) => deps.log(`pipe error: ${err.message}`));
  socket.on('close', () => {
    const wasConnected = connected;
    connected = false;
    if (!wasConnected) {
      void finish(2);
      return;
    }
    // With no lease there is nothing to keep alive for. With a lease, keep
    // enforcing until its TTL expires — the tick loop exits afterwards.
    if (!core.hasLease) void finish(0);
  });

  return { core, shutdown: (code = 0) => finish(code) };
}

/**
 * Process entry point for the elevated helper. `exit` must terminate the
 * process (in Electron: `app.exit`).
 */
export function runBlockerHelperProcess(argv: readonly string[], exit: (code: number) => void): void {
  const log = (message: string) => console.log(`[focus-blocker] ${message}`);
  const args = parseHelperArgs(argv);
  if (!args) {
    log('missing or invalid arguments; exiting.');
    exit(64);
    return;
  }
  const session = startHelperSession({
    args,
    deps: createSystemBlockerDeps(getHostsFilePath(), log),
    onExit: exit,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => void session.shutdown(0));
  }
  process.on('uncaughtException', (err) => {
    log(`fatal: ${err?.message ?? err}`);
    void session.shutdown(1);
  });
}
