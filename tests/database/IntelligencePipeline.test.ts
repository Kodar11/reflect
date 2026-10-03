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
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
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
  const profiles = new UserProfileRepository(db);
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
    userContext: new UserProfileContextProvider(profiles),
    getUserEditedEventIds: (from, to) => timeline.getUserEditedEventIds(from, to),
    now: () => new Date(iso('12:00')),
    sleep: async () => {},
  });
  return { db, events, timeline, service, intelligenceRepo, categorization, profiles, activityRules };
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

  it('sends the saved onboarding profile to Gemini, follows edits, and survives a restart', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pipeline-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    let app = wire(dbPath, gemini);

    const e1 = app.events.insert({ watcher: 'window', startedAt: iso('09:00'), endedAt: iso('09:40'), app: 'Code.exe', title: 'player.ts - GameProject - Visual Studio Code' });
    const output = () => modelOutput([modelActivity({ eventIds: [e1], startedAt: iso('09:00'), endedAt: iso('09:40') })], [], [iso('09:00'), iso('10:00')]);
    const analyze = async () => {
      gemini.push(output());
      expect((await app.service.analyzeWindow(iso('09:00'), iso('10:00'), { force: true })).status).toBe('succeeded');
      return gemini.requests[gemini.requests.length - 1].prompt;
    };

    // No profile row at all: analysis works, no persona is invented.
    let prompt = await analyze();
    expect(prompt).toContain('USER CONTEXT\nNot provided.');
    for (const fictional of ['Computer Science student', 'game theory', 'volleyball']) {
      expect(prompt).not.toContain(fictional);
    }
    expect(app.service.getStatus()).toMatchObject({ hasUserContext: false, onboardingStatus: 'not_started' });

    // Answers saved but onboarding skipped: still no personal context.
    const answers = {
      roles: ['Student', 'Developer'],
      description: 'I build software projects.',
      currentWork: ['Reflect', 'College'],
      priorities: ['Graduate', 'Ship Reflect'],
      interests: ['Gaming'],
      additionalContext: 'My game project is a hobby.',
    };
    app.profiles.saveProfile(answers, 'skipped');
    prompt = await analyze();
    expect(prompt).toContain('USER CONTEXT\nNot provided.');
    expect(prompt).not.toContain('My game project is a hobby.');

    // Completed onboarding + a user rule: both arrive, in their own sections.
    app.profiles.updateProfile({ onboardingStatus: 'completed' });
    app.activityRules.saveRule({
      id: 'rule_game', activityId: 'learning', conditions: '[{"type":"title_contains","value":"GameProject"}]',
      enabled: 1, priority: 10, areaId: 'area_personal', intentId: null, qualityId: null, source: 'user',
    });
    prompt = await analyze();
    const rulesAt = prompt.indexOf('USER RULES (explicitly created by the user)');
    const contextSection = prompt.slice(prompt.indexOf('USER CONTEXT'), rulesAt);
    expect(contextSection).toContain('Who the user is: Student, Developer');
    expect(contextSection).toContain('In their words: I build software projects.');
    expect(contextSection).toContain('Currently working on: Reflect, College');
    expect(contextSection).toContain('What matters most right now: Graduate, Ship Reflect');
    expect(contextSection).toContain('Outside work or study: Gaming');
    expect(contextSection).toContain('Interpretation notes: My game project is a hobby.');
    expect(contextSection).not.toContain('rule_game');
    expect(prompt.slice(rulesAt)).toContain('"id":"rule_game"');
    expect(app.service.getStatus()).toMatchObject({ hasUserContext: true, onboardingStatus: 'completed', userRuleCount: 1 });

    // Edit (Settings → Personalization path): next analysis uses the new values.
    app.profiles.updateProfile({ roles: ['Founder'], additionalContext: 'Some YouTube usage is coursework.' });
    prompt = await analyze();
    expect(prompt).toContain('Who the user is: Founder');
    expect(prompt).toContain('Interpretation notes: Some YouTube usage is coursework.');
    expect(prompt).not.toContain('Student, Developer');
    expect(prompt).not.toContain('My game project is a hobby.');

    // Restart: the profile comes from SQLite, not from process memory.
    app.db.close();
    app = wire(dbPath, gemini);
    prompt = await analyze();
    expect(prompt).toContain('Who the user is: Founder');
    expect(prompt).toContain('Currently working on: Reflect, College');
    app.db.close();
  });
});
