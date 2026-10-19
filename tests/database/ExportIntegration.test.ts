import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { EditRepository } from '../../src/database/EditRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import { ReflectionRepository } from '../../src/database/ReflectionRepository';
import { CoachRepository } from '../../src/database/CoachRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { BackgroundRepository } from '../../src/database/BackgroundRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ExportService } from '../../src/service/ExportService';
import { EXPORT_CATEGORIES } from '../../src/export/ExportModels';
import { unzip } from '../export/helpers';

/**
 * The export over real SQLite, wired like main.ts. Self-skips when the native
 * binary is built for Electron's ABI (run with `npm run test:db`).
 */
const nativeOk = (() => {
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();
const suite = nativeOk ? describe : describe.skip;

const MIN = '0000-01-01T00:00:00.000Z';
const MAX = '9999-12-31T23:59:59.999Z';
const iso = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

suite('Export (integration, real SQLite)', () => {
  let dir: string;
  let db: Database;
  let events: EventRepository;
  let categorizationRepo: CategorizationRepository;
  let service: ExportService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-export-'));
    db = new Database(path.join(dir, 'test.db'));
    events = new EventRepository(db);
    const activityRules = new ActivityRuleRepository(db);
    categorizationRepo = new CategorizationRepository(db);
    const focus = new FocusRepository(db);
    const aiSource = new IntelligenceTimelineSource(new IntelligenceRepository(db));
    const categorization = new CategorizationService(activityRules, categorizationRepo, focus, events, aiSource);
    const timeline = new TimelineService(new SessionService(events), new EditRepository(db), activityRules, categorization, aiSource);
    service = new ExportService({
      events,
      timeline,
      activities: activityRules,
      categorization: categorizationRepo,
      focus,
      reflection: new ReflectionRepository(db),
      coach: new CoachRepository(db),
      profile: new UserProfileRepository(db),
      appSettings: new BackgroundRepository(db),
      appVersion: 'test',
      now: () => new Date(2026, 9, 15, 12),
      pageSize: 50,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Every row of every table, for a before/after comparison. */
  function snapshot(): string {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort()]));
  }

  it('pages through events in order, leaving out hidden ones', () => {
    const ids: number[] = [];
    for (let i = 0; i < 120; i++) {
      // Several events share a start time: paging must neither skip nor repeat them.
      const at = iso(2026, 10, 1, 9, Math.floor(i / 3));
      ids.push(events.insert({ watcher: 'window', startedAt: at, endedAt: at, title: `t${i}` }));
    }
    events.hide([ids[5], ids[60]], new Date().toISOString());

    const seen: number[] = [];
    let after: { startedAt: string; id: number } | null = null;
    for (;;) {
      const page = events.getPageAscending(MIN, MAX, after, 50);
      seen.push(...page.map((e) => e.id));
      if (page.length < 50) break;
      after = { startedAt: page[49].startedAt, id: page[49].id };
    }
    expect(seen).toEqual(ids.filter((id) => id !== ids[5] && id !== ids[60]));
    expect(events.countStartedInRange(MIN, MAX)).toBe(118);
  });

  it('exporting everything changes nothing in the database', async () => {
    for (let d = 1; d <= 40; d++) {
      const start = iso(2026, 9, d > 30 ? d - 30 : d, 9);
      events.insert({ watcher: 'window', startedAt: start, endedAt: new Date(Date.parse(start) + 600_000).toISOString(), app: 'Code', title: `day ${d}` });
    }
    const id = events.insert({ watcher: 'window', startedAt: iso(2026, 10, 14, 9), endedAt: iso(2026, 10, 14, 10), app: 'Chrome', title: 'Hidden one' });
    events.hide([id], new Date().toISOString());
    const before = snapshot();

    for (const format of ['json', 'csv'] as const) {
      const file = path.join(dir, `all-${format}.zip`);
      await service.write({ categories: [...EXPORT_CATEGORIES], range: { preset: 'all' }, format }, file);
      const files = unzip(fs.readFileSync(file));
      for (const content of files.values()) expect(content.toString('utf8')).not.toContain('Hidden one');
    }
    service.preview({ categories: [...EXPORT_CATEGORIES], range: { preset: 'last30' }, format: 'json' });

    expect(snapshot()).toBe(before);
  });

  it('per-event classifications of hidden events are not exported', () => {
    const a = events.insert({ watcher: 'window', startedAt: iso(2026, 10, 1, 9), endedAt: iso(2026, 10, 1, 10) });
    const b = events.insert({ watcher: 'window', startedAt: iso(2026, 10, 1, 10), endedAt: iso(2026, 10, 1, 11) });
    for (const eventId of [a, b]) {
      categorizationRepo.saveEventClassification({ eventId, contextId: null, areaId: null, intentId: null, qualityId: null, source: 'manual' as never, ruleId: null });
    }
    events.hide([b], new Date().toISOString());
    expect(categorizationRepo.listEventClassifications().map((c) => c.eventId)).toEqual([a]);
  });

  it('reflections are those whose period overlaps the range; superseded attempts are left out', () => {
    const insert = db.prepare(
      `INSERT INTO reflection_reports (id, period_type, period_key, period_start, period_end, status, input_schema_version, output_schema_version, prompt_version, model, created_at, updated_at)
       VALUES (@id, @type, @key, @start, @end, @status, 1, 1, 'p', 'm', @start, @start)`,
    );
    insert.run({ id: 'd14', type: 'day', key: '2026-10-14', start: iso(2026, 10, 14), end: iso(2026, 10, 15), status: 'fresh' });
    insert.run({ id: 'd14-old', type: 'day', key: '2026-10-14', start: iso(2026, 10, 14), end: iso(2026, 10, 15), status: 'superseded' });
    insert.run({ id: 'month', type: 'month', key: '2026-10', start: iso(2026, 10, 1), end: iso(2026, 11, 1), status: 'stale' });
    insert.run({ id: 'd01', type: 'day', key: '2026-10-01', start: iso(2026, 10, 1), end: iso(2026, 10, 2), status: 'fresh' });
    const repo = new ReflectionRepository(db);
    expect(repo.listCurrentReportsOverlapping(iso(2026, 10, 14), iso(2026, 10, 15)).map((r) => r.id)).toEqual(['month', 'd14']);
    expect(repo.countCurrentReportsOverlapping(iso(2026, 10, 2), iso(2026, 10, 14))).toBe(1);
  });
});
