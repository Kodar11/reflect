import { describe, it, expect, afterEach } from 'vitest';
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
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { PrototypeUserContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceService } from '../../src/intelligence/IntelligenceService';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ScriptedGemini, modelActivity, modelOutput } from '../intelligence/helpers';

/**
 * End-to-end over real SQLite, wired exactly like `main.ts`:
 *   raw events → preprocess → (scripted) Gemini → validate → persist → timeline.
 * Self-skips if the native binary ABI does not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pipeline-probe-')), 'probe.db');
    new Database(p).close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
  }
})();

const suite = nativeOk ? describe : describe.skip;
const iso = (hhmm: string) => `2026-03-02T${hhmm}:00.000Z`;

function wire(dbPath: string, gemini: ScriptedGemini) {
  const db = new Database(dbPath);
  const events = new EventRepository(db);
  const activityRules = new ActivityRuleRepository(db);
  const categorizationRepo = new CategorizationRepository(db);
  const focus = new FocusRepository(db);
  const intelligenceRepo = new IntelligenceRepository(db);
  const aiSource = new IntelligenceTimelineSource(intelligenceRepo);
  const categorization = new CategorizationService(activityRules, categorizationRepo, focus, events, aiSource);
  const timeline = new TimelineService(new SessionService(events), new EditRepository(db), activityRules, categorization, aiSource);
  const service = new IntelligenceService({
    events,
    repo: intelligenceRepo,
    gemini,
    activityRules,
    categorization: categorizationRepo,
    focus,
    userContext: new PrototypeUserContextProvider(),
    getUserEditedEventIds: (from, to) => timeline.getUserEditedEventIds(from, to),
    now: () => new Date(iso('12:00')),
    sleep: async () => {},
  });
  return { db, events, timeline, service, intelligenceRepo, categorization };
}

suite('Intelligence pipeline (SQLite, end to end)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('analyses a window, persists across restart, continues next hour, and honours user edits', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pipeline-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    let app = wire(dbPath, gemini);

    const e1 = app.events.insert({ watcher: 'window', startedAt: iso('09:00'), endedAt: iso('09:20'), app: 'Code.exe', title: 'GeminiClient.ts - reflect - Visual Studio Code' });
    const e2 = app.events.insert({ watcher: 'window', startedAt: iso('09:20'), endedAt: iso('09:35'), app: 'Google Chrome', browser: 'Chrome', url: 'ai.google.dev', title: 'Structured output' });
    const e3 = app.events.insert({ watcher: 'window', startedAt: iso('09:35'), endedAt: iso('09:58'), app: 'Code.exe', title: 'IntelligenceService.ts - reflect - Visual Studio Code' });
    const e4 = app.events.insert({ watcher: 'window', startedAt: iso('10:00'), endedAt: iso('10:40'), app: 'Code.exe', title: 'IntelligenceScheduler.ts - reflect - Visual Studio Code' });
    const rawBefore = app.events.getAll();
    const dayFrom = iso('00:00');
    const dayTo = '2026-03-03T00:00:00.000Z';

    // Before any analysis: deterministic fallback only.
    expect(app.timeline.getByRange(dayFrom, dayTo).every((s) => s.ai === undefined)).toBe(true);

    gemini.push(modelOutput([modelActivity({ eventIds: [e1, e2, e3], startedAt: iso('09:00'), endedAt: iso('09:58') })], [], [iso('09:00'), iso('10:00')]));
    const first = await app.service.analyzeWindow(iso('09:00'), iso('10:00'));
    expect(first).toMatchObject({ status: 'succeeded', activitiesCreated: 1 });
    // Seeded system rules are not presented as user rules; the seeded taxonomy is.
    expect(gemini.requests[0].prompt).toContain('The user has not defined any personal rules.');
    expect(gemini.requests[0].prompt).toContain('{"id":"area_work","name":"Work"}');
    expect(gemini.requests[0].prompt).toContain('"app":"VS Code"');

    // ── restart ──
    app.db.close();
    app = wire(dbPath, gemini);

    let blocks = app.timeline.getByRange(dayFrom, dayTo);
    expect(blocks.map((s) => s.events.map((e) => e.id))).toEqual([[e1, e2, e3], [e4]]);
    expect(blocks[0].ai?.title).toBe('Implement Reflect Gemini integration');
    expect(blocks[0].classification).toMatchObject({ source: 'ai', area: { id: 'area_work', name: 'Work' } });
    expect(blocks[1].ai).toBeUndefined(); // 10:00 hour not analysed yet → deterministic
    const activityId = blocks[0].id;

    // Already analysed → no second Gemini call after the restart.
    expect((await app.service.analyzeWindow(iso('09:00'), iso('10:00'))).status).toBe('skipped');
    expect(gemini.requests).toHaveLength(1);

    // ── next hour continues the same activity ──
    gemini.push(
      modelOutput(
        [modelActivity({ eventIds: [e4], continuationOfActivityId: activityId, startedAt: iso('10:00'), endedAt: iso('10:40') })],
        [],
        [iso('10:00'), iso('11:00')],
      ),
    );
    expect(await app.service.analyzeWindow(iso('10:00'), iso('11:00'))).toMatchObject({ status: 'succeeded', activitiesExtended: 1, activitiesCreated: 0 });
    blocks = app.timeline.getByRange(dayFrom, dayTo);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(activityId);
    expect(blocks[0].events.map((e) => e.id)).toEqual([e1, e2, e3, e4]);

    // ── user correction wins and survives a forced re-analysis ──
    app.categorization.saveOverride([e1, e2, e3, e4], { contextId: 'learning', areaId: 'area_personal', intentId: 'intent_learn', qualityId: null }, false);
    gemini.push(modelOutput([modelActivity({ eventIds: [e1, e2, e3], title: 'Different idea', endedAt: iso('09:58') })], [], [iso('09:00'), iso('10:00')]));
    expect((await app.service.analyzeWindow(iso('09:00'), iso('10:00'), { force: true })).status).toBe('succeeded');

    blocks = app.timeline.getByRange(dayFrom, dayTo);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ai).toMatchObject({ title: 'Implement Reflect Gemini integration', userLocked: true });
    expect(blocks[0].classification).toMatchObject({ source: 'user_override', area: { id: 'area_personal' } });

    // Raw facts are byte-for-byte what the tracker stored.
    expect(app.events.getAll()).toEqual(rawBefore);
    app.db.close();
  });
});
