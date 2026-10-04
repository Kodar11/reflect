import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BlockingError } from '../../src/focus/BlockingManager.js';
import type { ProcessInfo } from '../../src/focus/blocker/BlockerCore.js';
import { HelperBlockingManager, type HelperLauncher } from '../../src/focus/blocker/HelperBlockingManager.js';
import { extractReflectHosts, setBlockedHosts } from '../../src/focus/blocker/HostsFile.js';
import { parseHelperArgs, startHelperSession, type HelperSession } from '../../src/focus/blocker/blockerHelper.js';
import { buildElevationScript, quoteWindowsArg } from '../../src/focus/blocker/elevatedLauncher.js';
import { PIPE_PREFIX, encodeMessage } from '../../src/focus/blocker/protocol.js';
import type { EffectiveBlockingConfig } from '../../src/focus/FocusModels.js';

/**
 * End-to-end over a real named pipe: the app-side manager on one end, the
 * helper's protocol loop and enforcement engine on the other — exactly the
 * production code, except that the "elevated process" runs in-process against
 * a temporary hosts file and a fake process table.
 */

// Named pipes are a Windows transport; elsewhere the manager is not used.
const suite = process.platform === 'win32' ? describe : describe.skip;

const ORIGINAL = '127.0.0.1 localhost\r\n';
const CONFIG: EffectiveBlockingConfig = {
  enabled: true,
  domains: ['youtube.com', 'www.youtube.com'],
  apps: ['discord.exe'],
  rules: [],
};

let dir: string;
let hostsPath: string;
let processes: ProcessInfo[];
let killed: number[];
let helpers: Array<{ session: HelperSession; exitCode: number | null }>;
let managers: HelperBlockingManager[];
let launches: number;

function inProcessLauncher(tickMs = 40): HelperLauncher {
  return async ({ pipePath, token }) => {
    launches += 1;
    const entry = { session: null as unknown as HelperSession, exitCode: null as number | null };
    entry.session = startHelperSession({
      args: { pipePath, token },
      tickMs,
      onExit: (code) => {
        entry.exitCode = code;
      },
      deps: {
        applyHosts: (hosts) => setBlockedHosts(hostsPath, hosts),
        flushDns: async () => {},
        listProcesses: async () => processes,
        killProcess: async (pid) => {
          killed.push(pid);
          processes = processes.filter((p) => p.pid !== pid);
          return true;
        },
        now: () => Date.now(),
        ownPid: 1,
        log: () => {},
      },
    });
    helpers.push(entry);
  };
}

function makeManager(launch: HelperLauncher = inProcessLauncher(), options: Partial<ConstructorParameters<typeof HelperBlockingManager>[0]> = {}) {
  const manager = new HelperBlockingManager({ launch, hostsPath, helloTimeoutMs: 1500, requestTimeoutMs: 1500, ...options });
  managers.push(manager);
  return manager;
}

const blocked = () => extractReflectHosts(fs.readFileSync(hostsPath, 'utf8'));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(15);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-manager-'));
  hostsPath = path.join(dir, 'hosts');
  fs.writeFileSync(hostsPath, ORIGINAL);
  processes = [{ pid: 1, name: 'helper.exe', sessionId: 1 }];
  killed = [];
  helpers = [];
  managers = [];
  launches = 0;
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose().catch(() => {});
  for (const helper of helpers) await helper.session.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

suite('HelperBlockingManager ↔ helper over a named pipe', () => {
  it('start blocks the sites; stop restores the hosts file', async () => {
    const manager = makeManager();
    const leaseId = await manager.start(CONFIG, 'session-1');
    expect(leaseId).toBeTruthy();
    expect(manager.connected).toBe(true);
    expect(blocked()).toEqual(['www.youtube.com', 'youtube.com']);
    expect(manager.hasResidue()).toBe(true);

    await manager.heartbeat(leaseId);
    await manager.stop(leaseId);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
    expect(manager.hasResidue()).toBe(false);
  });

  it('launches the helper once and reuses it for later sessions', async () => {
    const manager = makeManager();
    const first = await manager.start(CONFIG, 'session-1');
    await manager.stop(first);
    const second = await manager.start({ ...CONFIG, domains: ['reddit.com'], apps: [] }, 'session-2');
    expect(launches).toBe(1);
    expect(blocked()).toEqual(['reddit.com']);
    await manager.stop(second);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });

  it('terminates a blocked app, reports it, and does so again on relaunch', async () => {
    const manager = makeManager();
    const attempts: Array<{ type: string; target: string; sessionId: string }> = [];
    manager.onBlockedAttempt((a) => attempts.push(a));
    const leaseId = await manager.start(CONFIG, 'session-1');

    processes.push({ pid: 500, name: 'Discord.exe', sessionId: 1 });
    await until(() => killed.includes(500));
    await until(() => attempts.length === 1);
    expect(attempts[0]).toEqual({ type: 'app', target: 'discord.exe', sessionId: 'session-1' });

    processes.push({ pid: 501, name: 'Discord.exe', sessionId: 1 });
    await until(() => killed.includes(501));

    // After Focus ends the app runs normally.
    await manager.stop(leaseId);
    processes.push({ pid: 502, name: 'Discord.exe', sessionId: 1 });
    await wait(150);
    expect(killed).toEqual([500, 501]);
  });

  it('rejects a heartbeat once the helper has dropped the lease', async () => {
    const manager = makeManager();
    const leaseId = await manager.start(CONFIG, 'session-1');
    await helpers[0].session.core.releaseAll();
    await expect(manager.heartbeat(leaseId)).rejects.toMatchObject({ code: 'lease-lost' });
    // Stopping a lease that is already gone is not an error.
    await expect(manager.stop(leaseId)).resolves.toBeUndefined();
  });

  it('notices when the helper dies and starts a new one on the next lease', async () => {
    const manager = makeManager();
    const leaseId = await manager.start(CONFIG, 'session-1');
    await helpers[0].session.shutdown();
    await until(() => !manager.connected);
    await expect(manager.heartbeat(leaseId)).rejects.toBeInstanceOf(BlockingError);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL); // the dying helper restored the file

    await manager.start(CONFIG, 'session-1');
    expect(launches).toBe(2);
    expect(blocked()).toHaveLength(2);
  });

  it('surfaces a declined elevation as a clear error and holds nothing', async () => {
    const manager = makeManager(async () => {
      throw new BlockingError('elevation-declined', 'Administrator permission was declined, so blocking could not be turned on.');
    });
    await expect(manager.start(CONFIG, 'session-1')).rejects.toMatchObject({ code: 'elevation-declined' });
    expect(manager.connected).toBe(false);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });

  it('times out if the launched helper never connects', async () => {
    const manager = makeManager(async () => {}, { helloTimeoutMs: 150 });
    await expect(manager.start(CONFIG, 'session-1')).rejects.toMatchObject({ code: 'helper-unavailable' });
  });

  it('ignores a process that finds the pipe but does not know the token', async () => {
    let intruderGotData = false;
    const real = inProcessLauncher();
    const manager = makeManager(async (params) => {
      await new Promise<void>((resolve) => {
        const intruder = net.connect(params.pipePath, () => {
          intruder.write(encodeMessage({ event: 'hello', token: 'f'.repeat(64), pid: 666 }));
        });
        intruder.on('data', () => {
          intruderGotData = true;
        });
        intruder.on('close', () => resolve());
        intruder.on('error', () => resolve());
      });
      await real(params);
    });
    await manager.start(CONFIG, 'session-1');
    expect(intruderGotData).toBe(false);
    expect(manager.connected).toBe(true);
    expect(blocked()).toHaveLength(2);
  });

  it('a helper that loses the app keeps enforcing until the lease runs out, then restores and exits', async () => {
    const manager = makeManager(inProcessLauncher(30), { leaseTtlMs: 10_000 });
    await manager.start(CONFIG, 'session-1');
    const helper = helpers[0];
    // The app "crashes": its end of the pipe vanishes without a goodbye.
    (manager as unknown as { socket: net.Socket }).socket.destroy();
    await until(() => !manager.connected);

    await wait(120);
    expect(helper.exitCode).toBeNull();
    expect(blocked()).toHaveLength(2); // still enforcing

    // Fast-forward the lease's TTL instead of waiting 10 real seconds.
    (helper.session.core as unknown as { lease: { expiresAt: number } }).lease.expiresAt = Date.now() - 1;
    await until(() => helper.exitCode !== null);
    expect(helper.exitCode).toBe(0);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });

  it('clears leftovers from an earlier crash', async () => {
    await setBlockedHosts(hostsPath, ['youtube.com']);
    const manager = makeManager();
    expect(manager.hasResidue()).toBe(true);
    await manager.clearResidue();
    expect(manager.hasResidue()).toBe(false);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });

  it('stop without a helper cleans up leftovers, and does nothing when there are none', async () => {
    const manager = makeManager();
    await manager.stop('gone');
    expect(launches).toBe(0); // nothing on disk → no helper, no UAC prompt

    await setBlockedHosts(hostsPath, ['youtube.com']);
    await manager.stop('gone');
    expect(launches).toBe(1);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });

  it('dispose releases everything and ends the helper', async () => {
    const manager = makeManager();
    await manager.start(CONFIG, 'session-1');
    await manager.dispose();
    await until(() => helpers[0].exitCode !== null);
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
    await expect(manager.start(CONFIG, 'session-2')).rejects.toBeInstanceOf(BlockingError);
  });

  it('passes a helper rejection through without holding a lease', async () => {
    const manager = makeManager();
    await expect(manager.start({ ...CONFIG, apps: ['explorer.exe'] }, 'session-1')).rejects.toMatchObject({ code: 'rejected' });
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL);
  });
});

describe('helper arguments', () => {
  const pipe = `${PIPE_PREFIX}3f2c1a9e-aaaa-bbbb-cccc-1234567890ab`;
  const token = 'a'.repeat(64);

  it('accepts a well-formed invocation', () => {
    expect(parseHelperArgs(['app.exe', '--focus-blocker', `--pipe=${pipe}`, `--token=${token}`, '--dev'])).toEqual({ pipePath: pipe, token });
  });

  it.each([
    ['a missing token', ['--focus-blocker', `--pipe=${pipe}`]],
    ['a missing pipe', ['--focus-blocker', `--token=${token}`]],
    ['a pipe outside our namespace', ['--focus-blocker', '--pipe=\\\\.\\pipe\\something-else', `--token=${token}`]],
    ['a file path as the pipe', ['--focus-blocker', '--pipe=C:\\Windows\\System32\\drivers\\etc\\hosts', `--token=${token}`]],
    ['a remote pipe', ['--focus-blocker', '--pipe=\\\\evil\\pipe\\reflect-focus-abcdefgh', `--token=${token}`]],
    ['a malformed token', ['--focus-blocker', `--pipe=${pipe}`, '--token=not-hex']],
  ])('refuses %s', (_label, argv) => {
    expect(parseHelperArgs(argv)).toBeNull();
  });
});

describe('elevation command', () => {
  it('quotes every argument and survives spaces and apostrophes in paths', () => {
    const script = buildElevationScript("C:\\Users\\O'Brien\\App Data\\Reflect.exe", ["E:\\My Projects\\reflect\\", '--focus-blocker', '--pipe=\\\\.\\pipe\\reflect-focus-x']);
    expect(script).toContain("-FilePath 'C:\\Users\\O''Brien\\App Data\\Reflect.exe'");
    expect(script).toContain('"E:\\My Projects\\reflect" "--focus-blocker" "--pipe=\\\\.\\pipe\\reflect-focus-x"');
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain('-WindowStyle Hidden');
  });

  it('refuses an argument that could break out of its quotes', () => {
    expect(() => quoteWindowsArg('a" & calc & "')).toThrow();
    expect(quoteWindowsArg('C:\\path\\')).toBe('"C:\\path"');
  });
});
