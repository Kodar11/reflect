import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createExportHandlers, describeExportError, normalizeDestination, registerExportIpc, type ExportIpcDeps } from '../../src/electron/exportIpc';
import { makeHarness, tempDir } from '../export/helpers';

const NOW = new Date(2026, 9, 15, 12);
const VALID = { categories: ['timeline', 'personalization'], range: { preset: 'last7' }, format: 'json' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(choose: ExportIpcDeps['chooseDestination'], service: ExportIpcDeps['service'] = makeHarness({}, NOW).service) {
  const revealed: string[] = [];
  const asked: { defaultName: string; extension: string }[] = [];
  const handlers = createExportHandlers({
    service,
    chooseDestination: async (options) => {
      asked.push(options);
      return choose(options);
    },
    revealFile: (p) => revealed.push(p),
    now: () => NOW,
  });
  return { handlers, revealed, asked };
}

describe('export IPC', () => {
  it('registers only preview, run and reveal', () => {
    const keys: string[] = [];
    registerExportIpc({ service: makeHarness().service, chooseDestination: async () => null, revealFile: () => undefined }, (key) => keys.push(key));
    expect(keys.sort()).toEqual(['export:preview', 'export:reveal', 'export:run']);
  });

  it('suggests the file name and asks the user where to save; the renderer never supplies a path', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const t = setup(async () => path.join(dir, 'mine.zip'));
    const result = await t.handlers.run(VALID);
    expect(t.asked).toEqual([{ defaultName: 'reflect-export-2026-10-15.zip', extension: 'zip' }]);
    expect(result).toMatchObject({ status: 'saved', fileName: 'mine.zip', folder: dir, files: ['timeline.json', 'personalization.json', 'manifest.json'] });
    expect(fs.existsSync(path.join(dir, 'mine.zip'))).toBe(true);
  });

  it('refuses a request carrying a path before any dialog or write', async () => {
    const t = setup(async () => {
      throw new Error('must not be asked');
    });
    const result = await t.handlers.run({ ...VALID, filePath: 'C:\\Windows\\win.ini' });
    expect(result).toEqual({ status: 'error', message: 'Invalid export request.' });
    expect(t.asked).toEqual([]);
    expect(t.handlers.preview({ ...VALID, destination: '/etc/passwd' })).toMatchObject({ ok: false });
  });

  it('treats a cancelled save dialog as a quiet cancel, not an error', async () => {
    const t = setup(async () => null);
    expect(await t.handlers.run(VALID)).toEqual({ status: 'cancelled' });
    expect(t.handlers.reveal()).toEqual({ ok: false });
  });

  it('reports failures in plain language, without paths or system text', async () => {
    const failing = { preview: () => ({ ok: false as const, error: 'x' }), write: async () => { throw Object.assign(new Error('EACCES: permission denied, open C:\\secret\\x'), { code: 'EACCES' }); } };
    const t = setup(async () => 'C:\\Users\\me\\Documents\\x.zip', failing);
    const result = await t.handlers.run(VALID);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toMatch(/not allowed to save in that folder/);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('allows one export at a time', async () => {
    let release!: () => void;
    const slow = { preview: () => ({ ok: false as const, error: 'x' }), write: () => new Promise<{ files: string[]; bytes: number }>((r) => (release = () => r({ files: ['a'], bytes: 1 }))) };
    const t = setup(async () => 'C:\\x\\a.zip', slow);
    const first = t.handlers.run(VALID);
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.handlers.run(VALID)).toEqual({ status: 'error', message: 'An export is already in progress.' });
    release();
    expect((await first).status).toBe('saved');
  });

  it('reveals only the file it just saved', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const t = setup(async () => path.join(dir, 'x'));
    await t.handlers.run({ ...VALID, categories: ['timeline'], format: 'csv' });
    expect(t.handlers.reveal()).toEqual({ ok: true });
    expect(t.revealed).toEqual([path.join(dir, 'x.csv')]);
  });

  it('previews through the same validation', () => {
    const t = setup(async () => null);
    expect(t.handlers.preview(VALID)).toMatchObject({ ok: true, fileName: 'reflect-export-2026-10-15.zip' });
    expect(t.handlers.preview({ ...VALID, categories: [] })).toMatchObject({ ok: false });
  });
});

describe('normalizeDestination', () => {
  it('accepts absolute paths and adds a missing extension', () => {
    const abs = path.resolve('exports', 'reflect');
    expect(normalizeDestination(abs, 'zip')).toBe(`${abs}.zip`);
    expect(normalizeDestination(`${abs}.ZIP`, 'zip')).toBe(`${abs}.ZIP`);
  });

  it('refuses relative, empty and NUL-containing paths', () => {
    expect(normalizeDestination('relative/x.zip', 'zip')).toBeNull();
    expect(normalizeDestination('', 'zip')).toBeNull();
    expect(normalizeDestination(`${path.resolve('a')}\0.zip`, 'zip')).toBeNull();
  });
});

describe('describeExportError', () => {
  it('maps common file-system failures', () => {
    expect(describeExportError(Object.assign(new Error(), { code: 'ENOSPC' }))).toMatch(/disk space/);
    expect(describeExportError(Object.assign(new Error(), { code: 'EBUSY' }))).toMatch(/open in another program/);
    expect(describeExportError(new Error('weird'))).toBe('The export could not be completed. Nothing was saved.');
  });
});
