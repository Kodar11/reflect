import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_CATEGORIES, type ExportRequest } from '../../src/export/ExportModels';
import { ExportRangeError, monthChunks } from '../../src/service/ExportService';
import { SECRET_KEY, local, makeHarness, parseCsv, tempDir, unzip, type Harness } from './helpers';

const req = (r: Partial<ExportRequest> & Pick<ExportRequest, 'categories'>): ExportRequest => ({
  range: { preset: 'all' },
  format: 'json',
  ...r,
});

let dir: string;
let h: Harness;

beforeEach(() => {
  dir = tempDir();
  h = makeHarness();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function exportJson(request: ExportRequest, name = 'out.json') {
  const file = path.join(dir, name);
  await h.service.write(request, file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function exportText(request: ExportRequest, name: string) {
  const file = path.join(dir, name);
  await h.service.write(request, file);
  return fs.readFileSync(file, 'utf8');
}

async function exportZip(request: ExportRequest) {
  const file = path.join(dir, 'out.zip');
  const result = await h.service.write(request, file);
  return { files: unzip(fs.readFileSync(file)), result };
}

describe('Timeline', () => {
  it('exports verified blocks with the user’s titles and notes applied', async () => {
    const a = h.events.add({ startedAt: local(2026, 10, 14, 9), endedAt: local(2026, 10, 14, 9, 30), app: 'Code', title: 'export.ts' });
    h.events.add({ startedAt: local(2026, 10, 14, 15), endedAt: local(2026, 10, 14, 15, 20), app: 'Chrome', title: 'Docs' });
    h.edits.insert('rename', { anchorEventId: a.id, newTitle: 'Build the export' });
    h.edits.insert('note', { eventIds: [a.id], note: 'Went well' });

    const doc = await exportJson(req({ categories: ['timeline'] }));
    expect(doc.category).toBe('timeline');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.records).toHaveLength(2);
    expect(doc.records[0]).toMatchObject({ title: 'Build the export', isCustomTitle: true, note: 'Went well', primaryApp: 'Code', eventIds: [a.id] });
    expect(doc.records[1].primaryApp).toBe('Chrome');
  });

  it('includes the complete history — every month, not only what is on screen', async () => {
    for (let month = 1; month <= 12; month++) {
      h.events.add({ startedAt: local(2025, month, 10, 10), endedAt: local(2025, month, 10, 10, 15), title: `m${month}` });
    }
    h.events.add({ startedAt: local(2026, 10, 15, 8), endedAt: local(2026, 10, 15, 8, 5), title: 'today' });
    const doc = await exportJson(req({ categories: ['timeline'] }));
    expect(doc.records.map((r: { primaryTitle: string }) => r.primaryTitle)).toEqual([...Array.from({ length: 12 }, (_, i) => `m${i + 1}`), 'today']);
    expect(h.pauses.count).toBeGreaterThan(10); // one pause per month rebuilt
  });

  it('a block the user added by hand appears once, in its own month, even outside tracked history', async () => {
    h.events.add({ startedAt: local(2026, 9, 1, 10), endedAt: local(2026, 9, 1, 11) });
    h.edits.insert('create_offline', { startedAt: local(2026, 10, 2, 9), endedAt: local(2026, 10, 2, 10), title: 'Gym' });
    h.edits.insert('create_offline', { startedAt: local(2020, 1, 1, 9), endedAt: local(2020, 1, 1, 10), title: 'Old offline' });

    const all = await exportJson(req({ categories: ['timeline'] }), 'all.json');
    expect(all.records.map((r: { title: string; source: string }) => `${r.source}:${r.title}`)).toEqual(['user:Old offline', 'generated:Untitled', 'user:Gym']);

    const sept = await exportJson(req({ categories: ['timeline'], range: { preset: 'custom', from: '2026-09-01', to: '2026-09-30' } }), 'sept.json');
    expect(sept.records.map((r: { source: string }) => r.source)).toEqual(['generated']);
  });

  it('writes a spreadsheet-safe CSV', async () => {
    h.events.add({ startedAt: local(2026, 10, 14, 9), endedAt: local(2026, 10, 14, 9, 30), app: 'Excel', title: '=cmd|"/c calc"!A1, "quoted"\nnext' });
    const text = await exportText(req({ categories: ['timeline'], format: 'csv' }), 'timeline.csv');
    expect(text.startsWith('﻿')).toBe(true);
    const rows = parseCsv(text.slice(1));
    expect(rows[0][0]).toBe('title');
    const titleCol = rows[0].indexOf('primary_title');
    expect(rows[1][titleCol]).toBe(`'=cmd|"/c calc"!A1, "quoted"\nnext`);
    expect(rows[1][rows[0].indexOf('start_local')]).toBe('2026-10-14 09:00:00');
    expect(rows[1][rows[0].indexOf('duration_seconds')]).toBe('1800');
  });
});

describe('Raw activity events', () => {
  it('pages through every event in order, past any fixed limit', async () => {
    h = makeHarness({ pageSize: 100 });
    for (let i = 0; i < 2500; i++) {
      const start = new Date(2026, 0, 1, 0, 0, i * 30);
      h.events.add({ startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 20_000).toISOString(), title: `t${i}` });
    }
    const doc = await exportJson(req({ categories: ['events'] }));
    expect(doc.records).toHaveLength(2500);
    expect(doc.records[0].title).toBe('t0');
    expect(doc.records[2499].title).toBe('t2499');
    expect(new Set(doc.records.map((r: { id: number }) => r.id)).size).toBe(2500);
    expect(h.events.pageCalls).toBe(26);
    expect(h.pauses.count).toBeGreaterThanOrEqual(25);
  });

  it('includes boundary records exactly: start of the first day in, start of the day after out', async () => {
    h.events.add({ startedAt: local(2026, 10, 9, 23, 59, 59), endedAt: local(2026, 10, 10, 0, 0, 30), title: 'before' });
    h.events.add({ startedAt: local(2026, 10, 10), endedAt: local(2026, 10, 10, 0, 1), title: 'first instant' });
    h.events.add({ startedAt: local(2026, 10, 12, 23, 59, 59), endedAt: local(2026, 10, 13, 0, 0, 1), title: 'last second' });
    h.events.add({ startedAt: local(2026, 10, 13), endedAt: local(2026, 10, 13, 0, 1), title: 'after' });
    const doc = await exportJson(req({ categories: ['events'], range: { preset: 'custom', from: '2026-10-10', to: '2026-10-12' } }));
    expect(doc.records.map((r: { title: string }) => r.title)).toEqual(['first instant', 'last second']);
    expect(doc.range).toMatchObject({ preset: 'custom', firstDay: '2026-10-10', lastDay: '2026-10-12' });
  });

  it('keeps structured payloads as JSON and CSV text faithful', async () => {
    h.events.add({ startedAt: local(2026, 10, 14, 9), endedAt: local(2026, 10, 14, 9, 1), title: 'Résumé, “final” — 日本語', url: 'https://x.test/?q=a,b', payload: '{"tab":3}' });
    const doc = await exportJson(req({ categories: ['events'] }));
    expect(doc.records[0]).toMatchObject({ title: 'Résumé, “final” — 日本語', payload: { tab: 3 }, durationMs: 60_000 });
    const rows = parseCsv((await exportText(req({ categories: ['events'], format: 'csv' }), 'e.csv')).slice(1));
    expect(rows[1][rows[0].indexOf('title')]).toBe('Résumé, “final” — 日本語');
    expect(rows[1][rows[0].indexOf('url')]).toBe('https://x.test/?q=a,b');
  });
});

describe('Focus sessions', () => {
  const session = (id: string, startedAt: string | null) => ({
    id,
    profileId: 'p1',
    task: `Task ${id}`,
    notes: null,
    mode: 'countdown' as const,
    plannedDurationMinutes: 25,
    state: 'completed' as const,
    startedAt,
    endedAt: startedAt,
    pausedAt: null,
    totalPauseMs: 60_000,
    elapsedMs: 1_440_000,
    blockingLeaseId: 'lease-internal',
    endReason: 'completed' as const,
    endNote: null,
    blockingConfig: null,
    createdAt: startedAt ?? local(2026, 10, 1),
    updatedAt: startedAt ?? local(2026, 10, 1),
  });

  beforeEach(() => {
    h = makeHarness({
      focus: {
        ...makeHarness().deps.focus,
        getProfiles: () => [{ id: 'p1', name: 'Deep Work' } as never],
        getSessionsByRange: () => [session('b', local(2026, 10, 14, 10)), session('a', local(2026, 10, 2, 10)), session('planned', null)],
        getInterruptions: (id: string) =>
          id === 'a' ? [{ id: 'i1', sessionId: 'a', type: 'pause' as const, reason: 'call', occurredAt: local(2026, 10, 2, 10, 5), idleMs: null, createdAt: local(2026, 10, 2, 10, 5) }] : [],
        getBlockedAttempts: (id: string) =>
          id === 'b' ? [{ id: 'x1', sessionId: 'b', type: 'website' as const, target: 'youtube.com', attemptedAt: local(2026, 10, 14, 10, 3), createdAt: local(2026, 10, 14, 10, 3) }] : [],
      },
    });
  });

  it('exports started sessions with their details, oldest first', async () => {
    const doc = await exportJson(req({ categories: ['focus'] }));
    expect(doc.records.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(doc.records[0]).toMatchObject({ task: 'Task a', profile: { id: 'p1', name: 'Deep Work' }, activeMs: 1_440_000, interruptions: [{ type: 'pause', reason: 'call' }] });
    expect(doc.records[1].blockedAttempts[0].target).toBe('youtube.com');
    expect(JSON.stringify(doc)).not.toContain('lease-internal');
  });

  it('as CSV, writes three linked tables in a ZIP', async () => {
    const { files } = await exportZip(req({ categories: ['focus'], format: 'csv' }));
    expect([...files.keys()]).toEqual(['focus-sessions.csv', 'focus-interruptions.csv', 'focus-blocked-attempts.csv', 'manifest.json']);
    const sessions = parseCsv(files.get('focus-sessions.csv')!.toString('utf8').slice(1));
    expect(sessions).toHaveLength(3);
    expect(sessions[1][sessions[0].indexOf('profile')]).toBe('Deep Work');
    const interruptions = parseCsv(files.get('focus-interruptions.csv')!.toString('utf8').slice(1));
    expect(interruptions[1].slice(0, 3)).toEqual(['a', 'pause', 'call']);
  });
});

describe('Reflection & Coach', () => {
  it('exports reports, Coach actions with history, messages, priorities and memory — not internal errors', async () => {
    h = makeHarness({
      reflection: {
        listCurrentReportsOverlapping: () => [{ id: 'r1', headline: 'A focused day', insights: [{ id: 'i1', feedback: 'useful' }], error: 'internal', errorCategory: 'api' } as never],
        countCurrentReportsOverlapping: () => 1,
        listPriorities: () => [{ id: 'p1', text: 'Ship the export', history: [] } as never],
      },
      coach: {
        ...makeHarness().deps.coach,
        listActions: () => [
          { id: 'c2', title: 'Later', createdAt: local(2026, 10, 14) } as never,
          { id: 'c1', title: 'Earlier', createdAt: local(2026, 10, 13) } as never,
          { id: 'c0', title: 'Out of range', createdAt: local(2026, 9, 1) } as never,
        ],
        listActionEvents: (id: string) => [{ id: `e-${id}`, type: 'accepted' } as never],
        listMessages: () => [{ id: 'm1', role: 'user', text: 'hello', meta: null, createdAt: local(2026, 10, 14, 9) }],
        listMemories: () => [{ id: 'mem1', text: 'Prefers mornings' } as never],
      },
    });
    const doc = await exportJson(req({ categories: ['reflection'], range: { preset: 'last7' } }));
    expect(doc.reports).toEqual([{ id: 'r1', headline: 'A focused day', insights: [{ id: 'i1', feedback: 'useful' }] }]);
    expect(doc.coachActions.map((a: { id: string }) => a.id)).toEqual(['c1', 'c2']);
    expect(doc.coachActions[0].history).toEqual([{ id: 'e-c1', type: 'accepted' }]);
    expect(doc.coachMessages).toHaveLength(1);
    expect(doc.priorities[0].text).toBe('Ship the export');
    expect(doc.coachMemory[0].text).toBe('Prefers mornings');
    expect(doc.note).toMatch(/as they are now/);
  });

  it('is always JSON, even when CSV is chosen', async () => {
    const text = await exportText(req({ categories: ['reflection'], format: 'csv' }), 'r.json');
    expect(JSON.parse(text).category).toBe('reflection');
  });
});

describe('Personalization & rules', () => {
  it('exports the current configuration, not filtered by date', async () => {
    h = makeHarness({
      activities: {
        listActivities: () => [{ id: 'ctx', name: 'Work', color: '#000' }],
        listRules: () => [{ id: 'r', activityId: 'ctx', conditions: '[{"field":"app","op":"eq","value":"Code"}]', enabled: 1, priority: 0, areaId: null, intentId: null, qualityId: null }],
      },
    });
    const doc = await exportJson(req({ categories: ['personalization'], range: { preset: 'today' } }));
    expect(doc.range).toBeNull();
    expect(doc.profile.priorities).toEqual(['Ship the export']);
    expect(doc.classification.rules[0].conditions).toEqual([{ field: 'app', op: 'eq', value: 'Code' }]);
    expect(doc.preferences).toMatchObject({ dailyReflectionTime: '22:00', dayStartsAt: '00:00', notifications: true });
    expect(doc.preferences).not.toHaveProperty('widgetPosition');
  });
});

describe('Whole exports', () => {
  it('a multi-category export is a ZIP with a manifest describing it', async () => {
    h.events.add({ startedAt: local(2026, 10, 14, 9), endedAt: local(2026, 10, 14, 9, 30) });
    const { files, result } = await exportZip(req({ categories: [...EXPORT_CATEGORIES], range: { preset: 'last30' }, format: 'csv' }));
    expect(result.files).toEqual([
      'timeline.csv',
      'activity-events.csv',
      'focus-sessions.csv',
      'focus-interruptions.csv',
      'focus-blocked-attempts.csv',
      'reflection-coach.json',
      'personalization.json',
      'manifest.json',
    ]);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'reflect-export',
      schemaVersion: 1,
      app: { name: 'Reflect', version: '0.1.0-test' },
      requestedFormat: 'csv',
      range: { preset: 'last30', firstDay: '2026-09-16', lastDay: '2026-10-15' },
      recordCounts: { timeline: 1, events: 1, focus: 0 },
    });
    expect(manifest.categories.find((c: { id: string }) => c.id === 'reflection')).toMatchObject({ format: 'json', filteredByDate: 'partial' });
  });

  it('never contains API keys or credentials', async () => {
    // Even if a secret were somewhere near the data, nothing reads it: the
    // export has no dependency that can reach the key store.
    process.env.GEMINI_API_KEY = SECRET_KEY;
    try {
      h.events.add({ startedAt: local(2026, 10, 14, 9), endedAt: local(2026, 10, 14, 9, 30) });
      const { files } = await exportZip(req({ categories: [...EXPORT_CATEGORIES] }));
      for (const [name, content] of files) {
        expect(content.toString('utf8'), name).not.toContain(SECRET_KEY);
        expect(content.toString('utf8'), name).not.toMatch(/apiKey|api_key|GEMINI_API_KEY/i);
      }
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('handles an empty range gracefully: valid files with no records', async () => {
    const { files } = await exportZip(req({ categories: ['timeline', 'events'], range: { preset: 'today' } }));
    expect(JSON.parse(files.get('timeline.json')!.toString('utf8')).records).toEqual([]);
    expect(JSON.parse(files.get('activity-events.json')!.toString('utf8')).records).toEqual([]);
    const csv = await exportText(req({ categories: ['events'], format: 'csv', range: { preset: 'today' } }), 'empty.csv');
    expect(parseCsv(csv.slice(1))).toHaveLength(1); // header only
  });

  it('produces the same content for the same data (deterministic order)', async () => {
    for (let i = 0; i < 20; i++) h.events.add({ startedAt: local(2026, 10, 14, 9, 0, 59 - i), endedAt: local(2026, 10, 14, 9, 1, 59 - i), title: `t${i}` });
    const a = await exportText(req({ categories: ['events', 'timeline'] }), 'a.zip');
    const b = await exportText(req({ categories: ['events', 'timeline'] }), 'b.zip');
    expect(a).toBe(b);
  });

  it('a failure leaves nothing behind — no partial file, no temp file', async () => {
    h = makeHarness({
      events: { getPageAscending: () => { throw new Error('disk read failed'); }, countStartedInRange: () => 0, getFirstEventStart: () => null },
    });
    const file = path.join(dir, 'broken.json');
    await expect(h.service.write(req({ categories: ['events'] }), file)).rejects.toThrow('disk read failed');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('replaces an existing file only once the new export is complete', async () => {
    const file = path.join(dir, 'existing.json');
    fs.writeFileSync(file, 'old');
    await h.service.write(req({ categories: ['personalization'] }), file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).category).toBe('personalization');
    expect(fs.readdirSync(dir)).toEqual(['existing.json']);
  });

  it('refuses an invalid custom range', async () => {
    await expect(
      h.service.write(req({ categories: ['events'], range: { preset: 'custom', from: '2026-10-10', to: '2026-10-01' } }), path.join(dir, 'x.json')),
    ).rejects.toBeInstanceOf(ExportRangeError);
  });

  it('does not block: the work is spread across event-loop turns', async () => {
    h = makeHarness({ pageSize: 10, pause: undefined });
    for (let i = 0; i < 200; i++) h.events.add({ startedAt: new Date(2026, 0, 1, 0, i).toISOString(), endedAt: new Date(2026, 0, 1, 0, i, 30).toISOString() });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    await h.service.write(req({ categories: ['events'] }), path.join(dir, 'e.json'));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('preview', () => {
  it('counts what will be exported, exactly', () => {
    h.events.add({ startedAt: local(2026, 10, 15, 9), endedAt: local(2026, 10, 15, 9, 5) });
    h.events.add({ startedAt: local(2026, 10, 1, 9), endedAt: local(2026, 10, 1, 9, 5) });
    const p = h.service.preview(req({ categories: ['timeline', 'events', 'personalization'], range: { preset: 'today' } }));
    expect(p).toMatchObject({
      ok: true,
      fileName: 'reflect-export-2026-10-15.zip',
      estimates: [{ category: 'timeline', sourceEvents: 1 }, { category: 'events', events: 1 }, { category: 'personalization' }],
      empty: false,
    });
  });

  it('reports an empty range', () => {
    const p = h.service.preview(req({ categories: ['events'], range: { preset: 'today' } }));
    expect(p).toMatchObject({ ok: true, empty: true, fileName: 'reflect-activity-events-2026-10-15.json' });
  });

  it('reports an invalid range as an error, not an exception', () => {
    expect(h.service.preview(req({ categories: ['events'], range: { preset: 'custom', from: 'x', to: 'y' } }))).toMatchObject({ ok: false });
  });
});

describe('monthChunks', () => {
  it('cuts at local month starts and covers the range exactly', () => {
    const chunks = monthChunks(new Date(2026, 0, 15), new Date(2026, 2, 3));
    expect(chunks).toEqual([
      { from: new Date(2026, 0, 15).toISOString(), to: new Date(2026, 1, 1).toISOString() },
      { from: new Date(2026, 1, 1).toISOString(), to: new Date(2026, 2, 1).toISOString() },
      { from: new Date(2026, 2, 1).toISOString(), to: new Date(2026, 2, 3).toISOString() },
    ]);
  });
});
