import { describe, it, expect } from 'vitest';
import {
  EXPORT_CATEGORIES,
  categoryFileNames,
  categoryFormat,
  isSingleFileExport,
  parseExportRequest,
  parseLocalDay,
  resolveExportRange,
  suggestedExportFileName,
} from '../../src/export/ExportModels';

const NOW = new Date(2026, 9, 15, 14, 30); // Thu 15 Oct 2026, 14:30 local
const midnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

describe('resolveExportRange — presets resolve to local calendar days', () => {
  it('all available data has no bounds', () => {
    const r = resolveExportRange({ preset: 'all' }, NOW);
    expect(r).toEqual({ ok: true, range: { preset: 'all', from: null, to: null, firstDay: null, lastDay: null } });
  });

  it('today is local midnight to the next local midnight', () => {
    const r = resolveExportRange({ preset: 'today' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.from).toBe(midnight(2026, 10, 15));
    expect(r.range.to).toBe(midnight(2026, 10, 16));
    expect([r.range.firstDay, r.range.lastDay]).toEqual(['2026-10-15', '2026-10-15']);
  });

  it('last 7 days is today and the six days before it', () => {
    const r = resolveExportRange({ preset: 'last7' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.from).toBe(midnight(2026, 10, 9));
    expect(r.range.to).toBe(midnight(2026, 10, 16));
    expect(r.range.firstDay).toBe('2026-10-09');
  });

  it('last 30 days crosses a month boundary correctly', () => {
    const r = resolveExportRange({ preset: 'last30' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.firstDay).toBe('2026-09-16');
    expect(r.range.lastDay).toBe('2026-10-15');
    expect(r.range.from).toBe(midnight(2026, 9, 16));
  });

  it('this month runs from the 1st through today', () => {
    const r = resolveExportRange({ preset: 'thisMonth' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.from).toBe(midnight(2026, 10, 1));
    expect(r.range.to).toBe(midnight(2026, 10, 16));
  });

  it('uses the local day even just after midnight', () => {
    const r = resolveExportRange({ preset: 'today' }, new Date(2026, 9, 15, 0, 0, 1));
    if (!r.ok) throw new Error(r.error);
    expect(r.range.firstDay).toBe('2026-10-15');
  });

  it('custom range includes both end days', () => {
    const r = resolveExportRange({ preset: 'custom', from: '2026-01-31', to: '2026-02-02' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.from).toBe(midnight(2026, 1, 31));
    expect(r.range.to).toBe(midnight(2026, 2, 3));
  });

  it('a one-day custom range is that day', () => {
    const r = resolveExportRange({ preset: 'custom', from: '2024-02-29', to: '2024-02-29' }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.range.to).toBe(midnight(2024, 3, 1));
  });

  it('refuses reversed, missing and impossible custom dates', () => {
    expect(resolveExportRange({ preset: 'custom', from: '2026-10-10', to: '2026-10-01' }, NOW)).toMatchObject({ ok: false });
    expect(resolveExportRange({ preset: 'custom', from: '2026-10-10', to: null }, NOW)).toMatchObject({ ok: false });
    expect(resolveExportRange({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW)).toMatchObject({ ok: false });
    expect(resolveExportRange({ preset: 'custom', from: '15/10/2026', to: '2026-10-15' }, NOW)).toMatchObject({ ok: false });
  });

  it('a day boundary stays on local midnight across a daylight-saving change', () => {
    // Whatever the machine's zone, every boundary is a local midnight.
    const r = resolveExportRange({ preset: 'custom', from: '2026-03-01', to: '2026-11-30' }, NOW);
    if (!r.ok) throw new Error(r.error);
    for (const iso of [r.range.from!, r.range.to!]) {
      const d = new Date(iso);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    }
  });
});

describe('parseLocalDay', () => {
  it('accepts real dates and refuses others', () => {
    expect(parseLocalDay('2026-10-15')?.getDate()).toBe(15);
    expect(parseLocalDay('2026-13-01')).toBeNull();
    expect(parseLocalDay('1969-12-31')).toBeNull();
    expect(parseLocalDay('2026-1-5')).toBeNull();
  });
});

describe('parseExportRequest — IPC validation', () => {
  const valid = { categories: ['events', 'timeline'], range: { preset: 'last7' }, format: 'csv' };

  it('accepts a valid request and orders categories canonically', () => {
    const r = parseExportRequest(valid);
    expect(r).toEqual({ ok: true, request: { categories: ['timeline', 'events'], range: { preset: 'last7' }, format: 'csv' } });
  });

  it('dedupes categories', () => {
    const r = parseExportRequest({ ...valid, categories: ['focus', 'focus'] });
    expect(r.ok && r.request.categories).toEqual(['focus']);
  });

  it('refuses any field it does not know — a request can never carry a path', () => {
    expect(parseExportRequest({ ...valid, filePath: 'C:\\Windows\\System32\\x.zip' }).ok).toBe(false);
    expect(parseExportRequest({ ...valid, range: { preset: 'all', path: '..\\..' } }).ok).toBe(false);
  });

  it('refuses unknown categories, formats and presets', () => {
    expect(parseExportRequest({ ...valid, categories: ['secrets'] }).ok).toBe(false);
    expect(parseExportRequest({ ...valid, categories: [] }).ok).toBe(false);
    expect(parseExportRequest({ ...valid, format: 'xlsx' }).ok).toBe(false);
    expect(parseExportRequest({ ...valid, range: { preset: 'forever' } }).ok).toBe(false);
    expect(parseExportRequest(null).ok).toBe(false);
    expect(parseExportRequest('timeline').ok).toBe(false);
  });

  it('keeps custom days only for a custom range', () => {
    const custom = parseExportRequest({ ...valid, range: { preset: 'custom', from: '2026-10-01', to: '2026-10-02' } });
    expect(custom.ok && custom.request.range).toEqual({ preset: 'custom', from: '2026-10-01', to: '2026-10-02' });
    const preset = parseExportRequest({ ...valid, range: { preset: 'today', from: '2026-10-01', to: '2026-10-02' } });
    expect(preset.ok && preset.request.range).toEqual({ preset: 'today' });
    expect(parseExportRequest({ ...valid, range: { preset: 'custom', from: 20261001, to: '2026-10-02' } }).ok).toBe(false);
  });
});

describe('formats and file names', () => {
  it('writes CSV only where it is faithful', () => {
    expect(categoryFormat('timeline', 'csv')).toBe('csv');
    expect(categoryFormat('reflection', 'csv')).toBe('json');
    expect(categoryFormat('personalization', 'csv')).toBe('json');
  });

  it('focus as CSV is three tables', () => {
    expect(categoryFileNames('focus', 'csv')).toEqual(['focus-sessions.csv', 'focus-interruptions.csv', 'focus-blocked-attempts.csv']);
    expect(categoryFileNames('focus', 'json')).toEqual(['focus-sessions.json']);
  });

  it('a single file for one single-file category, otherwise a ZIP', () => {
    expect(isSingleFileExport({ categories: ['timeline'], format: 'csv' })).toBe(true);
    expect(isSingleFileExport({ categories: ['focus'], format: 'csv' })).toBe(false);
    expect(isSingleFileExport({ categories: ['timeline', 'events'], format: 'json' })).toBe(false);
  });

  it('suggests dated names', () => {
    expect(suggestedExportFileName({ categories: ['timeline'], format: 'csv' }, NOW)).toBe('reflect-timeline-2026-10-15.csv');
    expect(suggestedExportFileName({ categories: ['reflection'], format: 'csv' }, NOW)).toBe('reflect-reflection-coach-2026-10-15.json');
    expect(suggestedExportFileName({ categories: [...EXPORT_CATEGORIES], format: 'json' }, NOW)).toBe('reflect-export-2026-10-15.zip');
  });
});
