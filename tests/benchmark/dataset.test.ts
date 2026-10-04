import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAnswerKeyVocabulary } from './evaluators/index';
import { loadConfig } from './runner/config';
import { DatasetValidationError, loadDataset, splitDataset, validateDataset, type DatasetDayFile } from './runner/dataset';

/**
 * Dataset validation. Needs no database and no Gemini, so it runs with the
 * ordinary test suite (and on its own through `npm run benchmark:validate`).
 *
 * The first block validates the real dataset on disk and fails loudly, with
 * every problem listed, when it is not fit to benchmark against. The second
 * proves the validator catches each kind of defect — and repairs none.
 */

const config = loadConfig();

describe('benchmark dataset on disk', () => {
  const result = validateDataset(config.datasetDir, config.expectedDays);

  it(`has ${config.expectedDays} valid day files`, () => {
    const listing = result.errors.map((e) => `[${e.code}] ${e.file} ${e.where}: ${e.message}`).join('\n');
    expect(result.errors.length, `Dataset errors:\n${listing}\n`).toBe(0);
    expect(result.stats.days).toBe(config.expectedDays);
  });

  it('uses only labels the evaluator can read', () => {
    if (!result.dataset) return; // already reported by the test above
    const vocabulary = checkAnswerKeyVocabulary(splitDataset(result.dataset).evaluation);
    expect(vocabulary.errors, vocabulary.errors.join('\n')).toEqual([]);
  });

  it('splits into an input half that carries no answer-key field', () => {
    if (!result.dataset) return;
    const { input, evaluation } = splitDataset(result.dataset);
    expect(Object.keys(input).sort()).toEqual(['days', 'persona', 'utcOffset']);
    expect(Object.keys(input.days[0]).sort()).toEqual(['date', 'dayNumber', 'rawEvents']);
    expect(Object.keys(input.days[0].rawEvents[0]).sort()).toEqual(['app', 'browser', 'datasetId', 'endedAt', 'startedAt', 'title', 'url', 'watcher']);
    const serialized = JSON.stringify(input);
    for (const forbidden of ['ground_truth', 'groundTruth', 'expected', 'day_type', 'dayType', 'circumstances', 'things_not_to_do', 'importance']) {
      expect(serialized).not.toContain(forbidden);
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

  it('treats a persona that changes between days as an error', () => {
    expect(codes((days) => days[1].persona.priorities.push('A new priority'))).toContain('persona_changed');
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
    expect(vocabulary.errors.join('\n')).toMatch(/intent "Daydream"/);
    expect(vocabulary.errors.join('\n')).toMatch(/action_type "teleport"/);
  });
});
