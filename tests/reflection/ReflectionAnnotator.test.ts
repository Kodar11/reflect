import { describe, it, expect } from 'vitest';
import { activitySignature } from '../../src/reflection/ReflectionActivities';
import {
  ReflectionAnnotator,
  buildAnnotationPrompt,
  buildAnnotationSchema,
  selectAnnotationItems,
  validateAnnotationOutput,
} from '../../src/reflection/ReflectionAnnotator';
import { affectedRange } from '../../src/reflection/ReflectionChanges';
import { ScriptedGemini, makeEvent } from '../intelligence/helpers';
import { FakeReflectionRepository } from './FakeReflectionRepository';
import { TAXONOMY, activity, iso, priority } from './helpers';

const p1 = priority('p1', 'Launch Project X', { activeFrom: iso(1) });

const raw = () => [
  activity(6, '09:00', 80, { title: 'Implement Project X sync engine' }),
  activity(6, '10:30', 60, { title: 'Implement Project X sync engine' }),
  activity(6, '13:00', 25, { title: 'Fix Project Y billing bug' }),
  activity(6, '14:00', 3, { title: 'Glance at email' }),
  activity(6, '15:00', 40, { title: 'VS Code', source: 'deterministic' }),
];

describe('selectAnnotationItems', () => {
  it('groups by signature, largest first, skipping noise and deterministic sessions', () => {
    const items = selectAnnotationItems(raw(), new Map(), [p1], TAXONOMY);
    expect(items).toEqual([
      { ref: 'i1', signature: 'implement project x sync engine|coding', title: 'Implement Project X sync engine', summary: null, context: 'Coding', minutes: 140 },
      { ref: 'i2', signature: 'fix project y billing bug|coding', title: 'Fix Project Y billing bug', summary: null, context: 'Coding', minutes: 25 },
    ]);
  });

  it('asks again only when a new priority has not been evaluated', () => {
    const decided = (checked: string[]) =>
      new Map(
        raw().map((a) => [activitySignature(a), { signature: activitySignature(a), thread: 'T', priorityId: null, checkedPriorityIds: checked }]),
      );
    expect(selectAnnotationItems(raw(), decided(['p1']), [p1], TAXONOMY)).toEqual([]);
    expect(selectAnnotationItems(raw(), decided([]), [p1], TAXONOMY)).toHaveLength(2);
    // A priority that did not apply when the activity happened is not a reason to ask.
    const later = priority('p2', 'Later goal', { activeFrom: iso(20) });
    expect(selectAnnotationItems(raw(), decided(['p1']), [p1, later], TAXONOMY)).toEqual([]);
  });
});

describe('annotation prompt + validation', () => {
  const items = selectAnnotationItems(raw(), new Map(), [p1], TAXONOMY);

  it('lists priorities, known threads and items', () => {
    const prompt = buildAnnotationPrompt(items, [p1], ['Project X']);
    expect(prompt).toContain('{"id":"p1","text":"Launch Project X"}');
    expect(prompt).toContain('KNOWN THREADS (reuse these names)\n"Project X"');
    expect(prompt).toContain('{"ref":"i1","title":"Implement Project X sync engine","summary":null,"context":"Coding","minutes":140}');
    expect(buildAnnotationPrompt(items, [], [])).toContain('STATED PRIORITIES\nNone.');
    expect((buildAnnotationSchema(['p1']) as any).properties.items.items.properties.priorityId.anyOf[0].enum).toEqual(['p1']);
  });

  it('accepts valid decisions and drops odd entries without discarding the rest', () => {
    const decisions = validateAnnotationOutput(
      {
        items: [
          { ref: 'i1', thread: '  Project   X ', priorityId: 'p1' },
          { ref: 'i2', thread: 'null', priorityId: 'p-invented' },
          { ref: 'i9', thread: 'Ghost', priorityId: null },
          { ref: 'i1', thread: 'Duplicate', priorityId: null },
        ],
      },
      items,
      ['p1'],
    );
    expect([...decisions.entries()]).toEqual([
      ['i1', { thread: 'Project X', priorityId: 'p1' }],
      ['i2', { thread: null, priorityId: null }],
    ]);
    expect(validateAnnotationOutput({ nope: true }, items, ['p1']).size).toBe(0);
  });
});

describe('ReflectionAnnotator', () => {
  function make(script: unknown[]) {
    const repo = new FakeReflectionRepository();
    const gemini = new ScriptedGemini(script);
    return { repo, gemini, annotator: new ReflectionAnnotator({ gemini, repo, now: () => new Date(iso(7)) }) };
  }

  it('persists decisions and never asks twice for the same signature', async () => {
    const { repo, gemini, annotator } = make([
      { items: [{ ref: 'i1', thread: 'Project X', priorityId: 'p1' }, { ref: 'i2', thread: 'Project Y', priorityId: null }] },
    ]);
    expect(await annotator.annotate(raw(), [p1], TAXONOMY)).toBe(2);
    expect(repo.getAnnotations(['implement project x sync engine|coding'])).toEqual([
      { signature: 'implement project x sync engine|coding', thread: 'Project X', priorityId: 'p1', checkedPriorityIds: ['p1'] },
    ]);
    expect(repo.listThreadLabels(10).sort()).toEqual(['Project X', 'Project Y']);

    // Second run: everything is cached → no model call at all.
    expect(await annotator.annotate(raw(), [p1], TAXONOMY)).toBe(0);
    expect(gemini.requests).toHaveLength(1);
  });

  it('is best-effort: unavailable or broken linking never throws', async () => {
    const offline = make([new Error('network down')]);
    expect(await offline.annotator.annotate(raw(), [p1], TAXONOMY)).toBe(0);

    const malformed = make(['{not json']);
    expect(await malformed.annotator.annotate(raw(), [p1], TAXONOMY)).toBe(0);

    const unconfigured = make([]);
    unconfigured.gemini.configured = false;
    expect(await unconfigured.annotator.annotate(raw(), [p1], TAXONOMY)).toBe(0);
    expect(unconfigured.gemini.requests).toHaveLength(0);
  });
});

describe('affectedRange', () => {
  const events = {
    getByIds: (ids: number[]) =>
      [makeEvent(1, iso(6, '09:00'), iso(6, '09:30')), makeEvent(2, iso(6, '10:00'), iso(6, '11:00'))].filter((e) => ids.includes(e.id)),
  };

  it('narrows a timeline edit to the events it names', () => {
    const range = affectedRange('timeline:apply', { operation: 'rename', payload: { eventIdsHint: [1, 2], newTitle: 'x' } }, events);
    expect(range).toEqual({ start: iso(6, '09:00'), end: new Date(Date.parse(iso(6, '11:00')) + 1).toISOString() });
    expect(affectedRange('categorization:saveEventClassification', { eventId: 1 }, events)!.start).toBe(iso(6, '09:00'));
  });

  it('uses explicit times of an offline block', () => {
    const range = affectedRange('timeline:apply', { operation: 'create_offline', payload: { startedAt: iso(8, '14:00'), endedAt: iso(8, '15:00') } }, events);
    expect(range!.start).toBe(iso(8, '14:00'));
  });

  it('treats rule changes and "remember this" as touching all of history', () => {
    expect(affectedRange('rules:save', { id: 'r1' }, events)).toBeNull();
    expect(affectedRange('timeline:undo', undefined, events)).toBeNull();
    expect(affectedRange('categorization:saveOverride', { eventIds: [1], remember: true }, events)).toBeNull();
    expect(affectedRange('timeline:apply', { operation: 'rename', payload: { sessionIdHint: 's-1-2' } }, events)).toBeNull();
  });
});
