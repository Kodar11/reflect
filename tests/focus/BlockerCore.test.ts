import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockerCore, parseTasklistCsv, type BlockerDeps, type ProcessInfo } from '../../src/focus/blocker/BlockerCore.js';
import { extractReflectHosts, setBlockedHosts } from '../../src/focus/blocker/HostsFile.js';

const ORIGINAL = '127.0.0.1 localhost\r\n10.0.0.5 build.internal\r\n';
const OWN_PID = 4242;

interface World {
  core: BlockerCore;
  hostsPath: string;
  clock: { now: number };
  processes: ProcessInfo[];
  killed: number[];
  flushes: number;
  logs: string[];
  hosts(): string;
  blocked(): string[];
}

let dir: string;

function makeWorld(overrides: Partial<BlockerDeps> = {}): World {
  const hostsPath = path.join(dir, 'hosts');
  fs.writeFileSync(hostsPath, ORIGINAL);
  const world = {
    hostsPath,
    clock: { now: 1_000_000 },
    processes: [{ pid: OWN_PID, name: 'Productivity Coach.exe', sessionId: 1 }] as ProcessInfo[],
    killed: [] as number[],
    flushes: 0,
    logs: [] as string[],
    hosts: () => fs.readFileSync(hostsPath, 'utf8'),
    blocked: () => extractReflectHosts(fs.readFileSync(hostsPath, 'utf8')),
  } as World;
  world.core = new BlockerCore({
    applyHosts: (hosts) => setBlockedHosts(hostsPath, hosts),
    flushDns: async () => {
      world.flushes += 1;
    },
    listProcesses: async () => world.processes,
    killProcess: async (pid) => {
      world.killed.push(pid);
      world.processes = world.processes.filter((p) => p.pid !== pid);
      return true;
    },
    now: () => world.clock.now,
    ownPid: OWN_PID,
    log: (m) => world.logs.push(m),
    ...overrides,
  });
  return world;
}

const lease = (overrides: Partial<Parameters<BlockerCore['start']>[0]> = {}) => ({
  leaseId: 'lease-1',
  sessionId: 'session-1',
  domains: ['youtube.com', 'www.youtube.com'],
  apps: ['discord.exe'],
  ttlMs: 45_000,
  ...overrides,
});

/** Let `ms` pass the way it does in the helper: one enforcement tick every 2s. */
async function run(w: World, ms: number) {
  const events = [];
  for (let passed = 0; passed < ms; passed += 2000) {
    w.clock.now += 2000;
    events.push(...(await w.core.tick()));
  }
  return events;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-blocker-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('BlockerCore — lease lifecycle', () => {
  it('start writes the block, flushes DNS and holds the lease', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    expect(w.core.hasLease).toBe(true);
    expect(w.blocked()).toEqual(['www.youtube.com', 'youtube.com']);
    expect(w.hosts().startsWith(ORIGINAL)).toBe(true);
    expect(w.flushes).toBe(1);
  });

  it('stop restores the hosts file exactly and flushes DNS', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    await w.core.stop('lease-1');
    expect(w.core.hasLease).toBe(false);
    expect(w.hosts()).toBe(ORIGINAL);
    expect(w.flushes).toBe(2);
  });

  it('heartbeat extends the lease; without it the lease expires and restores', async () => {
    const w = makeWorld();
    await w.core.start(lease());

    expect(await run(w, 40_000)).toEqual([]);
    await w.core.heartbeat('lease-1');
    expect(await run(w, 40_000)).toEqual([]);
    expect(w.core.hasLease).toBe(true);

    expect(await run(w, 6000)).toEqual([{ event: 'lease-expired', leaseId: 'lease-1' }]);
    expect(w.core.hasLease).toBe(false);
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('rejects a heartbeat or stop for a lease it does not hold', async () => {
    const w = makeWorld();
    await expect(w.core.heartbeat('lease-1')).rejects.toMatchObject({ code: 'unknown-lease' });
    await w.core.start(lease());
    await expect(w.core.heartbeat('other')).rejects.toMatchObject({ code: 'unknown-lease' });
    await expect(w.core.stop('other')).rejects.toMatchObject({ code: 'unknown-lease' });
    expect(w.core.hasLease).toBe(true);
    expect(w.blocked()).toHaveLength(2);
  });

  it('a new lease replaces the old one without leaking its entries', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    await w.core.start(lease({ leaseId: 'lease-2', domains: ['reddit.com'], apps: [] }));
    expect(w.blocked()).toEqual(['reddit.com']);
    await expect(w.core.heartbeat('lease-1')).rejects.toMatchObject({ code: 'unknown-lease' });
    await w.core.stop('lease-2');
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('repeated start/stop cycles leave the file as it was', async () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i += 1) {
      await w.core.start(lease({ leaseId: `lease-${i}` }));
      await w.core.stop(`lease-${i}`);
    }
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('stop with no lease still removes leftovers from a crashed run', async () => {
    const w = makeWorld();
    await setBlockedHosts(w.hostsPath, ['youtube.com']);
    await w.core.stop('whatever');
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('releaseAll drops the lease and every entry', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    await w.core.releaseAll();
    expect(w.core.hasLease).toBe(false);
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('does not let the lease run out just because the machine slept', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    w.clock.now += 2000;
    await w.core.tick();
    w.clock.now += 60 * 60_000; // lid closed for an hour
    expect(await w.core.tick()).toEqual([]);
    expect(w.core.hasLease).toBe(true);
    // …but it still expires if no heartbeat follows the wake-up.
    await run(w, 46_000);
    expect(w.core.hasLease).toBe(false);
    expect(w.hosts()).toBe(ORIGINAL);
  });
});

describe('BlockerCore — validation', () => {
  it.each([
    ['a non-hostname', { domains: ['youtube.com', '127.0.0.1 bank.com'] }],
    ['a path instead of a host', { domains: ['../../etc/passwd'] }],
    ['a protected process', { apps: ['explorer.exe'] }],
    ['a process with a path', { apps: ['c:\\windows\\x.exe'] }],
    ['a strange lease id', { leaseId: 'lease 1; rm -rf' }],
    ['non-list domains', { domains: 'youtube.com' as never }],
  ])('refuses %s and changes nothing', async (_label, bad) => {
    const w = makeWorld();
    await expect(w.core.start(lease(bad))).rejects.toMatchObject({ code: 'invalid-request' });
    expect(w.core.hasLease).toBe(false);
    expect(w.hosts()).toBe(ORIGINAL);
  });

  it('refuses an oversized request', async () => {
    const w = makeWorld();
    const domains = Array.from({ length: 2001 }, (_, i) => `site${i}.example.com`);
    await expect(w.core.start(lease({ domains }))).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('clamps the lease TTL', async () => {
    const w = makeWorld();
    await w.core.start(lease({ ttlMs: 1 }));
    await run(w, 8000);
    expect(w.core.hasLease).toBe(true);
    await run(w, 2000);
    expect(w.core.hasLease).toBe(false);
  });

  it('holds no lease and leaves no block when the hosts file cannot be written', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.hostsPath, Buffer.from(ORIGINAL, 'utf16le'));
    const before = fs.readFileSync(w.hostsPath);
    await expect(w.core.start(lease())).rejects.toMatchObject({ code: 'hosts-unreadable' });
    expect(w.core.hasLease).toBe(false);
    expect(fs.readFileSync(w.hostsPath).equals(before)).toBe(true);
  });
});

describe('BlockerCore — enforcement', () => {
  it('re-asserts the block if it is removed during Focus', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    fs.writeFileSync(w.hostsPath, ORIGINAL); // someone "fixed" the hosts file
    w.clock.now += 2000;
    await w.core.tick();
    expect(w.blocked()).toEqual(['www.youtube.com', 'youtube.com']);
    expect(w.flushes).toBe(2);
  });

  it('does not rewrite or flush when nothing changed', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    const mtime = fs.statSync(w.hostsPath).mtimeMs;
    for (let i = 0; i < 5; i += 1) {
      w.clock.now += 2000;
      await w.core.tick();
    }
    expect(w.flushes).toBe(1);
    expect(fs.statSync(w.hostsPath).mtimeMs).toBe(mtime);
  });

  it('terminates a blocked app and reports the attempt', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    w.processes.push({ pid: 900, name: 'Discord.exe', sessionId: 1 }, { pid: 901, name: 'Discord.exe', sessionId: 1 }, { pid: 77, name: 'Code.exe', sessionId: 1 });
    w.clock.now += 2000;
    const events = await w.core.tick();
    expect(w.killed).toEqual([900, 901]);
    // One attempt per app per pass, however many processes it had.
    expect(events).toEqual([{ event: 'blocked', leaseId: 'lease-1', sessionId: 'session-1', type: 'app', target: 'discord.exe' }]);
  });

  it('terminates it again every time it is relaunched', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    for (let i = 0; i < 3; i += 1) {
      w.processes.push({ pid: 1000 + i, name: 'discord.exe', sessionId: 1 });
      w.clock.now += 2000;
      expect(await w.core.tick()).toHaveLength(1);
    }
    expect(w.killed).toEqual([1000, 1001, 1002]);
  });

  it('leaves the app alone once the lease is released', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    await w.core.stop('lease-1');
    w.processes.push({ pid: 900, name: 'discord.exe', sessionId: 1 });
    w.clock.now += 2000;
    expect(await w.core.tick()).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('only touches the session of the person who started Focus', async () => {
    const w = makeWorld();
    await w.core.start(lease());
    w.processes.push({ pid: 900, name: 'discord.exe', sessionId: 2 }, { pid: 901, name: 'discord.exe', sessionId: 1 });
    w.clock.now += 2000;
    await w.core.tick();
    expect(w.killed).toEqual([901]);
  });

  it('never terminates itself or a protected process', async () => {
    const w = makeWorld();
    await w.core.start(lease({ apps: ['discord.exe'] }));
    // Even if a lease somehow listed them, the engine refuses.
    (w.core as unknown as { lease: { apps: Set<string> } }).lease.apps.add('explorer.exe').add('productivity coach.exe');
    w.processes.push({ pid: 50, name: 'explorer.exe', sessionId: 1 });
    w.clock.now += 2000;
    await w.core.tick();
    expect(w.killed).toEqual([]);
  });

  it('keeps enforcing websites when the process list fails', async () => {
    const w = makeWorld({
      listProcesses: async () => {
        throw new Error('tasklist failed');
      },
    });
    await w.core.start(lease());
    w.clock.now += 2000;
    expect(await w.core.tick()).toEqual([]);
    expect(w.core.hasLease).toBe(true);
    expect(w.blocked()).toHaveLength(2);
  });

  it('serializes overlapping operations on the hosts file', async () => {
    const w = makeWorld();
    await Promise.all([
      w.core.start(lease()),
      w.core.tick(),
      w.core.heartbeat('lease-1'),
      w.core.tick(),
      w.core.stop('lease-1'),
      w.core.tick(),
    ]);
    expect(w.hosts()).toBe(ORIGINAL);
    expect(w.core.hasLease).toBe(false);
  });
});

describe('tasklist parsing', () => {
  it('reads image name, pid and session', () => {
    const output = [
      '"System Idle Process","0","Services","0","8 K"',
      '"chrome.exe","12345","Console","1","123,456 K"',
      '"Battle.net.exe","777","Console","1","1,024 K"',
      '',
      'garbage line',
    ].join('\r\n');
    expect(parseTasklistCsv(output)).toEqual([
      { pid: 0, name: 'System Idle Process', sessionId: 0 },
      { pid: 12345, name: 'chrome.exe', sessionId: 1 },
      { pid: 777, name: 'Battle.net.exe', sessionId: 1 },
    ]);
  });
});
