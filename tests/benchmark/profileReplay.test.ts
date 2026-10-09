import { describe, it, expect } from 'vitest';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { prioritiesActiveDuring, priorityStateAt } from '../../src/reflection/ReflectionPriorities';
import { modelDay } from '../coach/helpers';
import { iso, local, makeReflectionHarness, seedThreads, workday } from '../reflection/helpers';
import type { DatasetProfileUpdate } from './runner/dataset';
import { replayProfileUpdates } from './runner/ingest';

/**
 * Dated profile replay against the REAL priority model and the REAL daily
 * pipeline (scripted Gemini, in-memory repositories): the harness changes the
 * profile through the calls the app's own profile form makes, at a simulated
 * moment, and everything downstream — the priority record, the prompt of each
 * day, the reports already written — has to tell the same story.
 *
 * Mon Oct 12 → Wed Oct 14. "Launching Project X" is stated from the start;
 * on the evening of the 13th the user marks it completed and adds
 * "Shipping Project Z".
 */
const A = 'Launching Project X';
const Z = 'Shipping Project Z';
const days = [5, 6, 7, 8, 9, 12, 13, 14].flatMap(workday);

function harness() {
  const h = makeReflectionHarness({ activities: days, now: local(12, '22:05'), priorities: [A, 'Keeping the inbox under control'], coach: true });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0].id });
  const runtime = { userProfileRepo: h.profiles, reflectionService: h.service };
  const replay = (updates: DatasetProfileUpdate[]) => replayProfileUpdates(runtime, updates);
  /** Reflect on local day `d` at 22:05 and return the prompt that was sent. */
  const reflectOn = async (d: number) => {
    h.setNow(local(d, '22:05'));
    const period = periodContaining('day', local(d));
    h.gemini.push(modelDay(period));
    const result = await h.service.generate(period, { trigger: 'scheduled' });
    return { result, period, prompt: h.gemini.requests[h.gemini.requests.length - 1].prompt, report: h.repo.getCurrentReport('day', period.key)! };
  };
  return { ...h, replay, reflectOn, byText: (text: string) => h.service.syncPriorities().find((p) => p.text === text) };
}

/** The lines of one section of the daily prompt. */
const section = (prompt: string, title: string) => {
  const at = prompt.indexOf(`\n${title}`);
  if (at < 0) return '';
  return prompt.slice(at + 1).split('\n\n')[0];
};

describe('dated profile replay — through the production priority model', () => {
  it('a new priority exists from the moment it is added, and not a moment before', async () => {
    const h = harness();
    const monday = await h.reflectOn(12);
    expect(monday.result.status).toBe('succeeded');
    // Monday's reflection was written with Monday's profile: the later priority is nowhere in what the model was given.
    expect(monday.prompt).toContain(A);
    expect(monday.prompt).not.toContain(Z);
    expect(h.byText(Z)).toBeUndefined();

    h.setNow(local(13, '21:40'));
    expect(h.replay([{ at: 'end', op: 'complete', priority: A }, { at: 'end', op: 'add', priority: Z }])).toEqual([`completed "${A}"`, `added "${Z}"`]);
    const added = h.byText(Z)!;
    expect(added.status).toBe('active');
    // Its interval starts at the simulated moment of the change — not at onboarding, and not at "now" of the machine.
    expect(added.activeFrom).toBe(iso(13, '21:40'));
    expect(priorityStateAt(added, iso(12, '12:00'))).toBe('unstated');
    expect(priorityStateAt(added, iso(14, '12:00'))).toBe('active');

    const wednesday = await h.reflectOn(14);
    expect(section(wednesday.prompt, 'CURRENT PRIORITIES')).toContain(Z);
  });

  it('a completed priority is closed, not erased: the past still knows it, the present no longer offers it', async () => {
    const h = harness();
    const monday = await h.reflectOn(12);
    h.setNow(local(13, '21:40'));
    h.replay([{ at: 'end', op: 'complete', priority: A }, { at: 'end', op: 'add', priority: Z }]);

    const completed = h.byText(A)!;
    expect(completed.status).toBe('completed');
    // Historical: on Monday it was active, and Monday's period still counts it among the priorities that applied.
    expect(priorityStateAt(completed, iso(12, '12:00'))).toBe('active');
    expect(priorityStateAt(completed, iso(14, '12:00'))).toBe('completed');
    const all = h.service.syncPriorities();
    expect(prioritiesActiveDuring(all, monday.period.start, monday.period.end).map((p) => p.text)).toEqual([A, 'Keeping the inbox under control']);
    // …and a day wholly after the change sees the new one in its place.
    const wednesdayPeriod = periodContaining('day', local(14));
    expect(prioritiesActiveDuring(all, wednesdayPeriod.start, wednesdayPeriod.end).map((p) => p.text).sort()).toEqual(['Keeping the inbox under control', Z]);

    // The report written before the change is exactly what it was.
    const after = h.repo.getCurrentReport('day', monday.period.key)!;
    expect(after.id).toBe(monday.report.id);
    expect(after.headline).toBe(monday.report.headline);
    expect(after.dataSnapshot!.priorities.map((p) => p.text)).toContain(A);
    expect(JSON.stringify(after)).not.toContain(Z);

    // Wednesday's prompt: the completed priority is not among what currently matters.
    const wednesday = await h.reflectOn(14);
    expect(section(wednesday.prompt, 'CURRENT PRIORITIES')).not.toContain(A);
  });

  it('paused, resumed, reworded and removed priorities each leave the record a real user\'s would', () => {
    const h = harness();
    h.setNow(local(13, '09:00'));
    h.replay([{ at: 'start', op: 'pause', priority: A }]);
    expect(h.byText(A)!.status).toBe('paused');
    h.setNow(local(14, '09:00'));
    h.replay([{ at: 'start', op: 'resume', priority: A }]);
    const resumed = h.byText(A)!;
    expect(resumed.status).toBe('active');
    // One id for its whole life; the pause is an interval boundary, not a new priority.
    expect(priorityStateAt(resumed, iso(13, '12:00'))).toBe('paused');
    expect(priorityStateAt(resumed, iso(14, '12:00'))).toBe('active');

    h.setNow(local(15, '09:00'));
    h.replay([{ at: 'start', op: 'remove', priority: 'Keeping the inbox under control' }, { at: 'start', op: 'set_current_work', current_work: ['Polishing the launch page'] }]);
    expect(h.profiles.getProfile()).toMatchObject({ priorities: [A], currentWork: ['Polishing the launch page'] });
    expect(h.service.syncPriorities().find((p) => p.text === 'Keeping the inbox under control')!.status).toBe('archived');
  });

  it('fails loudly rather than replaying something Reflect does not hold', () => {
    const h = harness();
    expect(() => h.replay([{ at: 'end', op: 'complete', priority: 'A priority that was never stated' }])).toThrow(/Reflect holds no such priority/);
    // Text Reflect's own profile form would cut is refused, not silently shortened.
    expect(() => h.replay([{ at: 'end', op: 'add', priority: 'x'.repeat(80) }])).toThrow(/does not fit Reflect's profile limits/);
  });
});
