import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Reversible editing of the system hosts file.
 *
 * Every line Reflect writes ends with `HOSTS_TAG`. That tag — not a pair of
 * BEGIN/END markers — is what identifies our lines, so:
 *
 *   - the user's own entries are never read as ours and never rewritten;
 *   - removal is "drop every tagged line", which cannot be confused by a
 *     half-deleted or duplicated marker;
 *   - applying is "drop every tagged line, then append the new block", so
 *     repeated starts, crashes mid-session and two overlapping sessions can
 *     never duplicate or leak entries.
 *
 * Line endings, a UTF-8 BOM and the file's trailing-newline state are kept
 * as they were.
 */

export const HOSTS_TAG = '# reflect-focus';
const HEADER_TEXT = '# Added by Reflect Focus. Removed automatically when Focus ends.';
/** Recorded in our header when the original file did not end with a newline. */
const NO_EOL_FLAG = '(no-eol)';
const BOM = '﻿';
/** Blocked names resolve to the unroutable address, so connections fail fast. */
const SINKS = ['0.0.0.0', '::'];

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function getHostsFilePath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function isTagged(line: string): boolean {
  return line.trimEnd().endsWith(HOSTS_TAG);
}

function detectEol(content: string): string {
  if (content.includes('\r\n')) return '\r\n';
  return '\n';
}

/** True if the content holds any line Reflect added. */
export function hasReflectEntries(content: string): boolean {
  return content.split(/\r\n|\n/).some(isTagged);
}

/** The hostnames currently blocked by Reflect's lines, sorted and unique. */
export function extractReflectHosts(content: string): string[] {
  const hosts = new Set<string>();
  for (const line of content.split(/\r\n|\n/)) {
    if (!isTagged(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (SINKS.includes(parts[0]) && parts[1] && parts[1] !== '#') hosts.add(parts[1].toLowerCase());
  }
  return [...hosts].sort();
}

/**
 * Remove every line Reflect added. Everything else is returned untouched, so
 * applying and then removing yields the original file byte for byte.
 */
export function removeReflectEntries(content: string): string {
  if (!hasReflectEntries(content)) return content;
  const bom = content.startsWith(BOM) ? BOM : '';
  const text = content.slice(bom.length);
  // Each part keeps its own line terminator, so untouched lines survive
  // exactly — including files with mixed line endings.
  const parts = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  const kept: string[] = [];
  let originalHadNoEol = false;
  let firstTagged = -1;
  for (const part of parts) {
    const line = part.replace(/\r?\n$/, '');
    if (isTagged(line)) {
      if (firstTagged < 0) firstTagged = kept.length;
      if (line.includes(NO_EOL_FLAG)) originalHadNoEol = true;
      continue;
    }
    kept.push(part);
  }
  // Drop the one blank separator line we inserted ahead of our block.
  if (firstTagged > 0 && kept[firstTagged - 1].trim() === '') kept.splice(firstTagged - 1, 1);
  const out = kept.join('');
  return bom + (originalHadNoEol ? out.replace(/\r?\n$/, '') : out);
}

/**
 * Return `content` with Reflect's block set to exactly `hosts` (and nothing
 * else of ours). An empty list removes the block.
 */
export function applyReflectEntries(content: string, hosts: readonly string[]): string {
  const wanted = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].filter((h) => HOSTNAME_RE.test(h)).sort();
  const base = removeReflectEntries(content);
  if (wanted.length === 0) return base;

  const bom = base.startsWith(BOM) ? BOM : '';
  const text = base.slice(bom.length);
  const eol = detectEol(text);
  const noEol = text !== '' && !/\n$/.test(text);
  const block = [noEol ? `${HEADER_TEXT} ${NO_EOL_FLAG} ${HOSTS_TAG}` : `${HEADER_TEXT} ${HOSTS_TAG}`];
  for (const host of wanted) {
    for (const sink of SINKS) block.push(`${sink} ${host} ${HOSTS_TAG}`);
  }

  if (text === '') return bom + block.join(eol) + eol;
  return bom + text + (noEol ? eol : '') + eol + block.join(eol) + eol;
}

/** True when Reflect's block on disk already equals `hosts`. */
export function reflectEntriesMatch(content: string, hosts: readonly string[]): boolean {
  const wanted = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].filter((h) => HOSTNAME_RE.test(h)).sort();
  const actual = extractReflectHosts(content);
  return actual.length === wanted.length && actual.every((h, i) => h === wanted[i]);
}

export class HostsFileError extends Error {
  constructor(
    readonly code: 'permission' | 'unreadable' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'HostsFileError';
  }
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

export async function readHostsFile(target: string): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    if (isPermissionError(err)) throw new HostsFileError('permission', `No permission to read the hosts file (${target}).`);
    throw new HostsFileError('io', `Could not read the hosts file: ${(err as Error).message}`);
  }
  // A hosts file in another encoding (UTF-16, a legacy code page) would be
  // corrupted by a UTF-8 round trip. Refuse rather than damage it.
  if (content.includes('\u0000') || content.includes('\uFFFD')) {
    throw new HostsFileError('unreadable', 'The hosts file is not UTF-8 text; Reflect will not modify it.');
  }
  return content;
}

/** Synchronous, permission-tolerant check used by the unprivileged app. */
export function hostsFileHasReflectEntriesSync(target: string): boolean {
  try {
    return hasReflectEntries(fsSync.readFileSync(target, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Write via a temp file in the same directory, then rename over the target.
 * Some Windows security products reject rename-over-target for the hosts
 * file even for an administrator, so fall back to a direct copy.
 */
export async function writeHostsFile(target: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(target), `.reflect-focus.${process.pid}.${Date.now()}.tmp`);
  const fail = (err: unknown): never => {
    if (isPermissionError(err)) {
      throw new HostsFileError('permission', `No permission to change the hosts file (${target}). Administrator rights are required.`);
    }
    throw new HostsFileError('io', `Could not write the hosts file: ${(err as Error).message}`);
  };
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8' });
  } catch (err) {
    // The directory itself may not accept new files; write in place.
    try {
      await fs.writeFile(target, content, { encoding: 'utf8' });
      return;
    } catch (inner) {
      fail(isPermissionError(inner) ? inner : err);
    }
  }
  try {
    await fs.rename(tmp, target);
  } catch (renameErr) {
    try {
      await fs.copyFile(tmp, target);
    } catch (copyErr) {
      await fs.unlink(tmp).catch(() => {});
      fail(isPermissionError(copyErr) ? copyErr : renameErr);
    }
    await fs.unlink(tmp).catch(() => {});
  }
}

/**
 * Make Reflect's block in the file at `target` equal `hosts`.
 * Returns true if the file changed.
 */
export async function setBlockedHosts(target: string, hosts: readonly string[]): Promise<boolean> {
  const existing = await readHostsFile(target);
  const next = applyReflectEntries(existing, hosts);
  if (next === existing) return false;
  await writeHostsFile(target, next);
  return true;
}
