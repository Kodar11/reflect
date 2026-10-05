import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { EditRepository } from '../../src/database/EditRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import { LearnedRuleCandidateRepository } from '../../src/database/LearnedRuleCandidateRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceService } from '../../src/intelligence/IntelligenceService';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { LearnedRuleService } from '../../src/learning/LearnedRuleService';
import { toLearningActivities } from '../../src/learning/LearningTimeline';
import { classificationHash, patternHash } from '../../src/learning/LearnedPattern';
import type { ObservationResult } from '../../src/learning/LearnedRuleModels';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ScriptedGemini, modelActivity, modelOutput } from '../intelligence/helpers';

/**
 * Learned patterns over real SQLite: the v12 migration, the candidate
 * repository, and the whole flow wired exactly like `main.ts`.
 * Self-skips if the native binary ABI does not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-probe-')), 'probe.db');
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

/** UTC instant on day N (day 1 = 2026-03-02). Days are 24h apart, so they are
 * distinct calendar days in every timezone. */
const iso = (day: number, hhmm: string) => `2026-03-${String(day + 1).padStart(2, '0')}T${hhmm}:00.000Z`;

const PERSONAL = { contextId: null, areaId: 'area_personal', intentId: 'intent_create', qualityId: 'quality_focused' };
const GAME_THEORY = [
  { type: 'app_equals', value: 'VS Code' },
  { type: 'title_contains', value: 'GameTheory' },
];
const proposal = (conditions: unknown[], confidence = 0.9) => ({ schemaVersion: 1, conditions, explanation: 'App and project name.', confidence });

function tableColumns(db: BetterSqliteDB.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tableNames(db: BetterSqliteDB.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

/**
 * A database exactly as the v11 release left it: no learned tables, and
 * tracking_rules in its old shape (NOT NULL activity_id, no provenance
 * columns), holding real rules that an event classification points at.
 */
function createV11Database(dbPath: string): void {
  new Database(dbPath).close();
  const raw = new BetterSqliteDB(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE learned_rule_occurrences;
    DROP TABLE learned_rule_candidates;
    DROP TABLE tracking_rules;
    CREATE TABLE tracking_rules (
      id          TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      conditions  TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      area_id     TEXT,
      intent_id   TEXT,
      quality_id  TEXT,
      source      TEXT NOT NULL DEFAULT 'user',
      FOREIGN KEY (activity_id) REFERENCES activities (id) ON DELETE CASCADE
    );
    INSERT INTO tracking_rules (id, activity_id, conditions, enabled, priority, area_id, source) VALUES
      ('rule_coding', 'coding', '[{"type":"app_equals","value":"VS Code"}]', 1, 0, NULL, 'system'),
      ('rule_mine', 'learning', '[{"type":"domain_equals","value":"coursera.org"}]', 0, 10, 'area_personal', 'user'),
      ('rule_orphan', 'deleted_context', '[{"type":"app_equals","value":"Figma"}]', 1, 3, 'area_work', 'weird');
    INSERT INTO events (id, watcher, started_at, ended_at, app) VALUES
      (1, 'window', '2026-03-02T09:00:00.000Z', '2026-03-02T09:30:00.000Z', 'VS Code');
    INSERT INTO event_classifications (event_id, context_id, source, rule_id) VALUES (1, 'coding', 'user_rule', 'rule_mine');
  `);
  raw.pragma('user_version = 11');
  raw.close();
}

suite('Learned patterns — migration to v12', () => {
  let dir: string;
  const newPath = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-'));
    return path.join(dir, 'test.db');
  };

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh database has the final rule schema and both learning tables', () => {
    const dbPath = newPath();
    new Database(dbPath).close();

    const raw = new BetterSqliteDB(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(17);
    expect(tableColumns(raw, 'tracking_rules')).toEqual([
      'id', 'activity_id', 'conditions', 'enabled', 'priority', 'area_id', 'intent_id', 'quality_id',
      'source', 'learned_from_candidate_id', 'learned_confirmed_at', 'user_modified_at', 'created_at', 'updated_at',
    ]);
    expect(tableColumns(raw, 'learned_rule_candidates')).toEqual([
      'id', 'pattern_hash', 'classification_hash', 'conditions_json', 'classification_json',
      'occurrence_count', 'distinct_day_count', 'correction_count', 'conflict_count',
      'first_seen_at', 'last_seen_at', 'last_correction_at', 'last_suggested_at', 'suggestion_count',
      'status', 'snoozed_until', 'confirmed_rule_id', 'created_at', 'updated_at',
    ]);
    expect(tableNames(raw)).toContain('learned_rule_occurrences');
    expect(tableNames(raw)).not.toContain('tracking_rules_v12');
    // Seeded defaults are system rules.
    expect(raw.prepare('SELECT DISTINCT source FROM tracking_rules').all()).toEqual([{ source: 'system' }]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    raw.close();
  });

  it('an existing v11 database is rebuilt once, keeping its rules and everything pointing at them', () => {
    const dbPath = newPath();
    createV11Database(dbPath);

    const db = new Database(dbPath);

    const raw = new BetterSqliteDB(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(17);
    expect(
      raw.prepare('SELECT id, activity_id, enabled, priority, area_id, source FROM tracking_rules ORDER BY id').all(),
    ).toEqual([
      { id: 'rule_coding', activity_id: 'coding', enabled: 1, priority: 0, area_id: null, source: 'system' },
      { id: 'rule_mine', activity_id: 'learning', enabled: 0, priority: 10, area_id: 'area_personal', source: 'user' },
      // Unknown source → user; a context that no longer exists → no context.
      { id: 'rule_orphan', activity_id: null, enabled: 1, priority: 3, area_id: 'area_work', source: 'user' },
    ]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracking_rules WHERE created_at IS NULL OR updated_at IS NULL').get()).toEqual({ n: 0 });
    // The rebuild did not cascade into rows that reference a rule.
    expect(raw.prepare('SELECT rule_id FROM event_classifications WHERE event_id = 1').get()).toEqual({ rule_id: 'rule_mine' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    expect(tableNames(raw)).toEqual(expect.arrayContaining(['learned_rule_candidates', 'learned_rule_occurrences']));
    expect(tableNames(raw)).not.toContain('tracking_rules_v12');
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    raw.close();

    // The application connection has foreign keys back on after the rebuild.
    expect(() =>
      db.prepare("INSERT INTO tracking_rules (id, activity_id, conditions) VALUES ('bad', 'no_such_context', '[]')").run(),
    ).toThrow(/FOREIGN KEY/);
    expect(new ActivityRuleRepository(db).listRules().map((r) => [r.id, r.source, r.activityId])).toEqual([
      ['rule_mine', 'user', 'learning'],
      ['rule_orphan', 'user', ''],
      ['rule_coding', 'system', 'coding'],
    ]);
    db.close();
  });

  it('the migration runs once: reopening never rebuilds or wipes anything', () => {
    const dbPath = newPath();
    createV11Database(dbPath);

    let db = new Database(dbPath);
    const repo = new LearnedRuleCandidateRepository(db);
    repo.createCandidate({
      id: 'lrc_1',
      patternHash: patternHash(GAME_THEORY),
      classificationHash: classificationHash(PERSONAL),
      conditions: GAME_THEORY,
      classification: PERSONAL,
      nowIso: iso(1, '10:00'),
    });
    new ActivityRuleRepository(db).saveRule({ id: 'rule_new', activityId: 'coding', conditions: '[]', enabled: 1, priority: 1, areaId: null, intentId: null, qualityId: null });
    db.close();

    db = new Database(dbPath);
    new Database(dbPath).close();

    expect(new LearnedRuleCandidateRepository(db).listCandidates().map((c) => c.id)).toEqual(['lrc_1']);
    expect(new ActivityRuleRepository(db).listRules().map((r) => r.id).sort()).toEqual(['rule_coding', 'rule_mine', 'rule_new', 'rule_orphan']);
    db.close();
  });

  it('the schema only accepts the three rule sources and the four candidate statuses', () => {
    const dbPath = newPath();
    const db = new Database(dbPath);
    expect(() =>
      db.prepare("INSERT INTO tracking_rules (id, conditions, source) VALUES ('r', '[]', 'gemini')").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO learned_rule_candidates (id, pattern_hash, classification_hash, conditions_json, classification_json, status, created_at, updated_at)
           VALUES ('c', 'p', 'k', '[]', '{}', 'auto_applied', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});

suite('LearnedRuleCandidateRepository (SQLite)', () => {
  let dir: string;
  let db: Database;
  let repo: LearnedRuleCandidateRepository;

  const open = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-repo-'));
    db = new Database(path.join(dir, 'test.db'));
    repo = new LearnedRuleCandidateRepository(db);
  };
  const newCandidate = (id: string, classification = PERSONAL) => ({
    id,
    patternHash: patternHash(GAME_THEORY),
    classificationHash: classificationHash(classification),
    conditions: GAME_THEORY,
    classification,
    nowIso: iso(1, '10:00'),
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creating the same pattern + classification twice yields one candidate', () => {
    open();
    const first = repo.createCandidate(newCandidate('lrc_1'));
    const second = repo.createCandidate(newCandidate('lrc_2'));

    expect(second.id).toBe(first.id);
    expect(repo.listCandidates()).toHaveLength(1);
    expect(first).toMatchObject({ status: 'pending', conditions: GAME_THEORY, classification: PERSONAL, occurrenceCount: 0, suggestionCount: 0, confirmedRuleId: null });
    expect(repo.findByPatternHash(first.patternHash, first.classificationHash)?.id).toBe('lrc_1');
  });

  it('the same pattern with another classification is a separate candidate', () => {
    open();
    repo.createCandidate(newCandidate('lrc_1'));
    repo.createCandidate(newCandidate('lrc_2', { ...PERSONAL, areaId: 'area_work' }));
    expect(repo.listCandidates().map((c) => c.id)).toEqual(['lrc_1', 'lrc_2']);
  });

  it('the occurrence ledger is keyed per activity and findable by anchor event', () => {
    open();
    repo.createCandidate(newCandidate('lrc_1'));
    const row = { candidateId: 'lrc_1', occurrenceKey: 'ev:10', anchorEventId: 10, localDay: '2026-03-02', occurredAt: iso(1, '10:00'), isCorrection: false, isConflict: false };

    repo.saveOccurrence(row);
    repo.saveOccurrence({ ...row, isCorrection: true }); // same key → update, not a second row

    expect(repo.listOccurrences('lrc_1')).toEqual([{ ...row, isCorrection: true }]);
    expect(repo.findOccurrence('lrc_1', 'ev:10', [])?.occurrenceKey).toBe('ev:10');
    // The same activity regrouped under an AI id is found through its anchor.
    expect(repo.findOccurrence('lrc_1', 'ai:abc', [9, 10, 11])?.occurrenceKey).toBe('ev:10');
    expect(repo.findOccurrence('lrc_1', 'ai:abc', [11, 12])).toBeNull();
    expect(repo.findOccurrence('lrc_other', 'ev:10', [10])).toBeNull();
  });

  it('stores evidence, suggestion and status transitions', () => {
    open();
    repo.createCandidate(newCandidate('lrc_1'));

    repo.updateEvidence(
      'lrc_1',
      { occurrenceCount: 3, distinctDayCount: 2, correctionCount: 1, conflictCount: 0, firstSeenAt: iso(1, '10:00'), lastSeenAt: iso(2, '10:00'), lastCorrectionAt: iso(1, '10:00') },
      iso(2, '11:00'),
    );
    expect(repo.lastSuggestedAt()).toBeNull();
    repo.markSuggested('lrc_1', iso(2, '11:00'));
    repo.markSuggested('lrc_1', iso(2, '12:00'));
    expect(repo.getCandidate('lrc_1')).toMatchObject({
      occurrenceCount: 3,
      distinctDayCount: 2,
      correctionCount: 1,
      firstSeenAt: iso(1, '10:00'),
      lastSeenAt: iso(2, '10:00'),
      lastSuggestedAt: iso(2, '12:00'),
      suggestionCount: 2,
    });
    expect(repo.lastSuggestedAt()).toBe(iso(2, '12:00'));

    repo.snooze('lrc_1', iso(9, '12:00'), iso(2, '12:00'));
    expect(repo.getCandidate('lrc_1')).toMatchObject({ status: 'snoozed', snoozedUntil: iso(9, '12:00') });
    expect(repo.listCandidates(['pending'])).toEqual([]);

    repo.dismiss('lrc_1', iso(2, '13:00'));
    expect(repo.getCandidate('lrc_1')).toMatchObject({ status: 'dismissed', snoozedUntil: null });

    repo.reactivate('lrc_1', iso(2, '14:00'));
    expect(repo.getCandidate('lrc_1')).toMatchObject({ status: 'pending', lastSuggestedAt: null });
  });

  it('a failed transaction leaves nothing behind', () => {
    open();
    repo.createCandidate(newCandidate('lrc_1'));
    expect(() =>
      repo.transaction(() => {
        repo.insertLearnedRule({ id: 'rule_learned_x', candidateId: 'lrc_1', conditions: GAME_THEORY, classification: PERSONAL, priority: 10, nowIso: iso(2, '10:00') });
        repo.markConfirmed('lrc_1', 'rule_learned_x', iso(2, '10:00'));
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(repo.getCandidate('lrc_1')).toMatchObject({ status: 'pending', confirmedRuleId: null });
    expect(new ActivityRuleRepository(db).listRules().some((r) => r.id === 'rule_learned_x')).toBe(false);
  });
});

function wire(dbPath: string, gemini: ScriptedGemini, clock: { now: string }) {
  const db = new Database(dbPath);
  const events = new EventRepository(db);
  const activityRules = new ActivityRuleRepository(db);
  const categorizationRepo = new CategorizationRepository(db);
  const focus = new FocusRepository(db);
  const intelligenceRepo = new IntelligenceRepository(db);
  const profiles = new UserProfileRepository(db);
  const candidates = new LearnedRuleCandidateRepository(db);
  const aiSource = new IntelligenceTimelineSource(intelligenceRepo, () => new Date(clock.now));

  // Same late binding as main.ts: categorization exists before learning does.
  const observations: Promise<ObservationResult>[] = [];
  let learned: LearnedRuleService | null = null;
  const categorization = new CategorizationService(activityRules, categorizationRepo, focus, events, aiSource, {
    onCorrection: (c) => {
      if (learned) observations.push(learned.observeCorrection(c));
    },
  });
  const timeline = new TimelineService(new SessionService(events), new EditRepository(db), activityRules, categorization, aiSource);
  const userContext = new UserProfileContextProvider(profiles);
  learned = new LearnedRuleService({
    repo: candidates,
    gemini,
    events,
    activityRules,
    categorization: categorizationRepo,
    intelligence: intelligenceRepo,
    userContext,
    getActivities: (from, to) => toLearningActivities(timeline.getByRange(from, to)),
    now: () => new Date(clock.now),
  });
  const intelligence = new IntelligenceService({
    events,
    repo: intelligenceRepo,
    gemini,
    activityRules,
    categorization: categorizationRepo,
    focus,
    userContext,
    getUserEditedEventIds: (from, to) => timeline.getUserEditedEventIds(from, to),
    now: () => new Date(clock.now),
    sleep: async () => {},
  });
  return { db, events, activityRules, categorization, timeline, learned, intelligence, candidates, observations };
}

suite('Learned patterns (SQLite, end to end)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const vsCode = (title: string) => ({ watcher: 'window' as const, app: 'Visual Studio Code', title: `${title} - Visual Studio Code` });
  const dayRange = (day: number): [string, string] => [iso(day, '00:00'), iso(day, '23:59')];

  it('correction → Gemini pattern → candidate → second day → suggestion → Remember → deterministic rule', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-e2e-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    const clock = { now: iso(1, '11:00') };
    let app = wire(dbPath, gemini, clock);

    // ── Day 1: VS Code in the GameTheory project; Gemini calls it work ──
    const e1 = app.events.insert({ ...vsCode('strategy.py - GameTheory'), startedAt: iso(1, '09:00'), endedAt: iso(1, '09:40') });
    gemini.push(modelOutput([modelActivity({ eventIds: [e1], startedAt: iso(1, '09:00'), endedAt: iso(1, '09:40'), title: 'Software development', contextId: 'coding', areaId: 'area_work' })], [], [iso(1, '09:00'), iso(1, '10:00')]));
    expect(await app.intelligence.analyzeWindow(iso(1, '09:00'), iso(1, '10:00'))).toMatchObject({ status: 'succeeded' });
    let [block] = app.timeline.getByRange(...dayRange(1));
    expect(block.classification).toMatchObject({ source: 'ai', area: { id: 'area_work' } });
    const rawBefore = app.events.getAll();

    // The user corrects it to Personal · Create · Focused, "Remember for future" unchecked.
    gemini.push(proposal([...GAME_THEORY].reverse()));
    const saved = app.categorization.saveOverride(block.events.map((e) => e.id), PERSONAL, false);
    expect(saved.ruleId).toBeNull();
    expect(await Promise.all(app.observations)).toEqual([expect.objectContaining({ status: 'candidate', created: true, usedGemini: true })]);

    // The override behaves exactly as before …
    [block] = app.timeline.getByRange(...dayRange(1));
    expect(block.classification).toMatchObject({ source: 'user_override', area: { id: 'area_personal' } });
    // … the extraction request carried the correction and the original interpretation …
    const extraction = gemini.requests[1];
    expect(extraction.systemInstruction).toContain('learn reusable activity patterns');
    expect(extraction.prompt).toContain('"title":"Software development"');
    expect(extraction.prompt).toContain('"area":"Personal"');
    expect(extraction.prompt).toContain('GameTheory');
    // … and a candidate exists, but no rule.
    let [candidate] = app.learned.listCandidates();
    expect(candidate).toMatchObject({
      conditions: GAME_THEORY,
      classification: PERSONAL,
      status: 'pending',
      occurrenceCount: 1,
      distinctDayCount: 1,
      correctionCount: 1,
      firstSeenAt: iso(1, '09:00'),
      lastSeenAt: iso(1, '09:00'),
      eligible: false,
      blockedBy: ['insufficient_evidence'],
    });
    expect(app.learned.nextSuggestion()).toBeNull();
    expect(app.activityRules.listRules().every((r) => r.source === 'system')).toBe(true);

    // Processing the same correction again changes nothing.
    await app.learned.observeCorrection({ eventIds: block.events.map((e) => e.id), ...PERSONAL });
    app.learned.trackOccurrences();
    expect(app.learned.listCandidates()).toHaveLength(1);
    expect(app.learned.getCandidate(candidate.id)).toMatchObject({ occurrenceCount: 1, correctionCount: 1 });
    expect(gemini.requests).toHaveLength(2);

    // ── restart ──
    app.db.close();
    app = wire(dbPath, gemini, clock);

    // ── Day 2: the same pattern, a different file ──
    const e2 = app.events.insert({ ...vsCode('payoff.py - GameTheory'), startedAt: iso(2, '09:00'), endedAt: iso(2, '09:45') });
    app.events.insert({ ...vsCode('main.ts - reflect'), startedAt: iso(2, '13:00'), endedAt: iso(2, '13:30') });
    clock.now = iso(2, '09:50');

    expect(app.learned.trackOccurrences().occurrencesRecorded).toBe(1);
    expect(app.learned.trackOccurrences().occurrencesRecorded).toBe(0);
    [candidate] = app.learned.listCandidates();
    expect(candidate).toMatchObject({ occurrenceCount: 2, distinctDayCount: 2, correctionCount: 1, lastSeenAt: iso(2, '09:00'), eligible: true });

    const suggestion = app.learned.nextSuggestion();
    expect(suggestion).toMatchObject({
      candidateId: candidate.id,
      trigger: 'contextual',
      patternLabel: 'VS Code + “GameTheory”',
      classificationLabel: 'Personal · Create · Focused',
      evidenceLabel: 'Seen 2 times across 2 days',
    });
    expect(app.learned.nextSuggestion()).toBeNull(); // cooldown

    // ── Remember ──
    const confirmed = app.learned.confirmCandidate(candidate.id);
    expect(confirmed.created).toBe(true);
    expect(app.learned.confirmCandidate(candidate.id)).toEqual({ ruleId: confirmed.ruleId, created: false });

    const learnedRules = app.activityRules.listRules().filter((r) => r.source === 'learned');
    expect(learnedRules).toHaveLength(1);
    expect(learnedRules[0]).toMatchObject({
      id: confirmed.ruleId,
      enabled: 1,
      activityId: '',
      areaId: 'area_personal',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      learned: { candidateId: candidate.id, confirmedAt: iso(2, '09:50'), userModifiedAt: null, correctionCount: 1, matchCount: 2, distinctDayCount: 2, firstSeenAt: iso(1, '09:00'), lastSeenAt: iso(2, '09:00') },
    });
    expect(JSON.parse(learnedRules[0].conditions)).toEqual(GAME_THEORY);
    expect(app.learned.getCandidate(candidate.id)).toMatchObject({ status: 'confirmed', confirmedRuleId: confirmed.ruleId, eligible: false });

    // Immediately effective: day 2 is now classified by the rule, locally.
    const day2 = app.timeline.getByRange(...dayRange(2));
    expect(day2.map((s) => s.events.map((e) => e.id))).toEqual([[e2], [e2 + 1]]);
    expect(day2[0].classification).toMatchObject({ source: 'user_rule', matchedRuleId: confirmed.ruleId, area: { id: 'area_personal' }, intent: { id: 'intent_create' }, quality: { id: 'quality_focused' } });
    expect(day2[0].classification?.reason).toMatch(/^Learned rule:/);
    // The other VS Code project is untouched by the learned rule.
    expect(day2[1].classification?.matchedRuleId).not.toBe(confirmed.ruleId);

    // ── Day 3: even when Gemini still says "work", the confirmed rule decides ──
    const e3 = app.events.insert({ ...vsCode('nash.py - GameTheory'), startedAt: iso(3, '09:00'), endedAt: iso(3, '09:30') });
    clock.now = iso(3, '10:30');
    gemini.push(modelOutput([modelActivity({ eventIds: [e3], startedAt: iso(3, '09:00'), endedAt: iso(3, '09:30'), title: 'Software development', contextId: 'coding', areaId: 'area_work' })], [], [iso(3, '09:00'), iso(3, '10:00')]));
    expect(await app.intelligence.analyzeWindow(iso(3, '09:00'), iso(3, '10:00'))).toMatchObject({ status: 'succeeded' });
    // The hourly prompt now carries the learned rule as the user's own knowledge.
    expect(gemini.requests[gemini.requests.length - 1].prompt).toContain(confirmed.ruleId);

    const [day3] = app.timeline.getByRange(...dayRange(3));
    expect(day3.ai?.title).toBe('Software development'); // the AI activity is unchanged
    expect(day3.classification).toMatchObject({ source: 'user_rule', matchedRuleId: confirmed.ruleId, area: { id: 'area_personal' } });

    // The confirmed candidate keeps counting matches; it is never suggested again.
    app.learned.trackOccurrences();
    expect(app.activityRules.listRules().find((r) => r.id === confirmed.ruleId)?.learned).toMatchObject({ matchCount: 3, distinctDayCount: 3, correctionCount: 1 });
    expect(app.learned.listSuggestions()).toEqual([]);

    // Learning needed Gemini once; raw events were never touched.
    expect(gemini.requests.filter((r) => r.systemInstruction.includes('learn reusable activity patterns'))).toHaveLength(1);
    expect(app.events.getAll().filter((e) => e.id === e1)).toEqual(rawBefore);
    app.db.close();
  });

  it('"Remember for future" still creates a user rule directly, with no candidate', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-e2e-'));
    const gemini = new ScriptedGemini();
    const app = wire(path.join(dir, 'test.db'), gemini, { now: iso(1, '11:00') });
    const e1 = app.events.insert({ ...vsCode('strategy.py - GameTheory'), startedAt: iso(1, '09:00'), endedAt: iso(1, '09:40') });

    const saved = app.categorization.saveOverride([e1], { ...PERSONAL, contextId: 'coding' }, true, { primaryApp: 'Visual Studio Code' });

    expect(saved.ruleId).not.toBeNull();
    expect(app.activityRules.listRules().find((r) => r.id === saved.ruleId)).toMatchObject({ source: 'user', learned: null, areaId: 'area_personal' });
    expect(app.observations).toEqual([]);
    expect(app.learned.listCandidates()).toEqual([]);
    expect(gemini.requests).toEqual([]);
    app.db.close();
  });

  it('editing a learned rule keeps its provenance; deleting it retires the candidate', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-e2e-'));
    const gemini = new ScriptedGemini();
    const clock = { now: iso(1, '11:00') };
    const app = wire(path.join(dir, 'test.db'), gemini, clock);
    const e1 = app.events.insert({ ...vsCode('strategy.py - GameTheory'), startedAt: iso(1, '09:00'), endedAt: iso(1, '09:40') });
    app.events.insert({ ...vsCode('payoff.py - GameTheory'), startedAt: iso(2, '09:00'), endedAt: iso(2, '09:45') });
    gemini.push(proposal(GAME_THEORY));
    app.categorization.saveOverride([e1], PERSONAL, false);
    await Promise.all(app.observations);
    clock.now = iso(2, '19:00');
    app.learned.trackOccurrences();
    const [candidate] = app.learned.listCandidates();
    const { ruleId } = app.learned.confirmCandidate(candidate.id);
    const rule = () => app.activityRules.listRules().find((r) => r.id === ruleId)!;

    // Toggling it off and on is not an edit.
    app.activityRules.saveRule({ ...rule(), enabled: 0 });
    app.activityRules.saveRule({ ...rule(), enabled: 1 });
    expect(rule()).toMatchObject({ source: 'learned', enabled: 1, learned: { userModifiedAt: null } });

    // Changing what it classifies as is: still learned, now marked as edited.
    app.activityRules.saveRule({ ...rule(), areaId: 'area_leisure', source: 'user' });
    expect(rule()).toMatchObject({ source: 'learned', areaId: 'area_leisure', learned: { candidateId: candidate.id } });
    expect(rule().learned?.userModifiedAt).toEqual(expect.any(String));
    expect(app.activityRules.listRules().filter((r) => r.source === 'learned')).toHaveLength(1); // no second rule

    // Deleting the rule is an explicit "no": the pattern is not suggested again.
    app.activityRules.deleteRule(ruleId);
    expect(app.learned.getCandidate(candidate.id)).toMatchObject({ status: 'dismissed', confirmedRuleId: null, eligible: false });
    expect(app.learned.listSuggestions()).toEqual([]);
    expect(app.learned.nextSuggestion()).toBeNull();
    app.db.close();
  });

  it('"Not now" and "Never" never create a rule', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-learned-e2e-'));
    const gemini = new ScriptedGemini();
    const clock = { now: iso(1, '11:00') };
    const app = wire(path.join(dir, 'test.db'), gemini, clock);
    const e1 = app.events.insert({ ...vsCode('strategy.py - GameTheory'), startedAt: iso(1, '09:00'), endedAt: iso(1, '09:40') });
    app.events.insert({ ...vsCode('payoff.py - GameTheory'), startedAt: iso(2, '09:00'), endedAt: iso(2, '09:45') });
    gemini.push(proposal(GAME_THEORY));
    app.categorization.saveOverride([e1], PERSONAL, false);
    await Promise.all(app.observations);
    clock.now = iso(2, '09:50');
    app.learned.trackOccurrences();
    const [candidate] = app.learned.listCandidates();
    expect(candidate.eligible).toBe(true);

    app.learned.snoozeCandidate(candidate.id);
    expect(app.learned.getCandidate(candidate.id)).toMatchObject({ status: 'snoozed', snoozedUntil: iso(9, '09:50'), blockedBy: ['snoozed'] });
    expect(app.learned.nextSuggestion()).toBeNull();

    app.learned.dismissCandidate(candidate.id);
    expect(app.learned.getCandidate(candidate.id)).toMatchObject({ status: 'dismissed' });
    expect(app.learned.listSuggestions()).toEqual([]);
    expect(app.activityRules.listRules().some((r) => r.source === 'learned')).toBe(false);
    app.db.close();
  });
});
