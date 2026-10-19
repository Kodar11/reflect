import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ExportService, type ExportDeps } from '../../src/service/ExportService';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { FakeEditRepository } from '../timeline/FakeEditRepository';
import { crc32 } from '../../src/export/ZipWriter';
import type { Event } from '../../src/models/Event';
import type { IEventRepository } from '../../src/database/EventRepository';

/**
 * An in-memory event store with the same visible-only, range and paging
 * semantics as EventRepository — enough to drive the real SessionService and
 * TimelineService under the export.
 */
export class MemoryEvents implements IEventRepository {
  readonly events: Event[] = [];
  pageCalls = 0;
  private nextId = 1;

  add(e: Partial<Event> & { startedAt: string; endedAt: string }): Event {
    const event: Event = {
      id: this.nextId++,
      watcher: 'window',
      app: 'Code',
      browser: null,
      title: 'Untitled',
      url: null,
      payload: null,
      createdAt: null,
      ...e,
    };
    this.events.push(event);
    return event;
  }

  insert(): number {
    throw new Error('MemoryEvents is read-only in export tests');
  }
  updateEndedAt(): void {
    throw new Error('MemoryEvents is read-only in export tests');
  }
  getToday(): Event[] {
    return [];
  }
  getByRange(from: string, to: string): Event[] {
    return this.events.filter((e) => e.startedAt >= from && e.startedAt < to).sort((a, b) => cmp(b.startedAt, a.startedAt) || b.id - a.id);
  }
  getOverlapping(from: string, to: string): Event[] {
    return this.events.filter((e) => e.startedAt < to && e.endedAt > from).sort((a, b) => cmp(a.startedAt, b.startedAt) || a.id - b.id);
  }
  getByIds(ids: number[]): Event[] {
    return this.events.filter((e) => ids.includes(e.id));
  }
  getAll(limit = 1000): Event[] {
    return [...this.events].sort((a, b) => cmp(b.startedAt, a.startedAt)).slice(0, limit);
  }
  getPageAscending(from: string, to: string, after: { startedAt: string; id: number } | null, limit: number): Event[] {
    this.pageCalls++;
    return this.events
      .filter((e) => e.startedAt >= from && e.startedAt < to)
      .filter((e) => !after || e.startedAt > after.startedAt || (e.startedAt === after.startedAt && e.id > after.id))
      .sort((a, b) => cmp(a.startedAt, b.startedAt) || a.id - b.id)
      .slice(0, limit);
  }
  countStartedInRange(from: string, to: string): number {
    return this.events.filter((e) => e.startedAt >= from && e.startedAt < to).length;
  }
  getFirstEventStart(): string | null {
    return this.events.length ? this.events.map((e) => e.startedAt).sort()[0] : null;
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Local wall-clock time as the stored UTC ISO string. */
export const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).toISOString();

export const SECRET_KEY = 'AIzaSy-THIS-IS-A-FAKE-SECRET-KEY-123456';

export interface Harness {
  events: MemoryEvents;
  edits: FakeEditRepository;
  deps: ExportDeps;
  service: ExportService;
  pauses: { count: number };
}

export function makeHarness(overrides: Partial<ExportDeps> = {}, now = new Date(2026, 9, 15, 12, 0, 0)): Harness {
  const events = new MemoryEvents();
  const edits = new FakeEditRepository();
  const timeline = new TimelineService(new SessionService(events), edits);
  const pauses = { count: 0 };
  const deps: ExportDeps = {
    events,
    timeline,
    activities: { listActivities: () => [], listRules: () => [] },
    categorization: { listDimensions: () => [], listOverrides: () => [], listEventClassifications: () => [] },
    focus: {
      getSessionsByRange: () => [],
      getInterruptions: () => [],
      getBlockedAttempts: () => [],
      getProfiles: () => [],
      getRules: () => [],
      getPreferences: () => ({
        defaultProfileId: null,
        idleAutoPause: true,
        idleThresholdSeconds: 120,
        idleAutoResume: true,
        notifyStart: false,
        notifyIdle: true,
        notifyComplete: true,
        notifyBlocked: true,
      }),
    },
    reflection: { listCurrentReportsOverlapping: () => [], countCurrentReportsOverlapping: () => 0, listPriorities: () => [] },
    coach: {
      listActions: () => [],
      listActionEvents: () => [],
      listMemories: () => [],
      listMessages: () => [],
      getSettings: () => ({ reflectionMinutes: 22 * 60, dayStartMinutes: 0, notifyDailyReflection: true }),
    },
    profile: {
      getProfile: () => ({
        roles: ['Student'],
        description: null,
        currentWork: ['Reflect'],
        priorities: ['Ship the export'],
        interests: [],
        additionalContext: null,
        onboardingStatus: 'completed',
        createdAt: null,
        updatedAt: null,
      }),
    },
    appSettings: {
      getSettings: () => ({ startWithWindows: true, trackingPause: null, widgetEnabled: true, widgetPosition: null, notificationsEnabled: true }),
    },
    appVersion: '0.1.0-test',
    now: () => now,
    pause: async () => {
      pauses.count++;
    },
    ...overrides,
  };
  return { events, edits, deps, service: new ExportService(deps), pauses };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-export-'));
}

/** Read a ZIP back: name → content. Verifies every CRC on the way. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(start, start + compressed);
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    if (content.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(content) !== crc) throw new Error(`crc mismatch for ${name}`);
    out.set(name, content);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Minimal RFC 4180 parser for assertions. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
