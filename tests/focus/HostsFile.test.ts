import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOSTS_TAG,
  HostsFileError,
  applyReflectEntries,
  extractReflectHosts,
  hasReflectEntries,
  hostsFileHasReflectEntriesSync,
  readHostsFile,
  reflectEntriesMatch,
  removeReflectEntries,
  setBlockedHosts,
} from '../../src/focus/blocker/HostsFile.js';

const USER_HOSTS = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '#',
  '# localhost name resolution is handled within DNS itself.',
  '127.0.0.1       localhost',
  '10.0.0.5        build.internal   # my build box',
  '0.0.0.0         ads.example.com',
  '',
].join('\r\n');

describe('editing hosts content', () => {
  it('appends a tagged block and leaves every existing line untouched', () => {
    const next = applyReflectEntries(USER_HOSTS, ['youtube.com', 'www.youtube.com']);
    expect(next.startsWith(USER_HOSTS)).toBe(true);
    expect(next).toContain(`0.0.0.0 youtube.com ${HOSTS_TAG}`);
    expect(next).toContain(`:: www.youtube.com ${HOSTS_TAG}`);
    expect(extractReflectHosts(next)).toEqual(['www.youtube.com', 'youtube.com']);
    // The user's own sinkhole entry is not ours.
    expect(extractReflectHosts(next)).not.toContain('ads.example.com');
  });

  it('keeps the file\'s line endings', () => {
    const crlf = applyReflectEntries(USER_HOSTS, ['youtube.com']);
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
    const lf = applyReflectEntries('127.0.0.1 localhost\n', ['youtube.com']);
    expect(lf).not.toContain('\r');
  });

  it.each([
    ['a CRLF file', USER_HOSTS],
    ['an LF file', '127.0.0.1 localhost\n# note\n'],
    ['a file without a trailing newline', '127.0.0.1 localhost'],
    ['a file ending in blank lines', '127.0.0.1 localhost\n\n\n'],
    ['an empty file', ''],
    ['a file with a BOM', '﻿127.0.0.1 localhost\r\n'],
    ['a BOM-only file', '﻿'],
    ['mixed line endings', 'a.example 1\r\nb.example 2\nc.example 3\r\n'],
  ])('removing restores %s byte for byte', (_label, original) => {
    const applied = applyReflectEntries(original, ['youtube.com', 'discord.com']);
    expect(hasReflectEntries(applied)).toBe(true);
    expect(removeReflectEntries(applied)).toBe(original);
  });

  it('is idempotent: applying twice does not duplicate entries', () => {
    const once = applyReflectEntries(USER_HOSTS, ['youtube.com']);
    expect(applyReflectEntries(once, ['youtube.com'])).toBe(once);
    expect(once.split(HOSTS_TAG).length - 1).toBe(3); // header + two sinks
  });

  it('replaces the previous block instead of accumulating', () => {
    const first = applyReflectEntries(USER_HOSTS, ['youtube.com', 'reddit.com']);
    const second = applyReflectEntries(first, ['discord.com']);
    expect(extractReflectHosts(second)).toEqual(['discord.com']);
    expect(removeReflectEntries(second)).toBe(USER_HOSTS);
  });

  it('survives many start/stop cycles without growing the file', () => {
    let content = USER_HOSTS;
    for (let i = 0; i < 25; i += 1) {
      content = applyReflectEntries(content, ['youtube.com', `site${i}.example.com`]);
      content = removeReflectEntries(content);
    }
    expect(content).toBe(USER_HOSTS);
  });

  it('an empty list removes the block', () => {
    const applied = applyReflectEntries(USER_HOSTS, ['youtube.com']);
    expect(applyReflectEntries(applied, [])).toBe(USER_HOSTS);
    expect(applyReflectEntries(USER_HOSTS, [])).toBe(USER_HOSTS);
  });

  it('keeps lines the user added while Focus was running', () => {
    const applied = applyReflectEntries(USER_HOSTS, ['youtube.com']);
    const edited = `${applied}192.168.1.9 nas.local\r\n`;
    const restored = removeReflectEntries(edited);
    expect(restored).toContain('192.168.1.9 nas.local');
    expect(restored).toContain('10.0.0.5        build.internal   # my build box');
    expect(hasReflectEntries(restored)).toBe(false);
  });

  it('cleans up even when part of its block was deleted by hand', () => {
    const applied = applyReflectEntries(USER_HOSTS, ['youtube.com', 'reddit.com']);
    const damaged = applied
      .split('\r\n')
      .filter((line) => !line.startsWith('# Added by Reflect'))
      .join('\r\n');
    const restored = removeReflectEntries(damaged);
    expect(hasReflectEntries(restored)).toBe(false);
    expect(restored).toContain('127.0.0.1       localhost');
  });

  it('never writes anything that is not a hostname', () => {
    const next = applyReflectEntries('', ['ok.example.com', 'evil.com\n127.0.0.1 bank.com', '1.2.3.4 x', '', 'UPPER.example.com']);
    expect(extractReflectHosts(next)).toEqual(['ok.example.com', 'upper.example.com']);
    expect(next).not.toContain('bank.com');
  });

  it('knows whether the block on disk matches', () => {
    const applied = applyReflectEntries(USER_HOSTS, ['b.example.com', 'a.example.com']);
    expect(reflectEntriesMatch(applied, ['a.example.com', 'b.example.com'])).toBe(true);
    expect(reflectEntriesMatch(applied, ['a.example.com'])).toBe(false);
    expect(reflectEntriesMatch(USER_HOSTS, [])).toBe(true);
  });
});

describe('editing a hosts file on disk', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-hosts-'));
    file = path.join(dir, 'hosts');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies and removes, reporting whether anything changed', async () => {
    fs.writeFileSync(file, USER_HOSTS);
    expect(await setBlockedHosts(file, ['youtube.com'])).toBe(true);
    expect(hostsFileHasReflectEntriesSync(file)).toBe(true);
    expect(await setBlockedHosts(file, ['youtube.com'])).toBe(false);
    expect(await setBlockedHosts(file, [])).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(USER_HOSTS);
    expect(hostsFileHasReflectEntriesSync(file)).toBe(false);
    expect(await setBlockedHosts(file, [])).toBe(false);
  });

  it('leaves no temporary files behind', async () => {
    fs.writeFileSync(file, USER_HOSTS);
    await setBlockedHosts(file, ['youtube.com']);
    await setBlockedHosts(file, []);
    expect(fs.readdirSync(dir)).toEqual(['hosts']);
  });

  it('creates the block in a missing file and removes it again', async () => {
    expect(await readHostsFile(file)).toBe('');
    await setBlockedHosts(file, ['youtube.com']);
    expect(extractReflectHosts(fs.readFileSync(file, 'utf8'))).toEqual(['youtube.com']);
    await setBlockedHosts(file, []);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('refuses to touch a hosts file that is not UTF-8 text', async () => {
    fs.writeFileSync(file, Buffer.from('127.0.0.1 localhost\r\n', 'utf16le'));
    const before = fs.readFileSync(file);
    await expect(setBlockedHosts(file, ['youtube.com'])).rejects.toBeInstanceOf(HostsFileError);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('reports no residue for a file it cannot read', () => {
    expect(hostsFileHasReflectEntriesSync(path.join(dir, 'missing', 'hosts'))).toBe(false);
  });
});
