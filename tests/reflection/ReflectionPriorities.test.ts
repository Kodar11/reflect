import { describe, it, expect } from 'vitest';
import {
  isPossiblyStale,
  matchesPriorityByKeyword,
  planPrioritySync,
  prioritiesActiveDuring,
  priorityActiveAt,
  priorityKey,
  priorityTerms,
} from '../../src/reflection/ReflectionPriorities';
import { activitySignature, applyAnnotations } from '../../src/reflection/ReflectionActivities';
import { TAXONOMY, activity, iso, priority } from './helpers';

const options = { nowIso: iso(10), confirmedAt: iso(9), initialActiveFrom: iso(1) };

describe('priority normalization', () => {
  it('normalizes the identity of a stated priority', () => {
    expect(priorityKey('  Launch   Project-X! ')).toBe('launch project x');
    expect(priorityKey('launch project x')).toBe(priorityKey('Launch Project X'));
  });

  it('the first sync dates priorities from the profile, not from now', () => {
    const plan = planPrioritySync([], ['Launch Project X', 'Finish my degree'], options);
    expect(plan.insert.map((p) => [p.text, p.activeFrom])).toEqual([
      ['Launch Project X', iso(1)],
      ['Finish my degree', iso(1)],
    ]);
    expect(plan.archiveIds).toEqual([]);
  });

  it('a newly stated priority starts now; one no longer stated is archived', () => {
    const existing = [priority('p1', 'Launch Project X', { lastConfirmedAt: iso(9) }), priority('p2', 'Finish my degree')];
    const plan = planPrioritySync(existing, ['Launch Project X', 'Learn Rust'], options);
    expect(plan.insert).toEqual([
      { text: 'Learn Rust', normalizedKey: 'learn rust', activeFrom: iso(10), lastConfirmedAt: iso(9) },
    ]);
    expect(plan.archiveIds).toEqual(['p2']);
    expect(plan.confirmIds).toEqual([]); // already confirmed at that profile save
  });

  it('reconfirms priorities still present in a newer profile save', () => {
    const plan = planPrioritySync([priority('p1', 'Launch Project X', { lastConfirmedAt: iso(2) })], ['launch  project x'], options);
    expect(plan.confirmIds).toEqual(['p1']);
    expect(plan.insert).toEqual([]);
  });

  it('re-stating an archived priority opens a NEW interval on the SAME priority; a paused one stays paused', () => {
    const archived = priority('p1', 'Launch Project X', { status: 'archived', activeUntil: iso(5) });
    const restated = planPrioritySync([archived], ['Launch Project X'], options);
    // Not a second priority with a new id: the same one, taken up again.
    expect(restated.insert).toEqual([]);
    expect(restated.reactivate).toEqual([{ id: 'p1', text: 'Launch Project X' }]);

    const paused = priority('p2', 'Learn Rust', { status: 'paused', activeUntil: iso(5), lastConfirmedAt: iso(9) });
    const plan = planPrioritySync([paused], ['Learn Rust'], options);
    expect(plan.insert).toEqual([]);
    expect(plan.archiveIds).toEqual([]);
  });

  it('only applies a priority during its own interval — never a stale one', () => {
    const old = priority('p1', 'Old goal', { status: 'archived', activeFrom: iso(-90), activeUntil: iso(-30) });
    const current = priority('p2', 'Launch Project X', { activeFrom: iso(-20) });
    const future = priority('p3', 'Next thing', { activeFrom: iso(20) });

    expect(priorityActiveAt(old, iso(-40))).toBe(true);
    expect(priorityActiveAt(old, iso(1))).toBe(false);
    expect(prioritiesActiveDuring([old, current, future], iso(1), iso(8)).map((p) => p.id)).toEqual(['p2']);
    expect(prioritiesActiveDuring([old, current, future], iso(-35), iso(-10)).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('flags an active priority nobody reconfirmed for a long time', () => {
    const p = priority('p1', 'Launch Project X', { lastConfirmedAt: iso(-80) });
    expect(isPossiblyStale(p, iso(10), 60)).toBe(true);
    expect(isPossiblyStale({ ...p, lastConfirmedAt: iso(1) }, iso(10), 60)).toBe(false);
    expect(isPossiblyStale({ ...p, status: 'completed' }, iso(10), 60)).toBe(false);
  });
});

describe('keyword matching (fallback priority linking)', () => {
  it('extracts the terms that identify the work', () => {
    expect(priorityTerms('Finish authentication')).toEqual({ distinctive: ['authentication'], corePhrase: 'authentication' });
    expect(priorityTerms('Launching Project X').distinctive).toEqual([]);
    expect(priorityTerms('Launching Project X').corePhrase).toBe('project x');
    expect(priorityTerms('My Game Theory course').distinctive).toEqual(['game', 'theory']);
  });

  it('matches plainly related activities and nothing else', () => {
    expect(matchesPriorityByKeyword('Launching Project X', 'Implement Project X sync engine')).toBe(true);
    expect(matchesPriorityByKeyword('Launching Project X', 'Fix Project Y billing bug')).toBe(false);
    expect(matchesPriorityByKeyword('Finish authentication', 'Implement the authentication flow')).toBe(true);
    expect(matchesPriorityByKeyword('Get an internship', 'Apply to internships on LinkedIn')).toBe(true);
    expect(matchesPriorityByKeyword('My Game Theory course', 'Study Game Theory lecture 4')).toBe(true);
    expect(matchesPriorityByKeyword('My Game Theory course', 'Play a strategy game')).toBe(false);
    expect(matchesPriorityByKeyword('Work', 'Anything at all')).toBe(false);
  });
});

describe('applyAnnotations', () => {
  const p1 = priority('p1', 'Launch Project X', { activeFrom: iso(5) });

  it('uses the cached thread, falling back to the Context name', () => {
    const a = activity(6, '09:00', 30, { title: 'Implement sync engine' });
    const annotated = applyAnnotations(
      [a, activity(6, '10:00', 30, { title: 'Something else', contextId: 'learning' })],
      new Map([[activitySignature(a), { signature: activitySignature(a), thread: 'Project X', priorityId: null, checkedPriorityIds: [] }]]),
      [],
      TAXONOMY,
    );
    expect(annotated.map((x) => x.thread)).toEqual(['Project X', 'Learning']);
  });

  it('prefers the cached priority decision over keywords, in both directions', () => {
    const linked = activity(6, '09:00', 30, { title: 'Implement sync engine' });
    const rejected = activity(6, '10:00', 30, { title: 'Read Project X competitor news' });
    const annotations = new Map([
      [activitySignature(linked), { signature: activitySignature(linked), thread: 'Project X', priorityId: 'p1', checkedPriorityIds: ['p1'] }],
      [activitySignature(rejected), { signature: activitySignature(rejected), thread: null, priorityId: null, checkedPriorityIds: ['p1'] }],
    ]);
    const out = applyAnnotations([linked, rejected], annotations, [p1], TAXONOMY);
    expect(out.map((a) => a.priorityId)).toEqual(['p1', null]);
  });

  it('falls back to a keyword match when the priority was never evaluated', () => {
    const out = applyAnnotations([activity(6, '09:00', 30, { title: 'Implement Project X sync engine' })], new Map(), [p1], TAXONOMY);
    expect(out[0].priorityId).toBe('p1');
  });

  it('never links an activity to a priority that did not apply yet', () => {
    const before = activity(2, '09:00', 30, { title: 'Implement Project X sync engine' });
    expect(applyAnnotations([before], new Map(), [p1], TAXONOMY)[0].priorityId).toBeNull();
  });
});
