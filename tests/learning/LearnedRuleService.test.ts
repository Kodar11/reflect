import { describe, it, expect } from 'vitest';
import { ClassificationEngine } from '../../src/categorization/ClassificationEngine';
import type { CategorizationRule } from '../../src/categorization/Classification';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { toSessionLike } from '../../src/learning/LearnedPattern';
import {
  ACTIVITIES,
  DIMENSIONS,
  GAME_THEORY_PATTERN,
  LEISURE,
  PERSONAL,
  WORK,
  activity,
  addActivity,
  at,
  makeLearningHarness,
  proposal,
  type LearningHarness,
} from './helpers';

/** Correct activity `eventId` to PERSONAL without "Remember for future". */
function correct(h: LearningHarness, eventId: number, classification = PERSONAL) {
  const a = h.timeline.find((x) => x.eventIds.includes(eventId));
  if (a) {
    a.classificationSource = 'user_override';
    a.classification = classification;
  }
  return h.service.observeCorrection({ eventIds: [eventId], ...classification });
}

/** Day 0: a corrected GameTheory activity → one candidate. */
async function seedCandidate(h: LearningHarness): Promise<string> {
  addActivity(h, at(0, 10), 1);
  h.gemini.push(proposal(GAME_THEORY_PATTERN));
  const result = await correct(h, 1);
  if (result.status !== 'candidate') throw new Error(`seed failed: ${JSON.stringify(result)}`);
  return result.candidateId;
}

/** Day 0 correction + a day-1 occurrence → an eligible candidate. Now = day 1, 11:00. */
async function seedEligible(h: LearningHarness): Promise<string> {
  const id = await seedCandidate(h);
  addActivity(h, at(1, 10), 2);
  h.setNow(at(1, 11));
  h.service.trackOccurrences();
  return id;
}

describe('LearnedRuleService — candidate creation', () => {
  it('a correction produces a candidate from the pattern Gemini extracts', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    h.gemini.push(proposal([...GAME_THEORY_PATTERN].reverse()));

    const result = await correct(h, 1);

    expect(result).toMatchObject({ status: 'candidate', created: true, usedGemini: true });
    expect(h.repo.candidates).toHaveLength(1);
    expect(h.repo.candidates[0]).toMatchObject({
      conditions: GAME_THEORY_PATTERN,
      classification: PERSONAL,
      status: 'pending',
      occurrenceCount: 1,
      distinctDayCount: 1,
      correctionCount: 1,
      conflictCount: 0,
      firstSeenAt: at(0, 10),
      lastSeenAt: at(0, 10),
      lastCorrectionAt: at(0, 10),
      confirmedRuleId: null,
    });
    // A candidate is not a rule.
    expect(h.rules).toEqual([]);
  });

  it('sends the correction and its evidence to a dedicated prompt', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    addActivity(h, at(0, 8), 5, { primaryTitle: 'main.ts — reflect — Visual Studio Code', browserTabs: [] });
    h.gemini.push(proposal(GAME_THEORY_PATTERN));

    await correct(h, 1);

    expect(h.gemini.requests).toHaveLength(1);
    const request = h.gemini.requests[0];
    expect(request.systemInstruction).toContain('learn reusable activity patterns');
    expect(request.prompt).toContain('GameTheory');
    expect(request.prompt).toContain('"area":"Personal"');
    expect(request.prompt).toContain('main.ts — reflect'); // contrast activity
    expect((request.responseJsonSchema as any).properties.conditions.items.properties.type.enum).toContain('title_contains');
  });

  it('an identical correction does not create a second candidate or count twice', async () => {
    const h = makeLearningHarness();
    const id = await seedCandidate(h);

    const again = await correct(h, 1);

    expect(again).toEqual({ status: 'candidate', candidateId: id, created: false, usedGemini: false });
    expect(h.gemini.requests).toHaveLength(1);
    expect(h.repo.candidates).toHaveLength(1);
    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 1, correctionCount: 1 });
  });

  it('the same pattern proposed again resolves to the same candidate', async () => {
    const h = makeLearningHarness();
    const id = await seedCandidate(h);
    h.service.dismissCandidate(id);
    h.repo.candidates[0].conditions = []; // force the local match to miss
    addActivity(h, at(1, 10), 2);
    h.gemini.push(proposal([{ type: 'title_contains', value: 'gametheory' }, { type: 'app_equals', value: 'vscode' }]));

    const result = await correct(h, 2);

    expect(result).toMatchObject({ status: 'candidate', candidateId: id, created: false });
    expect(h.repo.candidates).toHaveLength(1);
  });

  it('weak evidence produces no candidate', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    h.gemini.push(proposal([]));
    expect(await correct(h, 1)).toMatchObject({ status: 'skipped', reason: 'no_pattern' });

    addActivity(h, at(0, 14), 2);
    h.gemini.push(proposal(GAME_THEORY_PATTERN, 0.2));
    expect(await correct(h, 2)).toMatchObject({ status: 'skipped', reason: 'no_pattern', detail: 'low_confidence' });

    expect(h.repo.candidates).toEqual([]);
  });

  it('an unsupported Gemini condition is rejected, with one corrective retry', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    const invented = proposal([{ type: 'project_equals', value: 'GameTheory' }]);
    h.gemini.push(invented, invented);

    const result = await correct(h, 1);

    expect(result).toMatchObject({ status: 'skipped', reason: 'rejected' });
    expect(h.gemini.requests).toHaveLength(2);
    expect(h.gemini.requests[1].prompt).toContain('YOUR PREVIOUS PROPOSAL WAS REJECTED');
    expect(h.gemini.requests[1].prompt).toContain('unsupported condition type "project_equals"');
    expect(h.repo.candidates).toEqual([]);
  });

  it('a rejected proposal can be corrected on the retry', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    h.gemini.push(proposal([{ type: 'url_contains', value: '/GameTheory/' }]), proposal(GAME_THEORY_PATTERN));

    expect(await correct(h, 1)).toMatchObject({ status: 'candidate', created: true });
    expect(h.repo.candidates[0].conditions).toEqual(GAME_THEORY_PATTERN);
  });

  it('an invalid Gemini schema is rejected', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    h.gemini.push('not json at all', { pattern: 'VS Code in the GameTheory project' });

    expect(await correct(h, 1)).toMatchObject({ status: 'skipped', reason: 'rejected' });
    expect(h.repo.candidates).toEqual([]);
  });

  it('never throws and never touches rules when Gemini fails or is unavailable', async () => {
    const h = makeLearningHarness();
    h.rules.push({ id: 'rule_user', activityId: 'coding', conditions: '[{"type":"app_equals","value":"Figma"}]', enabled: 1, priority: 0, areaId: null, intentId: null, qualityId: null, source: 'user' });
    const before = structuredClone(h.rules);
    addActivity(h, at(0, 10), 1);

    h.gemini.push(new GeminiError('network', 'offline', true));
    expect(await correct(h, 1)).toMatchObject({ status: 'skipped', reason: 'error', detail: 'network' });

    h.gemini.configured = false;
    expect(await correct(h, 1)).toEqual({ status: 'skipped', reason: 'gemini_unavailable' });

    expect(h.repo.candidates).toEqual([]);
    expect(h.rules).toEqual(before);
  });

  it('skips corrections with no classification, an unknown id, or no events', async () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    expect(await h.service.observeCorrection({ eventIds: [1], contextId: null, areaId: null, intentId: null, qualityId: null })).toEqual({
      status: 'skipped',
      reason: 'no_classification',
    });
    expect(await h.service.observeCorrection({ eventIds: [1], ...PERSONAL, areaId: 'area_made_up' })).toEqual({
      status: 'skipped',
      reason: 'invalid_classification',
    });
    expect(await h.service.observeCorrection({ eventIds: [404], ...PERSONAL })).toEqual({ status: 'skipped', reason: 'no_events' });
    expect(h.gemini.requests).toEqual([]);
  });

  it('limits how many extractions run per hour', async () => {
    const h = makeLearningHarness({ config: { maxExtractionsPerHour: 1 } });
    addActivity(h, at(0, 10), 1);
    addActivity(h, at(0, 11), 2, { primaryTitle: 'notes.md — Thesis — Visual Studio Code', browserTabs: [] });
    h.gemini.push(proposal([]));

    await correct(h, 1);
    expect(await correct(h, 2, LEISURE)).toEqual({ status: 'skipped', reason: 'rate_limited' });
    expect(h.gemini.requests).toHaveLength(1);
  });
});

describe('LearnedRuleService — occurrence tracking', () => {
  it('a matching activity increments the candidate once, without calling Gemini', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(1, 10), 2);
    h.setNow(at(1, 11));

    const result = h.service.trackOccurrences();

    expect(result.occurrencesRecorded).toBe(1);
    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 2, distinctDayCount: 2, correctionCount: 1 });
    expect(h.gemini.requests).toHaveLength(1); // only the original extraction
  });

  it('repeated processing is idempotent', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(1, 10), 2);
    h.setNow(at(1, 11));

    h.service.trackOccurrences();
    const second = h.service.trackOccurrences();
    h.service.trackOccurrences();

    expect(second.occurrencesRecorded).toBe(0);
    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 2, distinctDayCount: 2 });
    expect(h.repo.occurrences).toHaveLength(2);
  });

  it('tracks distinct days, keeps first_seen_at and advances last_seen_at', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(0, 15), 2); // same day as the correction
    addActivity(h, at(1, 9), 3);
    addActivity(h, at(1, 16), 4);
    h.setNow(at(1, 18));

    h.service.trackOccurrences();

    expect(h.repo.candidates[0]).toMatchObject({
      occurrenceCount: 4,
      distinctDayCount: 2,
      firstSeenAt: at(0, 10),
      lastSeenAt: at(1, 16),
    });
  });

  it('counts one AI activity as one occurrence however many events it has', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    h.timeline.push(activity(at(1, 10), [20, 21, 22, 23, 24], { aiActivityId: 'ai-7' }));
    h.setNow(at(1, 11));
    h.service.trackOccurrences();

    // The next hourly run extends the same activity with more events.
    h.timeline[h.timeline.length - 1] = activity(at(1, 10), [20, 21, 22, 23, 24, 25, 26], { aiActivityId: 'ai-7' });
    h.setNow(at(1, 12));
    h.service.trackOccurrences();

    expect(h.repo.candidates[0].occurrenceCount).toBe(2);
  });

  it('does not double-count an activity that is regrouped under a new id', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    h.timeline.push(activity(at(1, 10), [20, 21])); // deterministic session
    h.setNow(at(1, 11));
    h.service.trackOccurrences();

    // Gemini later turns the same events into an AI activity.
    h.timeline[h.timeline.length - 1] = activity(at(1, 10), [20, 21, 22], { aiActivityId: 'ai-9' });
    h.service.trackOccurrences();

    expect(h.repo.candidates[0].occurrenceCount).toBe(2);
  });

  it('ignores activities that do not match or are too short to mean anything', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(1, 9), 2, { primaryTitle: 'main.ts — reflect — Visual Studio Code', browserTabs: [] });
    addActivity(h, at(1, 10), 3, { activeDurationMs: 5_000 });
    h.setNow(at(1, 11));

    expect(h.service.trackOccurrences().occurrencesRecorded).toBe(0);
    expect(h.repo.candidates[0].occurrenceCount).toBe(1);
  });

  it('does nothing when there are no candidates', () => {
    const h = makeLearningHarness();
    addActivity(h, at(0, 10), 1);
    expect(h.service.trackOccurrences()).toEqual({ activitiesScanned: 0, occurrencesRecorded: 0 });
  });
});

describe('LearnedRuleService — correction tracking', () => {
  it('a further correction increments correction_count and last_correction_at', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(2, 10), 2);
    h.setNow(at(2, 11));

    const result = await correct(h, 2);

    expect(result).toMatchObject({ status: 'candidate', usedGemini: false });
    expect(h.repo.candidates[0]).toMatchObject({
      occurrenceCount: 2,
      correctionCount: 2,
      distinctDayCount: 2,
      lastCorrectionAt: at(2, 10),
    });
  });

  it('repeated processing does not double-count a correction', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(2, 10), 2);
    h.setNow(at(2, 11));

    await correct(h, 2);
    await correct(h, 2);
    h.service.trackOccurrences();
    h.service.trackOccurrences();

    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 2, correctionCount: 2 });
  });

  it('a correction seen first by tracking is still counted as a correction', async () => {
    const h = makeLearningHarness();
    await seedCandidate(h);
    addActivity(h, at(2, 10), 2, { classificationSource: 'user_override', classification: PERSONAL });
    h.setNow(at(2, 11));

    h.service.trackOccurrences();

    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 2, correctionCount: 2 });
  });
});

describe('LearnedRuleService — conflicting classifications', () => {
  it('a matching activity the user classified differently suppresses the candidate', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    expect(h.service.getCandidate(id)!.eligible).toBe(true);

    addActivity(h, at(1, 14), 3, { classificationSource: 'user_override', classification: WORK });
    h.setNow(at(1, 15));
    h.service.trackOccurrences();

    const view = h.service.getCandidate(id)!;
    expect(view).toMatchObject({ conflictCount: 1, occurrenceCount: 2, consistent: false, eligible: false });
    expect(view.blockedBy).toContain('inconsistent_classification');
    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.rules).toEqual([]);
  });

  it('the same pattern corrected two ways becomes two candidates, and neither is recommended', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    h.repo.candidates[0].conflictCount = 0;

    addActivity(h, at(1, 14), 3);
    h.gemini.push(proposal(GAME_THEORY_PATTERN));
    h.setNow(at(1, 15));
    const result = await correct(h, 3, WORK);

    expect(result).toMatchObject({ status: 'candidate', created: true });
    expect(h.repo.candidates).toHaveLength(2);
    expect(new Set(h.repo.candidates.map((c) => c.patternHash)).size).toBe(1);
    expect(new Set(h.repo.candidates.map((c) => c.classificationHash)).size).toBe(2);
    for (const view of h.service.listCandidates()) {
      expect(view.consistent).toBe(false);
      expect(view.eligible).toBe(false);
    }
    expect(h.service.listSuggestions()).toEqual([]);
  });

  it('removing the conflicting classification heals the candidate', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    const conflicting = addActivity(h, at(1, 14), 3, { classificationSource: 'user_override', classification: WORK });
    h.setNow(at(1, 15));
    h.service.trackOccurrences();
    expect(h.service.getCandidate(id)!.consistent).toBe(false);

    conflicting.classificationSource = 'ai';
    h.service.trackOccurrences();

    expect(h.service.getCandidate(id)).toMatchObject({ conflictCount: 0, occurrenceCount: 3, consistent: true, eligible: true });
  });
});

describe('LearnedRuleService — suggestions', () => {
  it('one correction and one occurrence is not enough', async () => {
    const h = makeLearningHarness();
    const id = await seedCandidate(h);
    h.setNow(at(0, 10, 20));
    expect(h.service.getCandidate(id)!.blockedBy).toEqual(['insufficient_evidence']);
    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.service.listSuggestions()).toEqual([]);
  });

  it('an eligible candidate is suggested while the matching activity is current', async () => {
    const h = makeLearningHarness();
    const id = await seedCandidate(h);
    addActivity(h, at(1, 10), 2);
    h.setNow(at(1, 10, 32));

    const suggestion = h.service.nextSuggestion();

    expect(suggestion).toEqual({
      candidateId: id,
      trigger: 'contextual',
      conditions: GAME_THEORY_PATTERN,
      patternLabel: 'VS Code + “GameTheory”',
      classification: PERSONAL,
      classificationLabel: 'Personal · Create · Focused',
      evidenceLabel: 'Seen 2 times across 2 days',
      occurrenceCount: 2,
      distinctDayCount: 2,
      correctionCount: 1,
      firstSeenAt: at(0, 10),
      lastSeenAt: at(1, 10),
    });
    expect(h.repo.candidates[0]).toMatchObject({ lastSuggestedAt: at(1, 10, 32), suggestionCount: 1 });
  });

  it('does not interrupt for an unrelated current activity during the day', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    addActivity(h, at(1, 13), 3, { primaryTitle: 'inbox — Mail', primaryApp: 'Mail', appsUsed: ['Mail'], browserTabs: [] });
    h.setNow(at(1, 13, 20));

    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.repo.candidates[0].suggestionCount).toBe(0);
  });

  it('surfaces candidates seen today at the end of the day', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.setNow(at(1, 19));

    expect(h.service.nextSuggestion()).toMatchObject({ candidateId: id, trigger: 'daily' });
  });

  it('the end-of-day suggestion only covers patterns seen that day', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    h.setNow(at(3, 19));

    expect(h.service.nextSuggestion()).toBeNull();
    // It is still listed on the Rules page.
    expect(h.service.listSuggestions()).toHaveLength(1);
  });

  it('the suggestion cooldown stops the same candidate being shown again', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    h.setNow(at(1, 19));
    expect(h.service.nextSuggestion()).not.toBeNull();

    h.setNow(at(1, 23));
    expect(h.service.nextSuggestion()).toBeNull();

    addActivity(h, at(3, 18), 5);
    h.setNow(at(3, 19));
    expect(h.service.nextSuggestion()).toBeNull(); // within the 7-day window

    addActivity(h, at(9, 18), 6);
    h.setNow(at(9, 19));
    expect(h.service.nextSuggestion()).not.toBeNull();
    expect(h.repo.candidates[0].suggestionCount).toBe(2);
  });

  it('the global cooldown prevents several suggestions in a row', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    // A second, independent eligible pattern.
    const tab = { primaryApp: 'Google Chrome', primaryBrowser: 'Chrome', primaryTitle: 'Operating Systems | Coursera', primaryUrl: 'coursera.org', appsUsed: ['Google Chrome'], browserTabs: ['coursera.org'] };
    h.timeline.push(activity(at(0, 14), [30], tab));
    h.events.events.push({ id: 30, watcher: 'window', startedAt: at(0, 14), endedAt: at(0, 14, 30), app: 'Google Chrome', browser: 'Chrome', title: tab.primaryTitle, url: 'coursera.org', payload: null, createdAt: null });
    h.gemini.push(proposal([{ type: 'domain_equals', value: 'coursera.org' }, { type: 'title_contains', value: 'Operating Systems' }]));
    await correct(h, 30, { contextId: null, areaId: 'area_personal', intentId: 'intent_learn', qualityId: 'quality_focused' });
    h.timeline.push(activity(at(1, 15), [31], tab));
    h.setNow(at(1, 19));
    h.service.trackOccurrences();
    expect(h.service.listSuggestions()).toHaveLength(2);

    expect(h.service.nextSuggestion()).not.toBeNull();
    h.setNow(at(1, 19, 30));
    expect(h.service.nextSuggestion()).toBeNull();

    // After the global cooldown the other candidate gets its turn.
    h.setNow(at(1, 23, 30));
    const second = h.service.nextSuggestion();
    expect(second).not.toBeNull();
    expect(h.repo.candidates.filter((c) => c.suggestionCount === 1)).toHaveLength(2);
  });

  it('two eligible candidates are chosen deterministically', async () => {
    const build = async () => {
      const h = makeLearningHarness();
      await seedEligible(h);
      const tab = { primaryApp: 'Google Chrome', primaryBrowser: 'Chrome', primaryTitle: 'YouTube', primaryUrl: 'youtube.com', appsUsed: ['Google Chrome'], browserTabs: ['youtube.com'] };
      h.timeline.push(activity(at(0, 14), [30], tab));
      h.events.events.push({ id: 30, watcher: 'window', startedAt: at(0, 14), endedAt: at(0, 14, 30), app: 'Google Chrome', browser: 'Chrome', title: 'YouTube', url: 'youtube.com', payload: null, createdAt: null });
      h.gemini.push(proposal([{ type: 'domain_equals', value: 'youtube.com' }]));
      await correct(h, 30, LEISURE);
      h.timeline.push(activity(at(1, 10), [31], tab)); // same recency as the first pattern
      h.setNow(at(1, 19));
      h.service.trackOccurrences();
      return h;
    };

    const first = await build();
    const second = await build();
    const order = first.service.listSuggestions().map((s) => s.candidateId);
    expect(order).toHaveLength(2);
    // Equal evidence → ordered by candidate id, on every run.
    expect(order).toEqual([...order].sort());
    expect(second.service.listSuggestions().map((s) => s.candidateId)).toEqual(order);
    expect(first.service.nextSuggestion()!.candidateId).toBe(order[0]);
    expect(second.service.nextSuggestion()!.candidateId).toBe(order[0]);
  });

  it('an existing matching rule suppresses the suggestion', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.rules.push({
      id: 'rule_user',
      activityId: '',
      conditions: JSON.stringify([...GAME_THEORY_PATTERN].reverse()),
      enabled: 1,
      priority: 10,
      areaId: 'area_personal',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user',
    });
    h.setNow(at(1, 19));

    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.service.listSuggestions()).toEqual([]);
    expect(h.service.getCandidate(id)).toMatchObject({ coveredByRule: true, eligible: false, blockedBy: ['covered_by_rule'] });
  });

  it('a system default with the same conditions does not suppress learning', async () => {
    const h = makeLearningHarness();
    await seedEligible(h);
    h.rules.push({ id: 'rule_coding', activityId: 'coding', conditions: JSON.stringify(GAME_THEORY_PATTERN), enabled: 1, priority: 0, areaId: null, intentId: null, qualityId: null, source: 'system' });
    expect(h.service.listSuggestions()).toHaveLength(1);
  });

  it('old candidates stay stored but are not suggested', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.setNow(at(45, 19));

    expect(h.service.listSuggestions()).toEqual([]);
    expect(h.service.getCandidate(id)!.blockedBy).toEqual(['not_recent']);
    expect(h.repo.candidates).toHaveLength(1);
  });
});

describe('LearnedRuleService — confirmation', () => {
  it('creates exactly one learned rule and links it to the candidate', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);

    const result = h.service.confirmCandidate(id);

    expect(result.created).toBe(true);
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({
      id: result.ruleId,
      source: 'learned',
      enabled: 1,
      activityId: '',
      areaId: 'area_personal',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      learned: { candidateId: id, confirmedAt: at(1, 11) },
    });
    expect(JSON.parse(h.rules[0].conditions)).toEqual(GAME_THEORY_PATTERN);
    expect(h.repo.candidates[0]).toMatchObject({ status: 'confirmed', confirmedRuleId: result.ruleId });
    expect(h.rulesChanged.count).toBe(1);
  });

  it('confirming twice does not create two rules', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);

    const first = h.service.confirmCandidate(id);
    const second = h.service.confirmCandidate(id);

    expect(second).toEqual({ ruleId: first.ruleId, created: false });
    expect(h.rules).toHaveLength(1);
    expect(h.rulesChanged.count).toBe(1);
  });

  it('the learned rule classifies future activities through the deterministic engine', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    const { ruleId } = h.service.confirmCandidate(id);

    const rules: CategorizationRule[] = h.rules.map((r) => ({
      id: r.id,
      source: r.source,
      conditions: JSON.parse(r.conditions),
      contextId: r.activityId || null,
      areaId: r.areaId,
      intentId: r.intentId,
      qualityId: r.qualityId,
      priority: r.priority,
      enabled: r.enabled === 1,
    }));
    const engine = new ClassificationEngine();
    const classify = (title: string) =>
      engine.classify({
        session: toSessionLike(activity(at(5, 10), [99], { primaryTitle: title })),
        rules,
        overrides: [],
        contexts: ACTIVITIES,
        dimensions: DIMENSIONS,
        focusSignals: [],
      });

    const future = classify('payoff.py — GameTheory — Visual Studio Code');
    expect(future).toMatchObject({
      source: 'user_rule',
      matchedRuleId: ruleId,
      area: { id: 'area_personal' },
      intent: { id: 'intent_create' },
      quality: { id: 'quality_focused' },
    });
    expect(future.reason).toMatch(/^Learned rule:/);
    expect(classify('main.ts — reflect — Visual Studio Code').source).toBe('unclassified');
  });

  it('a confirmed candidate is no longer suggested but keeps counting matches', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.service.confirmCandidate(id);

    addActivity(h, at(2, 10), 3);
    h.setNow(at(2, 19));
    h.service.trackOccurrences();

    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.service.listSuggestions()).toEqual([]);
    expect(h.repo.candidates[0]).toMatchObject({ status: 'confirmed', occurrenceCount: 3, distinctDayCount: 3, correctionCount: 1 });
  });

  it('refuses to create a duplicate of an existing rule, and rolls back', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.rules.push({ id: 'rule_user', activityId: '', conditions: JSON.stringify(GAME_THEORY_PATTERN), enabled: 1, priority: 10, areaId: 'area_personal', intentId: 'intent_create', qualityId: 'quality_focused', source: 'user' });

    expect(() => h.service.confirmCandidate(id)).toThrow(/already covers/);
    expect(h.rules).toHaveLength(1);
    expect(h.repo.candidates[0].status).toBe('pending');
  });

  it('revalidates conditions and classification before creating the rule', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);

    h.repo.candidates[0].conditions = [{ type: 'mood_equals', value: 'focused' }];
    expect(() => h.service.confirmCandidate(id)).toThrow(/no longer valid/);

    h.repo.candidates[0].conditions = GAME_THEORY_PATTERN;
    h.repo.candidates[0].classification = { ...PERSONAL, areaId: 'area_deleted' };
    expect(() => h.service.confirmCandidate(id)).toThrow(/classification/);

    expect(() => h.service.confirmCandidate('lrc_missing')).toThrow(/not found/);
    expect(h.rules).toEqual([]);
  });
});

describe('LearnedRuleService — rejection', () => {
  it('"Not now" snoozes the candidate and it can return later', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);

    h.service.snoozeCandidate(id);

    expect(h.repo.candidates[0]).toMatchObject({ status: 'snoozed', snoozedUntil: at(8, 11) });
    expect(h.rules).toEqual([]);
    h.setNow(at(1, 19));
    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.service.listSuggestions()).toEqual([]);

    // Still supported after the snooze → eligible again.
    addActivity(h, at(9, 10), 3);
    h.setNow(at(9, 10, 31));
    expect(h.service.nextSuggestion()).toMatchObject({ candidateId: id, trigger: 'contextual' });
  });

  it('"Never suggest this" dismisses the candidate for good', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);

    h.service.dismissCandidate(id);

    expect(h.repo.candidates[0].status).toBe('dismissed');
    expect(h.rules).toEqual([]);
    addActivity(h, at(20, 10), 3);
    h.setNow(at(20, 19));
    h.service.trackOccurrences();
    expect(h.service.nextSuggestion()).toBeNull();
    expect(h.service.listSuggestions()).toEqual([]);
    expect(h.repo.candidates[0].occurrenceCount).toBe(2); // gathers no further evidence
    expect(() => h.service.confirmCandidate(id)).toThrow(/dismissed/);
  });

  it('a later correction of a dismissed pattern does not ask Gemini again', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.service.dismissCandidate(id);
    addActivity(h, at(2, 10), 3);

    expect(await correct(h, 3)).toEqual({ status: 'candidate', candidateId: id, created: false, usedGemini: false });
    expect(h.gemini.requests).toHaveLength(1);
    expect(h.repo.candidates[0].status).toBe('dismissed');
  });

  it('a dismissed candidate comes back only through explicit reactivation', async () => {
    const h = makeLearningHarness();
    const id = await seedEligible(h);
    h.service.dismissCandidate(id);

    h.service.reactivateCandidate(id);

    expect(h.repo.candidates[0].status).toBe('pending');
    expect(h.service.listSuggestions().map((s) => s.candidateId)).toEqual([id]);
  });
});

describe('LearnedRuleService — end to end (VS Code + GameTheory)', () => {
  it('correction → candidate → second day → suggestion → Remember → learned rule', async () => {
    const h = makeLearningHarness();

    // Day 1: Gemini said Work/Create/Focused; the user says Personal and
    // leaves "Remember for future" unchecked.
    addActivity(h, at(0, 10), 1, { aiActivityId: 'ai-day1', classification: WORK });
    h.gemini.push(proposal(GAME_THEORY_PATTERN));
    h.setNow(at(0, 11));
    const observed = await correct(h, 1);
    expect(observed).toMatchObject({ status: 'candidate', created: true });
    const id = (observed as { candidateId: string }).candidateId;

    expect(h.repo.candidates[0]).toMatchObject({
      occurrenceCount: 1,
      correctionCount: 1,
      firstSeenAt: at(0, 10),
      lastSeenAt: at(0, 10),
    });
    expect(h.service.nextSuggestion()).toBeNull(); // no suggestion yet
    expect(h.rules).toEqual([]);

    // Day 2: the same pattern occurs. Gemini still calls it Work.
    addActivity(h, at(1, 10), 2, { aiActivityId: 'ai-day2', classification: WORK });
    h.setNow(at(1, 10, 31));
    h.service.trackOccurrences();
    expect(h.repo.candidates[0]).toMatchObject({ occurrenceCount: 2, distinctDayCount: 2, correctionCount: 1 });

    const suggestion = h.service.nextSuggestion();
    expect(suggestion).toMatchObject({
      candidateId: id,
      patternLabel: 'VS Code + “GameTheory”',
      classificationLabel: 'Personal · Create · Focused',
      evidenceLabel: 'Seen 2 times across 2 days',
    });

    // The user clicks Remember.
    const { ruleId, created } = h.service.confirmCandidate(id);
    expect(created).toBe(true);
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({ id: ruleId, source: 'learned', areaId: 'area_personal', intentId: 'intent_create', qualityId: 'quality_focused' });
    expect(JSON.parse(h.rules[0].conditions)).toEqual(GAME_THEORY_PATTERN);
    expect(h.repo.candidates[0]).toMatchObject({ status: 'confirmed', confirmedRuleId: ruleId });

    // Gemini was needed exactly once — to generalise the correction.
    expect(h.gemini.requests).toHaveLength(1);
  });
});
