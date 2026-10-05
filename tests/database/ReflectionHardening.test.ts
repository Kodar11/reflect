import { describe, it, expect, afterEach } from 'vitest';
import BetterSqliteDB from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { Database } from '../../src/database/Database';
import { EditRepository } from '../../src/database/EditRepository';
import { EventRepository } from '../../src/database/EventRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import { ReflectionRepository } from '../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { createEventLocator, toReflectionActivities } from '../../src/reflection/ReflectionActivities';
import { ReflectionAnnotator } from '../../src/reflection/ReflectionAnnotator';
import { ReflectionHistory } from '../../src/reflection/ReflectionHistory';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG, REFLECTION_OUTPUT_SCHEMA_VERSION, type TaxonomyNames } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionService } from '../../src/reflection/ReflectionService';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ScriptedGemini } from '../intelligence/helpers';

/**
 * The longitudinal guarantees, over real SQLite and the real timeline:
 * evidence that survives regrouping, history that survives a restart, and a
 * database written before any of this existed that still reads correctly.
 *
 * Self-skips if the native binary ABI does not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflect-hard-probe-')), 'probe.db');
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

const local = (day: number, hhmm = '00:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, day, h, m);
};
const iso = (day: number, hhmm = '00:00') => local(day, hhmm).toISOString();
const dayOf = (d: number) => periodContaining('day', local(d, '12:00'));

function wire(dbPath: string, gemini: ScriptedGemini, clock: { now: Date }) {
  const db = new Database(dbPath);
  const events = new EventRepository(db);
  const activityRules = new ActivityRuleRepository(db);
  const categorizationRepo = new CategorizationRepository(db);
  const focus = new FocusRepository(db);
  const intelligenceRepo = new IntelligenceRepository(db);
  const profiles = new UserProfileRepository(db, () => clock.now);
  const aiSource = new IntelligenceTimelineSource(intelligenceRepo);
  const categorization = new CategorizationService(activityRules, categorizationRepo, focus, events, aiSource);
  const timeline = new TimelineService(new SessionService(events), new EditRepository(db), activityRules, categorization, aiSource);
  const reflectionRepo = new ReflectionRepository(db);
  const taxonomy = (): TaxonomyNames => {
    const names = (d: 'area' | 'intent' | 'quality') => Object.fromEntries(categorizationRepo.listDimensionsByType(d).map((x) => [x.id, x.name]));
    return { contexts: Object.fromEntries(activityRules.listActivities().map((a) => [a.id, a.name])), areas: names('area'), intents: names('intent'), qualities: names('quality') };
  };
  /** How many days were derived from the timeline (as opposed to read from the ledger). */
  const derived = { days: 0 };
  const metrics = new ReflectionMetricsService(
    {
      getActivities: (from, to) => {
        derived.days++;
        return toReflectionActivities(timeline.getByRange(from, to), { start: from, end: to });
      },
      focus,
      taxonomy,
      firstEventAt: () => events.getFirstEventStart(),
      locateEvents: createEventLocator(events, timeline),
    },
    reflectionRepo,
    { config: DEFAULT_REFLECTION_CONFIG, now: () => clock.now, yieldToEventLoop: async () => {} },
  );
  const service = new ReflectionService({
    repo: reflectionRepo,
    gemini,
    metrics,
    annotator: new ReflectionAnnotator({ gemini, repo: reflectionRepo, now: () => clock.now }),
    userContext: new UserProfileContextProvider(profiles),
    profiles,
    taxonomy,
    now: () => clock.now,
    sleep: async () => {},
  });

  /** Raw events only: the timeline shows deterministic sessions for them. */
  const track = (day: number, hhmm: string, minutes: number, app: string, title: string) => {
    const start = local(day, hhmm);
    return events.insert({ watcher: 'window', startedAt: start.toISOString(), endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(), app, title, url: null });
  };
  /** What the intelligence layer persists once it has analysed those events: one AI activity owning them. */
  const analyse = (id: string, day: number, eventIds: number[], title: string) => {
    const owned = events.getByIds(eventIds);
    const startedAt = owned.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), owned[0].startedAt);
    const endedAt = owned.reduce((max, e) => (e.endedAt > max ? e.endedAt : max), owned[0].endedAt);
    intelligenceRepo.createRun({ id: `run-${id}`, windowStart: iso(day), windowEnd: iso(day + 1), model: 'test-model', promptVersion: 'test', schemaVersion: 2, nowIso: clock.now.toISOString() });
    intelligenceRepo.commitRun({
      runId: `run-${id}`,
      windowStart: iso(day),
      windowEnd: iso(day + 1),
      model: 'test-model',
      attemptCount: 1,
      outputJson: '{}',
      plan: {
        create: [{ id, startedAt, endedAt, eventIds, title, summary: null, contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused', confidence: 0.9, uncertainty: [] }],
        extend: [],
        detach: [],
        userProtectedEventIds: [],
      },
      nowIso: clock.now.toISOString(),
    });
  };
  const blocks = (day: number) => timeline.getByRange(iso(day), iso(day + 1)).filter((s) => !s.hidden);
  return { db, events, profiles, timeline, service, metrics, reflectionRepo, track, analyse, blocks, derived };
}

const reflection = (period: ReturnType<typeof dayOf>, insights: unknown[] = []) => ({
  schemaVersion: REFLECTION_OUTPUT_SCHEMA_VERSION,
  periodType: period.type,
  periodStart: period.start,
  periodEnd: period.end,
  headline: 'The editor came first, then the browser.',
  insights,
  carryForward: null,
});

suite('Reflection hardening (SQLite, real timeline)', () => {
  let dir: string;
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflect-hard-'));
    return path.join(dir, 'test.db');
  };

  it('1. evidence still points at the same events after the sessions around them are regrouped', async () => {
    const dbPath = open();
    const gemini = new ScriptedGemini();
    const clock = { now: local(13, '09:00') };
    const app = wire(dbPath, gemini, clock);

    // Monday: an hour in the editor (three events), then half an hour in the browser. Not analysed yet.
    const editor = [app.track(12, '09:00', 20, 'VS Code', 'billing.ts'), app.track(12, '09:20', 20, 'VS Code', 'billing.ts'), app.track(12, '09:40', 20, 'VS Code', 'invoice.ts')];
    const browser = [app.track(12, '10:05', 30, 'Chrome', 'Docs')];
    const before = app.blocks(12);
    const editorBlock = before.find((b) => b.events.some((e) => e.id === editor[0]))!;
    expect(editorBlock.id).toMatch(/^s-\d+-\d+$/); // a derived id: first event + event count

    // The day is reflected on; one insight rests on the editor block.
    gemini.push(
      reflection(dayOf(12), [
        {
          type: 'progress',
          title: 'The editor work came first',
          observation: 'You began the day in the editor.',
          interpretation: 'The first block of the day went to one thing.',
          relevance: null,
          metricKeys: [],
          activityRefs: ['a1'],
          priorityIds: [],
          confidence: 0.9,
        },
      ]),
    );
    expect(await app.service.generate(dayOf(12), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', insightCount: 1 });
    const stored = () => app.reflectionRepo.getCurrentReport('day', dayOf(12).key)!.insights[0].evidence[0];
    const evidence = stored();
    const editorEvents = editorBlock.events.map((e) => e.id);
    expect(evidence).toMatchObject({ kind: 'activity', activityId: editorBlock.id, eventIds: editorEvents });
    expect(await app.service.resolveEvidence(evidence)).toMatchObject({ activityId: editorBlock.id });

    // ── Regrouping 1: the intelligence layer analyses the day. The editor events
    // now belong to an AI activity; the deterministic session id is gone.
    app.analyse('ai-billing', 12, editorEvents, 'Implement billing');
    app.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(12), end: iso(13) } });
    const afterAnalysis = app.blocks(12);
    expect(afterAnalysis.map((b) => b.id)).not.toContain(editorBlock.id);

    // The stored report was not rewritten — and its evidence resolves to the block holding the same events.
    expect(stored()).toEqual(evidence);
    const resolved = await app.service.resolveEvidence(evidence);
    expect(resolved).toMatchObject({ activityId: 'ai-billing', start: iso(12, '09:00') });
    expect(afterAnalysis.find((b) => b.id === resolved!.activityId)!.events.map((e) => e.id)).toEqual(expect.arrayContaining(evidence.eventIds!));

    // ── Regrouping 2: the user splits that block on the Timeline. The evidence
    // lands, deterministically, on the half that holds most of its events.
    app.timeline.apply('split', { afterEventId: editorEvents[editorEvents.length - 2] });
    app.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(12), end: iso(13) } });
    const afterSplit = app.blocks(12);
    const halves = afterSplit.filter((b) => b.events.some((e) => editorEvents.includes(e.id)));
    expect(halves.length).toBe(2);
    const larger = halves.reduce((best, b) => (b.events.length > best.events.length ? b : best));
    const again = await app.service.resolveEvidence(evidence);
    expect(again!.activityId).toBe(larger.id);
    expect(await app.service.resolveEvidence(evidence)).toEqual(again); // the same answer every time

    // Evidence written before event ids were recorded: its time window still finds a block.
    const legacy = await app.service.resolveEvidence({ activityId: 's-0-0', period: { start: iso(12, '10:05'), end: iso(12, '10:35') } });
    expect(afterSplit.find((b) => b.id === legacy!.activityId)!.events.map((e) => e.id)).toEqual(browser);
    app.db.close();
  });

  it('priority history, the day ledger and a user correction all survive a restart', async () => {
    const dbPath = open();
    const gemini = new ScriptedGemini();
    const clock = { now: local(5, '08:00') };
    let app = wire(dbPath, gemini, clock);
    app.profiles.saveProfile({ roles: ['Founder'], description: null, currentWork: [], priorities: ['Launch my SaaS'], interests: [], additionalContext: null }, 'completed');
    const [saasPriority] = app.service.syncPriorities();

    for (const day of [5, 6, 7, 8, 9]) {
      const id = app.track(day, '09:00', 120, 'VS Code', 'billing.ts');
      app.analyse(`ai-${day}`, day, [id], 'Build SaaS billing page');
    }
    // Paused on Wednesday noon, taken up again on Friday morning.
    clock.now = local(7, '12:00');
    app.service.setPriorityStatus(saasPriority.id, 'paused');
    clock.now = local(9, '08:00');
    app.service.setPriorityStatus(saasPriority.id, 'active');

    clock.now = local(12, '09:00');
    const week = periodContaining('week', local(7));
    const priorities = () => app.service.syncPriorities();
    const month = periodContaining('month', local(7));
    // Read through the ledger (a month is): every day is derived once and stored.
    const tracked = async () => (await app.metrics.computeCore(month, clock.now.toISOString(), priorities())).metrics;
    expect((await tracked())['time.tracked_minutes'].display).toBe('10h');
    // Mon, Tue, Wed and Fri count toward the priority; Thursday fell in the pause. (Keyword link: "SaaS".)
    expect((await tracked())[`priority.${saasPriority.id}.minutes`].display).toBe('8h');
    expect(app.derived.days).toBeGreaterThan(0);
    app.db.close();

    // ── Restart ──
    app = wire(dbPath, gemini, clock);
    const reopened = app.reflectionRepo.listPriorities()[0];
    expect(reopened.intervals).toEqual([
      { from: reopened.activeFrom, until: iso(7, '12:00') },
      { from: iso(9, '08:00'), until: null },
    ]);
    expect(reopened.history!.map((e) => e.type)).toEqual(['stated', 'paused', 'reactivated']);

    // The closed days come from the ledger: only the running day is looked at again.
    expect((await tracked())[`priority.${saasPriority.id}.minutes`].display).toBe('8h');
    expect(app.derived.days).toBe(1);
    // History reads the same structure, day by day.
    const history = new ReflectionHistory(app.reflectionRepo, { metrics: app.metrics, now: () => clock.now });
    expect(history.getEntityTrend('priority', saasPriority.id, week.start, week.end).map((p) => p.minutes)).toEqual([120, 120, 120, 0, 120]);
    expect(history.getPriorityHistory()[0].events.map((e) => e.type)).toEqual(['stated', 'paused', 'reactivated']);

    // The user corrects the link: this was not work on that priority.
    const monday = app.blocks(5)[0];
    expect(await app.service.correctActivityLink({ evidence: { eventIds: monday.events.map((e) => e.id) }, priorityId: null })).toBe(true);
    // The days built on that link were dropped with it, and are derived again on demand.
    expect((await tracked())[`priority.${saasPriority.id}.minutes`].display).toBe('0m');
    app.db.close();

    // ── Restart ── the correction is still the user's, and the model cannot take it back.
    app = wire(dbPath, gemini, clock);
    const signature = 'build saas billing page|coding';
    expect(app.reflectionRepo.getAnnotations([signature])[0]).toMatchObject({ source: 'user', priorityId: null });
    expect(app.reflectionRepo.upsertAnnotations([{ signature, thread: 'SaaS', priorityId: saasPriority.id, checkedPriorityIds: [saasPriority.id], source: 'model' }], clock.now.toISOString())).toEqual([]);
    expect(app.reflectionRepo.getAnnotations([signature])[0]).toMatchObject({ source: 'user', priorityId: null });
    expect((await tracked())[`priority.${saasPriority.id}.minutes`].display).toBe('0m');
    app.db.close();
  });

  it('a database written before v17 is upgraded in place: old reports read, priorities get their history', async () => {
    const dbPath = open();
    // A current database, then stripped back to what v16 had.
    new Database(dbPath).close();
    const raw = new BetterSqliteDB(dbPath);
    raw.exec(`
      DROP TABLE reflection_day_facts;
      DROP TABLE reflection_priority_events;
      DROP INDEX idx_reflection_insights_identity;
      ALTER TABLE reflection_insights DROP COLUMN identity_key;
      ALTER TABLE reflection_insights DROP COLUMN subject_key;
      ALTER TABLE reflection_insights DROP COLUMN thread;
      ALTER TABLE reflection_insights DROP COLUMN priority_id;
      ALTER TABLE reflection_insights DROP COLUMN continuity;
      ALTER TABLE reflection_insights DROP COLUMN magnitude;
      ALTER TABLE reflection_activity_annotations DROP COLUMN source;

      INSERT INTO reflection_reports (id, period_type, period_key, period_start, period_end, covered_until, status, trigger_source, headline,
                                      input_schema_version, output_schema_version, prompt_version, model, attempt_count, generated_at, created_at, updated_at)
        VALUES ('old-report', 'day', '2026-10-05', '${iso(5)}', '${iso(6)}', '${iso(6)}', 'fresh', 'scheduled', 'An older reflection.',
                2, 2, 'reflect-reflection-v2', 'gemini', 1, '${iso(6)}', '${iso(6)}', '${iso(6)}');
      INSERT INTO reflection_insights (id, report_id, position, type, title, observation, interpretation, relevance, suggested_action,
                                       evidence_json, source_activity_ids_json, source_metric_keys_json, claim_signature, confidence, created_at, updated_at)
        VALUES ('old-insight', 'old-report', 0, 'progress', 'Project X moved forward', 'You worked on Project X.', 'It was your main thread.', NULL, 'Keep going.',
                '[{"kind":"activity","activityId":"s-10-3","label":"Project X","period":{"start":"${iso(5, '09:00')}","end":"${iso(5, '10:00')}"}}]',
                '["s-10-3"]', '[]', 'progress|activities', 0.8, '${iso(6)}', '${iso(6)}');
      INSERT INTO reflection_priorities (id, text, normalized_key, status, active_from, active_until, last_confirmed_at, created_at, updated_at)
        VALUES ('pr-old', 'Launch Project X', 'launch project x', 'paused', '${iso(1)}', '${iso(4)}', '${iso(1)}', '${iso(1)}', '${iso(4)}'),
               ('pr-live', 'Learn Rust', 'learn rust', 'active', '${iso(2)}', NULL, '${iso(2)}', '${iso(2)}', '${iso(2)}');
      INSERT INTO reflection_activity_annotations (signature, thread_label, priority_id, checked_priority_ids_json, created_at, updated_at)
        VALUES ('project x|coding', 'Project X', 'pr-old', '["pr-old"]', '${iso(2)}', '${iso(2)}');
    `);
    raw.pragma('user_version = 16');
    raw.close();

    const db = new Database(dbPath);
    const check = new BetterSqliteDB(dbPath, { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(17);
    check.close();
    const repo = new ReflectionRepository(db);

    // The old report is exactly as readable as before; what it never had gets honest defaults.
    const report = repo.getCurrentReport('day', '2026-10-05')!;
    expect(report).toMatchObject({ headline: 'An older reflection.', promptVersion: 'reflect-reflection-v2' });
    expect(report.insights[0]).toMatchObject({
      title: 'Project X moved forward',
      identityKey: 'progress|activities', // read through its old signature
      subjectKey: null,
      priorityId: null,
      continuity: 'new',
      magnitude: null,
    });
    expect(report.insights[0].evidence[0]).toMatchObject({ activityId: 's-10-3', period: { start: iso(5, '09:00') } });
    expect(JSON.stringify(report)).not.toContain('Keep going.'); // the unused per-insight action is no longer surfaced anywhere
    expect(repo.listInsightHistory('day', iso(30), 5)).toMatchObject([{ identityKey: 'progress|activities', continuity: 'new' }]);

    // Every existing priority got the history that could be known: when it was stated, and how it stands.
    const [paused, live] = repo.listPriorities();
    expect(paused.history!.map((e) => [e.type, e.at])).toEqual([
      ['stated', iso(1)],
      ['paused', iso(4)],
    ]);
    expect(paused.intervals).toEqual([{ from: iso(1), until: iso(4) }]);
    expect(live.intervals).toEqual([{ from: iso(2), until: null }]);
    // Existing links are the model's; a later correction can therefore replace them.
    expect(repo.getAnnotations(['project x|coding'])[0]).toMatchObject({ source: 'model', priorityId: 'pr-old' });
    expect(repo.getDayFacts(iso(1), iso(31))).toEqual([]);
    db.close();

    // Opening it again changes nothing.
    const again = new Database(dbPath);
    expect(new ReflectionRepository(again).listPriorities()[0].history).toHaveLength(2);
    again.close();
  });
});
