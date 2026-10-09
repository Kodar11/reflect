import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAnswerKeyVocabulary } from './evaluators/index';
import { loadConfig, personaDatasetDirs } from './runner/config';
import { spawnSync } from 'node:child_process';
import { buildLeakDetector } from './evaluators/leakage';
import {
  DatasetValidationError,
  PERSONA_KEY_FILE,
  applyProfileUpdate,
  initialProfileState,
  loadDataset,
  profileByDay,
  splitDataset,
  validateDataset,
  type DatasetDayFile,
  type DatasetProfileUpdate,
  type ProfileState,
} from './runner/dataset';

/**
 * Dataset validation. Needs no database and no Gemini, so it runs with the
 * ordinary test suite (and on its own through `npm run benchmark:validate`).
 *
 * The first block validates the real dataset on disk and fails loudly, with
 * every problem listed, when it is not fit to benchmark against. The second
 * proves the validator catches each kind of defect — and repairs none.
 */

const config = loadConfig();

/** The configured dataset, or — `npm run benchmark:validate -- --all` — every persona directory. */
const datasets = (process.env.REFLECT_BENCH_ALL_PERSONAS === '1' ? personaDatasetDirs() : [config.datasetDir]).map((dir) => ({ name: path.basename(dir), dir }));
const LISTED_ERRORS = 40;

describe.each(datasets)('benchmark dataset on disk — $name', ({ name, dir }) => {
  const result = validateDataset(dir, config.expectedDays);

  it(`has ${config.expectedDays} valid day files`, () => {
    const byCode = new Map<string, number>();
    for (const e of result.errors) byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
    const counts = [...byCode].sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code} ×${n}`).join(', ');
    const failing = new Set(result.errors.map((e) => e.file)).size;
    console.log(`[benchmark:validate] ${name}: ${result.stats.days} file(s), ${result.stats.rawEvents} raw events, ${result.errors.length} error(s)${counts ? ` in ${failing} file(s) — ${counts}` : ''}, ${result.warnings.length} warning(s)`);
    const listing = result.errors.slice(0, LISTED_ERRORS).map((e) => `[${e.code}] ${e.file} ${e.where}: ${e.message}`).join('\n');
    const more = result.errors.length > LISTED_ERRORS ? `\n… and ${result.errors.length - LISTED_ERRORS} more` : '';
    expect(result.errors.length, `Dataset errors (${counts}):\n${listing}${more}\n`).toBe(0);
    expect(result.stats.days).toBe(config.expectedDays);
  });

  it('uses only coach action types the evaluator can read, and says how much of the classification it can score', () => {
    if (!result.dataset) return; // already reported by the test above
    const vocabulary = checkAnswerKeyVocabulary(splitDataset(result.dataset).evaluation);
    const scorable = Object.entries(vocabulary.classification)
      .map(([dimension, c]) => `${dimension} ${c.activities - c.unmapped}/${c.activities}`)
      .join(', ');
    console.log(`[benchmark:validate] ${name}: classification labels the evaluator can score — ${scorable}`);
    expect(vocabulary.errors, vocabulary.errors.join('\n')).toEqual([]);
  });

  it('splits into an input half that carries no answer-key field', () => {
    if (!result.dataset) return;
    const { input, evaluation } = splitDataset(result.dataset);
    expect(Object.keys(input).sort()).toEqual(['days', 'persona', 'utcOffset']);
    expect(Object.keys(input.days[0]).sort()).toEqual(['date', 'dayNumber', 'profileUpdates', 'rawEvents']);
    expect(Object.keys(input.days[0].rawEvents[0]).sort()).toEqual(['app', 'browser', 'datasetId', 'endedAt', 'startedAt', 'title', 'url', 'watcher']);
    const serialized = JSON.stringify(input);
    // As field names: a window title may well say "Expected Calibration Error".
    for (const forbidden of ['ground_truth', 'groundTruth', 'expected_reflection', 'expectedReflection', 'expected_coach_outcome', 'expectedCoachOutcome', 'day_type', 'dayType', 'circumstances', 'things_not_to_do', 'importance', 'statedPriorities', 'profilePriorities', 'stream', 'target_stream', 'work_streams', 'label_notes', 'acceptable_streams', 'forbidden_streams', 'action_opportunity', 'execution_scenario', 'aliases']) {
      expect(serialized).not.toContain(`"${forbidden}":`);
    }
    // Only day 1's profile is Reflect's: what a later file says the day was about stays in the answer key.
    for (const day of result.dataset.days.slice(1)) {
      for (const text of [...(day.persona.priorities ?? []), ...(day.persona.current_work ?? [])]) {
        if (![...input.persona.priorities, ...input.persona.current_work].includes(text)) expect(serialized).not.toContain(JSON.stringify(text));
      }
    }
    // No ground-truth sentence appears in the input half.
    for (const day of evaluation.days) {
      for (const activity of day.groundTruth.activities) expect(serialized).not.toContain(activity.summary);
      for (const observation of day.expectedReflection.key_observations) expect(serialized).not.toContain(observation);
    }
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.days[0].rawEvents[0])).toBe(true);
  });
});

// ── The validator itself ────────────────────────────────────────────────────

function makeDay(n: number): DatasetDayFile {
  const date = `2026-09-0${n}`;
  const at = (hhmm: string) => `${date}T${hhmm}:00+05:30`;
  const base = (n - 1) * 10;
  return {
    persona: { id: 'p1', type: 'founder_freelancer', role: 'Solo founder', current_work: ['Building a SaaS'], priorities: ['Ship the SaaS MVP'] },
    day: {
      day_number: n,
      date,
      day_type: 'normal_day',
      circumstances: ['An ordinary day'],
      laptop_usage: { first_seen: '09:00', last_seen: '11:00', approx_active_hours: 1.5, longest_unobserved_gap_minutes: 30 },
    },
    raw_events: [
      { id: base + 1, watcher: 'desktop', started_at: at('09:00'), ended_at: at('09:30'), app: 'VS Code', browser: null, title: 'saas-app — a.ts', url: null, payload: null },
      { id: base + 2, watcher: 'desktop', started_at: at('09:30'), ended_at: at('10:00'), app: 'Chrome', browser: 'Chrome', title: 'Docs', url: 'https://docs.example.com/x', payload: null },
      { id: base + 3, watcher: 'desktop', started_at: at('10:30'), ended_at: at('11:00'), app: 'Slack', browser: null, title: 'Client workspace', url: null, payload: null },
    ],
    ground_truth: {
      activities: [
        { id: 'gt-1', started_at: '09:00', ended_at: '10:00', title: 'Build', summary: 'Built a feature.', event_ids: [base + 1, base + 2], context: 'Work', area: 'Own SaaS', intent: 'Create', quality: 'Focused', importance: 'high' },
        { id: 'gt-2', started_at: '10:30', ended_at: '11:00', title: 'Client chat', summary: 'Talked to the client.', event_ids: [base + 3], context: 'Work', area: 'Freelance', intent: 'Communicate', quality: 'Routine', importance: 'medium' },
      ],
      unobserved_periods: [{ started_at: '10:00', ended_at: '10:30', reason: 'Offline' }],
    },
    expected_reflection: {
      period: 'today',
      key_observations: ['Product work moved forward.'],
      priority_alignment: [{ priority: 'Ship the SaaS MVP', assessment: 'meaningful progress' }],
      important_uncertainty: ['The offline period is unobserved.'],
      possible_next_step: 'Protect a block for the SaaS tomorrow.',
    },
    expected_coach_outcome: {
      primary_action: { title: 'Protect a SaaS block', action_type: 'protect_priority', reason: 'It moved forward.', suggested_focus_minutes: 60, target: 'Own SaaS' },
      secondary_action: null,
      things_not_to_do: ['Do not claim that offline time was wasted.'],
    },
  };
}

describe('dataset validator', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a two-day dataset, optionally changed, and return the error codes found. */
  function codes(change: (days: DatasetDayFile[]) => void, files?: (days: DatasetDayFile[]) => Record<string, string>): string[] {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-bench-dataset-'));
    const days = [makeDay(1), makeDay(2)];
    change(days);
    const written = files ? files(days) : Object.fromEntries(days.map((d, i) => [`reflect_day_0${i + 1}.json`, JSON.stringify(d)]));
    for (const [name, text] of Object.entries(written)) fs.writeFileSync(path.join(dir, name), text);
    return validateDataset(dir, 2).errors.map((e) => e.code);
  }

  it('accepts a well-formed dataset and reports its version', () => {
    expect(codes(() => {})).toEqual([]);
    const { dataset, validation } = loadDataset(dir, 2);
    expect(validation.stats).toMatchObject({ days: 2, rawEvents: 6, groundTruthActivities: 4, firstDate: '2026-09-01', lastDate: '2026-09-02', utcOffset: '+05:30' });
    expect(dataset.version).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('requires exactly the expected number of days, correctly numbered and ordered', () => {
    expect(codes(() => {}, (days) => ({ 'reflect_day_01.json': JSON.stringify(days[0]) }))).toEqual(expect.arrayContaining(['day_count', 'missing_day']));
    expect(codes((days) => (days[1].day.day_number = 1))).toEqual(expect.arrayContaining(['day_number_mismatch', 'duplicate_day_number']));
    expect(codes((days) => (days[1].day.date = '2026-09-01'))).toContain('duplicate_date');
    expect(codes((days) => (days[0].day.date = '2026-09-05'))).toContain('date_order');
    expect(codes(() => {}, (days) => ({ 'reflect_day_01.json': JSON.stringify(days[0]), 'reflect_day_02.json': '{not json' }))).toContain('invalid_json');
    expect(codes(() => {}, (days) => ({ 'reflect_day_01.json': JSON.stringify(days[0]), 'reflect_day_02.json': JSON.stringify(days[1]), 'notes.json': '{}' }))).toContain('unexpected_file');
  });

  it('accepts the persona in the file name, and refuses two files for one day', () => {
    expect(codes(() => {}, (days) => ({ 'reflect_student_day_01.json': JSON.stringify(days[0]), 'reflect_software_developer_day_02.json': JSON.stringify(days[1]) }))).toEqual([]);
    expect(
      codes(() => {}, (days) => ({ 'reflect_day_01.json': JSON.stringify(days[0]), 'reflect_day_02.json': JSON.stringify(days[1]), 'reflect_student_day_02.json': JSON.stringify(days[1]) })),
    ).toContain('duplicate_day_file');
  });

  it('requires every section', () => {
    expect(codes((days) => delete (days[0] as Partial<DatasetDayFile>).expected_coach_outcome)).toContain('missing_section');
    expect(codes((days) => delete (days[0] as Partial<DatasetDayFile>).ground_truth)).toContain('missing_section');
  });

  it('rejects malformed and placeholder timestamps instead of guessing them', () => {
    expect(codes((days) => (days[0].ground_truth.activities[0].ended_at = '16:??'))).toContain('malformed_time');
    expect(codes((days) => (days[0].raw_events[0].started_at = '2026-09-01 09:00'))).toContain('malformed_time');
    expect(codes((days) => (days[0].raw_events[0].started_at = '2026-09-01T09:00:00'))).toContain('malformed_time');
    expect(codes((days) => (days[0].ground_truth.unobserved_periods[0].ended_at = 'TBD'))).toContain('malformed_time');
  });

  it('checks raw events: unique ids, start before end, chronological, on the day', () => {
    expect(codes((days) => (days[1].raw_events[0].id = 1))).toContain('duplicate_event_id');
    expect(codes((days) => (days[0].raw_events[0].ended_at = '2026-09-01T08:00:00+05:30'))).toContain('event_range');
    expect(codes((days) => days[0].raw_events.reverse())).toEqual(expect.arrayContaining(['event_order']));
    expect(codes((days) => (days[0].raw_events[1].started_at = '2026-09-01T09:20:00+05:30'))).toContain('event_overlap');
    expect(codes((days) => (days[0].raw_events[2].ended_at = '2026-09-02T00:10:00+05:30'))).toContain('event_off_date');
    expect(codes((days) => (days[1].raw_events[0].started_at = '2026-09-02T09:00:00+00:00'))).toContain('mixed_utc_offsets');
    expect(codes((days) => ((days[0].raw_events[0] as unknown as Record<string, unknown>).label = 'Work'))).toContain('event_field_unknown');
  });

  it('checks ground truth: references exist, one owner per event, stated range matches the events', () => {
    expect(codes((days) => days[0].ground_truth.activities[0].event_ids.push(999))).toContain('dangling_event_reference');
    expect(codes((days) => days[0].ground_truth.activities[1].event_ids.push(1))).toContain('event_owned_twice');
    expect(codes((days) => (days[0].ground_truth.activities[0].ended_at = '10:15'))).toContain('activity_range_mismatch');
    expect(codes((days) => (days[0].ground_truth.activities[0].started_at = '11:00'))).toContain('activity_range');
    expect(codes((days) => (days[0].ground_truth.activities[0].event_ids = []))).toContain('activity_event_ids');
    expect(codes((days) => (days[0].ground_truth.activities[1].id = 'gt-1'))).toContain('duplicate_activity_id');
    expect(codes((days) => (days[0].ground_truth.unobserved_periods[0].started_at = '09:45'))).toContain('unobserved_overlaps_event');
  });

  it('checks the expected reflection and coach outcome', () => {
    expect(codes((days) => (days[0].expected_reflection.key_observations = []))).toContain('expected_reflection_field');
    expect(codes((days) => (days[0].expected_reflection.priority_alignment[0].priority = 'Something else'))).toContain('unknown_priority');
    expect(codes((days) => delete (days[0].expected_coach_outcome as Partial<DatasetDayFile['expected_coach_outcome']>).secondary_action)).toContain('expected_coach_field');
    expect(codes((days) => (days[0].expected_coach_outcome.primary_action!.title = ''))).toContain('expected_action_field');
  });

  it('lets a later day restate its priorities, keeps them out of the input, and refuses a different person', () => {
    expect(codes((days) => (days[1].persona.role = 'Somebody else'))).toContain('persona_changed');
    expect(codes((days) => delete (days[0].persona as { priorities?: string[] }).priorities)).toContain('persona_shape');
    // Day 2 says what it was about in its own words; its alignment has to use those words.
    expect(codes((days) => (days[1].persona.priorities = ['Close the beta feedback loop']))).toContain('unknown_priority');
    expect(
      codes((days) => {
        days[1].persona.priorities = ['Close the beta feedback loop'];
        days[1].expected_reflection.priority_alignment = [{ priority: 'Close the beta feedback loop', assessment: 'strong progress' }, 'Client work stayed contained.'];
      }),
    ).toEqual([]);
    const { input, evaluation } = splitDataset(loadDataset(dir, 2).dataset);
    expect(input.persona.priorities).toEqual(['Ship the SaaS MVP']);
    expect(JSON.stringify(input)).not.toContain('beta feedback');
    expect(evaluation.days[1].statedPriorities).toEqual(['Close the beta feedback loop']);
    // An over-long profile entry is a warning: Reflect's own form would refuse it.
    codes((days) => days.forEach((day) => (day.persona.priorities = ['Complete the next round of experiments for the main uncertainty estimation project'])));
    expect(validateDataset(dir, 2).warnings.map((w) => w.code)).toContain('profile_over_limit');
  });

  it('accepts off-screen time told as an activity, unless something was tracked inside it', () => {
    const offline = { id: 'gt-off', started_at: '10:00', ended_at: '10:30', title: 'Offline break', summary: 'Away from the desk.', event_ids: [], context: 'No desktop activity was observed.', area: 'personal', intent: 'Take a break.', quality: 'unobserved offline activity', importance: 'low' };
    expect(codes((days) => days[0].ground_truth.activities.push({ ...offline }))).toEqual([]);
    expect(codes((days) => days[0].ground_truth.activities.push({ ...offline, started_at: '09:40' }))).toContain('activity_event_ids');
    expect(codes((days) => (days[0].ground_truth.activities = [{ ...offline }]))).toContain('ground_truth_empty');
  });

  it('never repairs: an invalid dataset cannot be loaded', () => {
    codes((days) => (days[0].ground_truth.activities[0].ended_at = '16:??'));
    expect(() => loadDataset(dir, 2)).toThrow(DatasetValidationError);
    expect(() => loadDataset(dir, 2)).toThrow(/malformed_time.*reflect_day_01\.json.*16:\?\?/s);
    // The file on disk is untouched.
    expect(fs.readFileSync(path.join(dir, 'reflect_day_01.json'), 'utf8')).toContain('16:??');
  });

  it('flags answer-key labels the evaluator has no mapping for', () => {
    codes((days) => {
      days[0].ground_truth.activities[0].intent = 'Daydream';
      days[0].expected_coach_outcome.primary_action!.action_type = 'teleport';
    });
    const { dataset } = loadDataset(dir, 2);
    const vocabulary = checkAnswerKeyVocabulary(splitDataset(dataset).evaluation);
    // An unreadable action type could only ever be scored as wrong: an error.
    expect(vocabulary.errors.join('\n')).toMatch(/action_type "teleport"/);
    // An unreadable classification label is left out of that dimension, and counted.
    expect(vocabulary.errors.join('\n')).not.toMatch(/Daydream/);
    expect(vocabulary.warnings.join('\n')).toMatch(/intent "Daydream".*1 activity is left out/);
    expect(vocabulary.classification.intent).toEqual({ activities: 4, unmapped: 1 });
    expect(vocabulary.classification.quality).toEqual({ activities: 4, unmapped: 0 });
  });
});

// ── Benchmark v2: dated profile changes, work streams, and what must never reach Reflect ──

describe('profile replay — what the user changed, on the day they changed it', () => {
  const start = (): ProfileState => initialProfileState({ current_work: ['Building a SaaS'], priorities: ['Ship the SaaS MVP', 'Complete existing client work'] });
  const apply = (state: ProfileState, update: DatasetProfileUpdate) => applyProfileUpdate(state, update);
  const ok = (state: ProfileState, update: DatasetProfileUpdate): ProfileState => {
    const result = apply(state, update);
    if ('error' in result) throw new Error(result.error);
    return result.state;
  };

  it('a priority is introduced, completed, paused, resumed, reworded and removed — and each keeps its place in the record', () => {
    let state = ok(start(), { at: 'end', op: 'add', priority: 'Generate new freelance leads' });
    expect(state.priorities.map((p) => p.text)).toEqual(['Ship the SaaS MVP', 'Complete existing client work', 'Generate new freelance leads']);
    state = ok(state, { at: 'end', op: 'complete', priority: 'Complete existing client work' });
    state = ok(state, { at: 'end', op: 'pause', priority: 'Generate new freelance leads' });
    // Completed and paused priorities are still there: they are closed, not erased.
    expect(state.priorities).toEqual([
      { text: 'Ship the SaaS MVP', status: 'active' },
      { text: 'Complete existing client work', status: 'completed' },
      { text: 'Generate new freelance leads', status: 'paused' },
    ]);
    state = ok(state, { at: 'start', op: 'resume', priority: 'Generate new freelance leads' });
    state = ok(state, { at: 'start', op: 'rename', priority: 'Ship the SaaS MVP', to: 'Ship the SaaS beta' });
    state = ok(state, { at: 'start', op: 'remove', priority: 'Complete existing client work' });
    expect(state.priorities).toEqual([
      { text: 'Ship the SaaS beta', status: 'active' },
      { text: 'Generate new freelance leads', status: 'active' },
    ]);
    expect(ok(state, { at: 'end', op: 'set_current_work', current_work: ['Running the beta'] }).currentWork).toEqual(['Running the beta']);
  });

  it('refuses what a user could not do: act on a priority that is not there, overfill the list, or exceed a field', () => {
    const state = start();
    expect(apply(state, { at: 'end', op: 'complete', priority: 'Something never stated' })).toEqual({ error: 'the priority "Something never stated" is not stated at this point' });
    expect(apply(state, { at: 'end', op: 'add', priority: 'Ship the SaaS MVP' })).toEqual({ error: 'the priority "Ship the SaaS MVP" is already stated' });
    expect(apply(state, { at: 'end', op: 'resume', priority: 'Ship the SaaS MVP' })).toMatchObject({ error: expect.stringContaining('nothing to resume') });
    expect(apply(state, { at: 'end', op: 'add', priority: 'x'.repeat(61) })).toMatchObject({ error: expect.stringContaining('at most 60 characters') });
    let full = state;
    for (const text of ['Third', 'Fourth', 'Fifth']) full = ok(full, { at: 'end', op: 'add', priority: `${text} priority` });
    expect(apply(full, { at: 'end', op: 'add', priority: 'A sixth priority' })).toMatchObject({ error: expect.stringContaining('already holds 5 priorities') });
    // The state passed in is never changed.
    expect(state.priorities).toHaveLength(2);
  });

  it('replays day by day: nothing from a later day is in an earlier day\'s profile', () => {
    const days = [1, 2, 3, 4].map((n) => ({ persona: n === 1 ? { current_work: [], priorities: ['Priority A'] } : {}, profile_updates: undefined as DatasetProfileUpdate[] | undefined }));
    days[1].profile_updates = [{ at: 'end', op: 'complete', priority: 'Priority A' }, { at: 'end', op: 'add', priority: 'Priority B' }];
    days[3].profile_updates = [{ at: 'start', op: 'add', priority: 'Priority C' }];
    const byDay = profileByDay(days as Parameters<typeof profileByDay>[0]);
    expect(byDay.map((s) => s.priorities.map((p) => `${p.text}:${p.status}`))).toEqual([
      ['Priority A:active'],
      ['Priority A:completed', 'Priority B:active'],
      ['Priority A:completed', 'Priority B:active'],
      ['Priority A:completed', 'Priority B:active', 'Priority C:active'],
    ]);
  });
});

describe('dataset validator — profile changes and work streams', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const KEY = { work_streams: { saas: { title: 'The SaaS', kind: 'work', aliases: ['saas'], priorities: ['Ship the SaaS MVP'] }, freelance: { title: 'Client work', kind: 'work', aliases: ['client'], priorities: [] } } };
  function validate(change: (days: DatasetDayFile[]) => void, key: unknown = KEY) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-bench-v2-'));
    const days = [makeDay(1), makeDay(2)];
    change(days);
    days.forEach((d, i) => fs.writeFileSync(path.join(dir, `reflect_day_0${i + 1}.json`), JSON.stringify(d)));
    if (key !== null) fs.writeFileSync(path.join(dir, PERSONA_KEY_FILE), JSON.stringify(key));
    return validateDataset(dir, 2);
  }
  const codesOf = (result: ReturnType<typeof validate>) => result.errors.map((e) => e.code);

  it('accepts dated changes that are possible, and hands them to Reflect\'s side on their own day only', () => {
    const result = validate((days) => {
      days[1].profile_updates = [{ at: 'start', op: 'add', priority: 'Generate new freelance leads' }, { at: 'end', op: 'complete', priority: 'Ship the SaaS MVP' }];
      days[1].ground_truth.activities[0].stream = 'saas';
      days[1].expected_coach_outcome.primary_action!.target_stream = 'saas';
      days[1].expected_coach_outcome.forbidden_streams = ['freelance'];
    });
    expect(codesOf(result)).toEqual([]);
    const { input, evaluation } = splitDataset(result.dataset!);
    // Day 1 knows nothing of what is changed on day 2.
    expect(input.days[0].profileUpdates).toEqual([]);
    expect(JSON.stringify(input.days[0])).not.toContain('Generate new freelance leads');
    expect(input.days[1].profileUpdates).toEqual([{ at: 'start', op: 'add', priority: 'Generate new freelance leads' }, { at: 'end', op: 'complete', priority: 'Ship the SaaS MVP' }]);
    // The evaluator is told what the profile was at the end of each day.
    expect(evaluation.days.map((d) => d.profilePriorities)).toEqual([
      [{ text: 'Ship the SaaS MVP', status: 'active' }],
      [{ text: 'Ship the SaaS MVP', status: 'completed' }, { text: 'Generate new freelance leads', status: 'active' }],
    ]);
    // The work-stream registry is answer key: it is in the evaluation half and nowhere in the input half.
    expect(Object.keys(evaluation.streams)).toEqual(['saas', 'freelance']);
    for (const secret of ['work_streams', 'aliases', '"saas"', 'target_stream', 'forbidden_streams', '"stream"']) expect(JSON.stringify(input)).not.toContain(secret);
    // A profile change is part of what Reflect is given, so it is part of the input version.
    const before = result.dataset!.inputVersion;
    const without = validate(() => {});
    expect(without.dataset!.inputVersion).not.toBe(before);
  });

  it('rejects a change that could not have been made, or is out of order', () => {
    expect(codesOf(validate((days) => (days[1].profile_updates = [{ at: 'end', op: 'complete', priority: 'Never stated' }])))).toEqual(['profile_update_impossible']);
    expect(codesOf(validate((days) => (days[1].profile_updates = [{ at: 'end', op: 'add', priority: 'A' }, { at: 'start', op: 'add', priority: 'B' }])))).toContain('profile_update_order');
    expect(codesOf(validate((days) => (days[1].profile_updates = [{ at: 'noon', op: 'add', priority: 'A' }] as unknown as DatasetProfileUpdate[])))).toEqual(['profile_update_shape']);
    // A priority cannot be acted on before the day it is added.
    expect(
      codesOf(
        validate((days) => {
          days[0].profile_updates = [{ at: 'end', op: 'complete', priority: 'Generate new freelance leads' }];
          days[1].profile_updates = [{ at: 'end', op: 'add', priority: 'Generate new freelance leads' }];
        }),
      ),
    ).toEqual(['profile_update_impossible']);
  });

  it('rejects a reference to a work stream that does not exist, and a registry that names a priority never stated', () => {
    expect(codesOf(validate((days) => (days[0].ground_truth.activities[0].stream = 'nope')))).toEqual(['stream_reference']);
    expect(codesOf(validate((days) => (days[0].expected_coach_outcome.primary_action!.target_stream = 'nope')))).toEqual(['stream_reference']);
    expect(codesOf(validate((days) => (days[0].expected_coach_outcome.acceptable_streams = ['saas', 'nope'])))).toEqual(['stream_reference']);
    expect(codesOf(validate((days) => (days[0].ground_truth.activities[0].stream = 'saas'), null))).toEqual(['stream_reference']);
    expect(codesOf(validate(() => {}, { work_streams: { saas: { title: 'x', kind: 'work', aliases: ['saas'], priorities: ['A priority nobody stated'] } } }))).toEqual(['persona_key']);
    expect(codesOf(validate(() => {}, { work_streams: { saas: { title: 'x', kind: 'hobby', aliases: [], priorities: [] } } }))).toEqual(['persona_key']);
  });

  it('a silent day needs no action; an optional day may hold instead of naming one', () => {
    const silent = (days: DatasetDayFile[]) => {
      days[0].expected_coach_outcome.primary_action = null;
      days[0].expected_coach_outcome.action_opportunity = { should_exist: false, strength: 'none', reason: 'Nothing is open.', priority: null, type: null };
    };
    expect(codesOf(validate(silent))).toEqual([]);
    const hold = (acceptable?: string[]) => (days: DatasetDayFile[]) => {
      days[0].expected_coach_outcome.primary_action = null;
      days[0].expected_coach_outcome.action_opportunity = { should_exist: false, strength: 'moderate', reason: 'Waiting on a reply.', priority: null, type: null };
      if (acceptable) days[0].expected_coach_outcome.acceptable_streams = acceptable;
    };
    expect(codesOf(validate(hold(['saas'])))).toEqual([]);
    expect(codesOf(validate(hold()))).toEqual(['action_opportunity_conflict']);
  });
});

describe('the six personas — answer keys the evaluator can read', () => {
  const personas = personaDatasetDirs().map((dir) => ({ name: path.basename(dir), dir }));

  it.each(personas)('$name: streams, opportunities and responses are stated for every day', ({ dir }) => {
    const { dataset } = loadDataset(dir, 30);
    const { evaluation } = splitDataset(dataset);
    const streams = Object.keys(evaluation.streams);
    expect(streams.length).toBeGreaterThan(1);
    for (const day of evaluation.days) {
      const coach = day.expectedCoachOutcome;
      // Every day says whether the Coach should speak.
      expect(coach.action_opportunity, `day ${day.dayNumber}`).toBeDefined();
      // Every expected move is stated against a stream, never only against a name.
      for (const action of [coach.primary_action, coach.secondary_action]) if (action) expect(action.target_stream, `day ${day.dayNumber}`).toBeDefined();
      // Every tracked activity that is work belongs to a stream.
      for (const activity of day.groundTruth.activities) {
        if (activity.event_ids.length > 0 && activity.context === 'Work' && activity.area !== null) expect(streams, `day ${day.dayNumber} ${activity.id}`).toContain(activity.stream ?? activity.area);
      }
    }
  });

  it.each(personas)('$name: at least three quarters of the scored activities carry a label the evaluator can score, in every dimension but the priority link', ({ dir }) => {
    const { dataset } = loadDataset(dir, 30);
    const { classification } = checkAnswerKeyVocabulary(splitDataset(dataset).evaluation);
    for (const dimension of ['context', 'intent', 'quality'] as const) {
      const { activities, unmapped } = classification[dimension];
      // What is left out is what the key itself calls uncertain or mixed — never counted as right or wrong.
      expect(1 - unmapped / activities, dimension).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('every persona has days that call for silence or leave it open — the Coach can be wrong by speaking', () => {
    const quiet = personas.map(({ name, dir }) => {
      const days = splitDataset(loadDataset(dir, 30).dataset).evaluation.days;
      return { name, none: days.filter((d) => d.expectedCoachOutcome.action_opportunity?.strength === 'none').length, moderate: days.filter((d) => d.expectedCoachOutcome.action_opportunity?.strength === 'moderate').length };
    });
    for (const persona of quiet) expect(persona.none + persona.moderate, persona.name).toBeGreaterThan(0);
    // Stated plainly, because it is a limit of the set: the founder key has optional days but none that requires silence.
    expect(quiet.find((p) => p.name === 'founder_freelancer')).toMatchObject({ none: 0 });
    expect(quiet.filter((p) => p.none > 0).map((p) => p.name).sort()).toEqual(['college_student', 'content_creator', 'graphic_designer', 'researcher', 'sofware_developer']);
  });

  it.each(personas)('$name: nothing of the answer key is in what Reflect is given, and no day carries a later day\'s profile', ({ dir }) => {
    const { dataset } = loadDataset(dir, 30);
    const { input, evaluation } = splitDataset(dataset);
    const detector = buildLeakDetector(evaluation, input);
    // The input half, as text, trips none of the answer key's own wording.
    expect(detector.findLeaks(JSON.stringify(input))).toEqual([]);
    // …while a sentence of the key, or a day-type slug, is caught the moment it appears.
    const reason = evaluation.days.find((d) => d.expectedCoachOutcome.action_opportunity?.reason.split(' ').length! >= 12)!.expectedCoachOutcome.action_opportunity!.reason;
    expect(detector.findLeaks(`Context for the model: ${reason}`).length).toBeGreaterThan(0);
    // A profile change is visible from its own day on, never before.
    const firstSeen = new Map<string, number>();
    input.days.forEach((day, index) => {
      for (const update of day.profileUpdates) for (const text of [update.priority, update.to, ...(update.current_work ?? [])]) if (text && !firstSeen.has(text)) firstSeen.set(text, index);
    });
    const initial = new Set([...input.persona.priorities, ...input.persona.current_work]);
    for (const [text, index] of firstSeen) {
      if (initial.has(text)) continue;
      expect(JSON.stringify(input.days.slice(0, index)), text).not.toContain(JSON.stringify(text));
    }
    // Every raw event of a day lies on that day or just past its midnight: no day is handed another day's events.
    input.days.forEach((day, index) => {
      const next = input.days[index + 1];
      for (const event of day.rawEvents) if (next) expect(Date.parse(event.startedAt)).toBeLessThan(Date.parse(next.rawEvents[0].startedAt));
    });
  });

  it('the day files hold exactly what data/keys says (run build.mjs --write after editing a key)', () => {
    const result = spawnSync(process.execPath, [path.join(path.dirname(personas[0].dir), 'keys', 'build.mjs'), '--check'], { encoding: 'utf8' });
    expect(result.stdout.trim().split('\n').pop()).toBe('Up to date.');
    expect(result.status).toBe(0);
  });
});
