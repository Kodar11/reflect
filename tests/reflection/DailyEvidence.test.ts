import { describe, it, expect } from 'vitest';
import { buildRecentDayMetrics, describeFocusSession } from '../../src/reflection/ReflectionMetrics';
import type { MetricSet } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import {
  buildReflectionPrompt,
  buildReflectionResponseSchema,
  buildReflectionSystemInstruction,
  type CoachPromptParts,
} from '../../src/reflection/ReflectionPrompt';
import { prepareReflection } from '../../src/reflection/ReflectionPreprocessor';
import { DEFAULT_REFLECTION_CONFIG } from '../../src/reflection/ReflectionModels';
import { validateReflectionOutput } from '../../src/reflection/ReflectionValidator';
import {
  TAXONOMY,
  browsing,
  focusSession,
  iso,
  local,
  makeReflectionHarness,
  modelInsight,
  modelReflection,
  projectY,
  research,
  seedThreads,
  workday,
} from './helpers';

/**
 * The deterministic evidence a day's intelligence is written from: the days
 * just before it (so "this has happened three times recently" is a
 * measurement), each Focus session one by one, and the narrative's rules.
 */
const day12 = periodContaining('day', local(12));

function harness(activities = [5, 6, 7, 8, 9, 12].flatMap(workday)) {
  const h = makeReflectionHarness({ activities, now: local(12, '22:05'), priorities: ['Launching Project X'] });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0].id });
  return { ...h, priorities, priorityId: priorities[0].id };
}

describe('recent days — history a day can cite', () => {
  it('gives a day the days before it, one by one, as deterministic measurements', async () => {
    const h = harness();
    const dataset = await h.metrics.computeDataset(day12, iso(12, '22:05'), h.priorities);
    const m = dataset.metrics;

    // Sat Oct 10 and Sun Oct 11 had nothing tracked: 5 of the previous 7 days were active.
    expect(m['recent.active_days']).toMatchObject({ value: 5, label: 'Days with tracked activity in the previous 7 days' });
    expect(m['recent.2026-10-09.tracked_minutes']).toMatchObject({ label: 'Tracked time — Fri, Oct 9', display: '4h 32m', group: 'series' });
    expect(m['recent.2026-10-09.switches'].display).toBe('6');
    expect(m['recent.2026-10-09.top_thread']).toMatchObject({ value: 'Project X', display: 'Project X (2h 52m)' });
    expect(m['recent.2026-10-10.tracked_minutes']).toBeUndefined(); // absent data is absent, never zero
    expect(m['recent.2026-10-04.tracked_minutes']).toBeUndefined(); // before tracking began

    // How often what matters showed up — the basis for "this keeps happening" and "this disappeared".
    expect(m[`recent.priority.${h.priorityId}.active_days`]).toMatchObject({
      label: 'Days with work linked to the priority “Launching Project X” in the previous 7 days',
      value: 5,
      display: '5 of 5',
      priorityId: h.priorityId,
    });
    expect(m[`recent.priority.${h.priorityId}.minutes`].display).toBe('14h 20m');
    expect(m[`recent.priority.${h.priorityId}.last_day`].display).toBe('Fri, Oct 9');
    expect(m['recent.thread.project-x.active_days'].display).toBe('5 of 5');
  });

  it('shows when something that mattered stopped appearing', async () => {
    const quiet = (d: number) => [projectY(d, '09:00', 60), research(d, '10:30', 40), browsing(d, '13:00', 30)];
    const h = harness([...[5, 6, 7].flatMap(workday), ...[8, 9, 12].flatMap(quiet)]);
    const m = (await h.metrics.computeDataset(day12, iso(12, '22:05'), h.priorities)).metrics;
    expect(m[`recent.priority.${h.priorityId}.active_days`].display).toBe('3 of 5');
    expect(m[`recent.priority.${h.priorityId}.last_day`]).toMatchObject({ display: 'Wed, Oct 7', range: { start: iso(7), end: iso(8) } });
  });

  it('is a day-level view only, and the model can cite it', async () => {
    const h = harness();
    const week = periodContaining('week', local(7));
    h.setNow(local(12, '09:00'));
    const weekly = await h.metrics.computeDataset(week, week.end, h.priorities);
    expect(Object.keys(weekly.metrics).filter((k) => k.startsWith('recent.'))).toEqual([]);

    h.setNow(local(12, '22:05'));
    const dataset = await h.metrics.computeDataset(day12, iso(12, '22:05'), h.priorities);
    const prepared = prepareReflection(dataset, {
      userContext: null,
      taxonomy: TAXONOMY,
      config: DEFAULT_REFLECTION_CONFIG,
      nowIso: iso(12, '22:05'),
      previousReport: null,
      recentReports: [],
      feedback: [],
      learnedPatterns: ['VS Code is usually Coding'],
      explicitRules: ['youtube.com is Leisure'],
    });
    const prompt = buildReflectionPrompt(prepared.input);
    expect(prompt).toContain('{"key":"recent.active_days","label":"Days with tracked activity in the previous 7 days","value":"5"}');
    expect(prompt).toContain('EXPLICIT RULES (written by the user — authoritative; context only, do not report them back)\n- youtube.com is Leisure');
    expect(prompt).toContain('LEARNED PATTERNS');

    // A claim about recent days validates only against those measurements.
    const insight = (observation: string) =>
      validateReflectionOutput(
        modelReflection(day12, {
          insights: [modelInsight({ type: 'consistency_momentum', title: 'Project X showed up on every recent working day', observation, interpretation: 'It has been a steady thread.', metricKeys: ['recent.thread.project-x.active_days'] })],
        }),
        { period: day12, metrics: dataset.metrics, activityByRef: prepared.activityByRef, priorities: dataset.priorities, maxInsights: 4, recentSignatures: new Map(), periodLabel: 'Today Mon, Oct 12' },
      );
    expect(insight('Work on Project X appeared on 5 of 5 recent days.').ok).toBe(true);
    expect(insight('Work on Project X appeared on 9 of the last 10 days.').ok).toBe(false);
  });

  it('says nothing when there are no earlier days', () => {
    expect(buildRecentDayMetrics({ days: [], priorities: [], threads: [], lookback: 7 })).toEqual({});
  });
});

describe('Focus sessions — planned vs actual, one by one', () => {
  it('describes each session of a day, including one that was ended early', async () => {
    const h = harness();
    h.focusSessions.push(
      focusSession(12, '09:00', 45),
      focusSession(12, '13:00', 60, { id: 'focus-early', task: 'Billing fix', elapsedMs: 18 * 60_000, state: 'cancelled', endReason: 'ended-early', endNote: 'call came in' }),
    );
    h.interruptions['focus-12-09:00'] = [
      { id: 'i1', sessionId: 'focus-12-09:00', type: 'pause', reason: null, occurredAt: iso(12, '09:20'), idleMs: null, createdAt: iso(12, '09:20') },
      { id: 'i2', sessionId: 'focus-12-09:00', type: 'resume', reason: null, occurredAt: iso(12, '09:22'), idleMs: null, createdAt: iso(12, '09:22') },
    ];

    const m = (await h.metrics.computeCore(day12, iso(12, '22:05'), h.priorities)).metrics;
    expect(m['focus.s1']).toMatchObject({
      label: 'Focus session “Project X” (Mon, Oct 12, 9:00 AM)',
      display: '45m of 45m planned · 1 interruption · ran its full planned time',
      range: { start: iso(12, '09:00'), end: iso(12, '09:45') },
    });
    expect(m['focus.s2'].display).toBe('18m of 1h planned · ended early · note: “call came in”');
    // The aggregate Focus numbers still count only sessions that ran their course.
    expect(m['focus.session_count'].value).toBe(1);
    expect(m['focus.total_minutes'].display).toBe('45m');
  });

  it('ignores a session that was started and dropped at once, and is silent for longer periods', async () => {
    const h = harness();
    h.focusSessions.push(focusSession(12, '09:00', 45, { elapsedMs: 20_000, state: 'cancelled', endReason: 'ended-early' }));
    const m = (await h.metrics.computeCore(day12, iso(12, '22:05'), h.priorities)).metrics;
    expect(m['focus.s1']).toBeUndefined();

    h.focusSessions.push(focusSession(7, '09:00', 45));
    h.setNow(local(12, '09:00'));
    const week = periodContaining('week', local(7));
    expect((await h.metrics.computeCore(week, week.end, h.priorities)).metrics['focus.s1']).toBeUndefined();
  });

  it('phrases a stopwatch session and a running one plainly', () => {
    const base = { id: 'f', task: 'X', startedAt: iso(12, '09:00'), endedAt: iso(12, '09:40'), elapsedMinutes: 40, interruptionCount: 0, blockedAttemptCount: 2 };
    expect(describeFocusSession({ ...base, plannedMinutes: null, endReason: 'finished' })).toBe('40m, no time limit · 2 blocked attempts · ended by you');
    expect(describeFocusSession({ ...base, plannedMinutes: 60, endReason: null, blockedAttemptCount: 0 })).toBe('40m of 1h planned · still running');
  });
});

describe('narrative — "what happened"', () => {
  const metrics: MetricSet = {
    'time.tracked_minutes': { key: 'time.tracked_minutes', label: 'Total tracked time', value: 272, unit: 'minutes', display: '4h 32m', group: 'time' },
    'behavior.switches': { key: 'behavior.switches', label: 'Context switches', value: 6, unit: 'count', display: '6', group: 'behavior' },
    'thread.project-x.minutes': { key: 'thread.project-x.minutes', label: 'Time on “Project X”', value: 172, unit: 'minutes', display: '2h 52m', group: 'thread' },
    'thread.project-y.minutes': { key: 'thread.project-y.minutes', label: 'Time on “Project Y”', value: 55, unit: 'minutes', display: '55m', group: 'thread' },
  };
  const validate = (narrative: string | null) =>
    validateReflectionOutput(modelReflection(day12, { narrative }), {
      period: day12,
      metrics,
      activityByRef: new Map(),
      priorities: [],
      maxInsights: 4,
      recentSignatures: new Map(),
      periodLabel: 'Today Mon, Oct 12',
    });

  it('keeps a narrative that quotes only the day\'s plain totals and what the insights cite', () => {
    const result = validate('You tracked 4h 32m today, with 6 context switches. Project X took the morning.');
    expect(result).toMatchObject({ ok: true, reflection: { narrative: 'You tracked 4h 32m today, with 6 context switches. Project X took the morning.' } });
    expect(validate(null)).toMatchObject({ ok: true, reflection: { narrative: null } });
  });

  it('leaves out a sentence that states a number nothing supports, a cause or a judgment — the report is kept', () => {
    // 55m exists as a metric, but no insight cites it, it is not one of the day's plain totals and no activity ran 55m.
    const number = validate('You spent 55m on Project Y after lunch.');
    expect(number).toMatchObject({ ok: true, reflection: { narrative: null, headline: 'Project X received most of your tracked time this period.' } });
    expect(number.ok && number.repairs).toEqual([
      { code: 'narrative_number', field: 'narrative', index: null, values: ['55'], message: 'narrative: number(s) "55" not found in the period\'s evidence', resolution: 'repaired' },
    ]);

    for (const text of ['The afternoon fragmented because you were distracted by video.', 'You wasted most of the afternoon on videos again.']) {
      const result = validate(text);
      expect(result).toMatchObject({ ok: true, reflection: { narrative: null } });
      expect(result.ok && result.repairs?.[0].code).toBe('narrative_language');
    }
  });

  it('removes only the unsupported sentence of a narrative', () => {
    const result = validate('You tracked 4h 32m today, with 6 context switches. You spent 55m on Project Y after lunch. Project X took the morning.');
    expect(result).toMatchObject({ ok: true, reflection: { narrative: 'You tracked 4h 32m today, with 6 context switches. Project X took the morning.' } });
  });
});

describe('the unified daily request', () => {
  const coach: CoachPromptParts = {
    systemInstruction: 'THE COACH\nDecide what is worth trying next.',
    promptSection: 'COACH CONTEXT\nPREVIOUS ACTIONS\nNone to follow up.',
    responseSchema: { type: 'object', properties: { actions: { type: 'array' } }, required: ['actions'] },
  };

  it('on its own, a reflection keeps its single carry-forward', () => {
    const instruction = buildReflectionSystemInstruction();
    expect(instruction).toContain('CARRY FORWARD\nAt most ONE carry-forward');
    expect(instruction).not.toContain('THE COACH');
    expect(instruction).toContain('For a DAY, write "narrative"');
  });

  it('with a coach, one request carries both — and the carry-forward gives way to tracked actions', async () => {
    const instruction = buildReflectionSystemInstruction(coach);
    expect(instruction).toContain('You are Reflect, a personal activity reflection system.');
    expect(instruction).toContain('CARRY FORWARD\nUse null.');
    expect(instruction).not.toContain('At most ONE carry-forward');
    expect(instruction.endsWith('THE COACH\nDecide what is worth trying next.')).toBe(true);

    const h = harness();
    const dataset = await h.metrics.computeDataset(day12, iso(12, '22:05'), h.priorities);
    const prepared = prepareReflection(dataset, {
      userContext: null, taxonomy: TAXONOMY, config: DEFAULT_REFLECTION_CONFIG, nowIso: iso(12, '22:05'),
      previousReport: null, recentReports: [], feedback: [], learnedPatterns: [],
    });
    const prompt = buildReflectionPrompt(prepared.input, coach);
    expect(prompt.endsWith('COACH CONTEXT\nPREVIOUS ACTIONS\nNone to follow up.')).toBe(true);
    expect(prompt.indexOf('ACTIVITIES')).toBeLessThan(prompt.indexOf('COACH CONTEXT'));

    const schema = buildReflectionResponseSchema(['p1'], coach) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required.at(-1)).toBe('coach');
    expect(schema.properties.coach).toBe(coach.responseSchema);
  });
});
