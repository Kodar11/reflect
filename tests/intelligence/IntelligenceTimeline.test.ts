import { describe, it, expect, vi } from 'vitest';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import type { CategorizationOverride } from '../../src/categorization/Classification';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import type { Event } from '../../src/models/Event';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import type { VerifiedSession } from '../../src/timeline/TimelineModels';
import { FakeEditRepository } from '../timeline/FakeEditRepository';
import { TAXONOMY, makeEvent, makeHarness, modelActivity, modelOutput, t } from './helpers';

const WS = t('09:00');
const WE = t('10:00');

function hour(): Event[] {
  return [
    makeEvent(1, t('09:00'), t('09:15'), { app: 'VS Code', title: 'TimelinePage.tsx - reflect' }),
    makeEvent(2, t('09:15'), t('09:30'), { app: 'Chrome', browser: 'Chrome', url: 'react.dev', title: 'useMemo' }),
    makeEvent(3, t('09:30'), t('09:45'), { app: 'Windows Terminal', title: 'npm run dev' }),
    makeEvent(4, t('09:45'), t('10:00'), { app: 'VS Code', title: 'SessionBlock.tsx - reflect' }),
  ];
}

/** The real timeline stack (session engine → AI source → edits → categorization) over fakes. */
function makeWorld(events: Event[], script: unknown[] = []) {
  let timeline!: TimelineService;
  const h = makeHarness(events, script, {
    getUserEditedEventIds: (from, to) => timeline.getUserEditedEventIds(from, to),
  });
  const overrides: CategorizationOverride[] = [];
  const aiSource = new IntelligenceTimelineSource(h.repo, () => new Date(t('12:00')));
  const categorization = new CategorizationService(
    { listActivities: vi.fn(() => TAXONOMY.activities), listRules: vi.fn(() => []), saveRule: vi.fn() } as any,
    {
      listOverrides: vi.fn(() => overrides),
      saveOverride: vi.fn((o: CategorizationOverride) => overrides.push(o)),
      listDimensions: vi.fn(() => TAXONOMY.dimensions),
      listDimensionsByType: vi.fn((type: string) => TAXONOMY.dimensions.filter((d) => d.dimension === type)),
    } as any,
    { getSessionsByRange: vi.fn(() => []), getProfiles: vi.fn(() => []) } as any,
    h.events,
    aiSource,
  );
  const sessions = new SessionService(h.events);
  const edits = new FakeEditRepository();
  timeline = new TimelineService(sessions, edits, undefined, categorization, aiSource);
  return { ...h, timeline, sessions, edits, categorization, overrides };
}

const ids = (s: VerifiedSession) => s.events.map((e) => e.id);
const oneActivity = (title = 'Build Reflect timeline UI') =>
  modelOutput([modelActivity({ eventIds: [1, 2, 3, 4], startedAt: t('09:00'), endedAt: t('10:00'), title })]);

describe('Timeline integration', () => {
  it('falls back to deterministic sessions when no AI analysis exists', () => {
    const w = makeWorld(hour());

    const timeline = w.timeline.getToday();
    const deterministic = w.sessions.getToday();

    expect(timeline.map((s) => s.id)).toEqual(deterministic.map((s) => s.id));
    expect(timeline.every((s) => s.ai === undefined)).toBe(true);
    expect(timeline.flatMap(ids).sort()).toEqual([1, 2, 3, 4]);
  });

  it('shows the AI activity as one meaningful block with raw events as evidence', async () => {
    const events = hour();
    const snapshot = JSON.parse(JSON.stringify(events));
    const w = makeWorld(events, [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    const timeline = w.timeline.getToday();

    expect(timeline).toHaveLength(1);
    const [block] = timeline;
    expect(block.id).toBe(w.repo.active()[0].id);
    expect(block.ai).toMatchObject({ title: 'Build Reflect timeline UI', confidence: 0.9, userLocked: false });
    expect(ids(block)).toEqual([1, 2, 3, 4]);
    expect(block.appsUsed).toEqual(['Chrome', 'VS Code', 'Windows Terminal']);
    expect(block.startedAt.toISOString()).toBe(t('09:00'));
    expect(block.endedAt.toISOString()).toBe(t('10:00'));
    expect(block.source).toBe('generated');
    // AI interpretation never leaks into the raw events.
    expect(w.events.events).toEqual(snapshot);
    expect(block.events[0]).toEqual(snapshot[0]);
  });

  it('classifies an AI block from the existing taxonomy', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    const [block] = w.timeline.getToday();

    expect(block.classification).toMatchObject({
      source: 'ai',
      context: { id: 'coding', name: 'Coding' },
      area: { id: 'area_work', name: 'Work' },
      intent: { id: 'intent_create', name: 'Create' },
      quality: { id: 'quality_focused', name: 'Focused' },
      isOverride: false,
    });
  });

  it('mixes AI activities with deterministic fallback for uncovered events', async () => {
    const events = [...hour(), makeEvent(5, t('10:00'), t('10:30'), { app: 'Figma', title: 'Mockups' })];
    const w = makeWorld(events, [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    const timeline = w.timeline.getToday();

    expect(timeline).toHaveLength(2);
    expect(timeline[0].ai?.title).toBe('Build Reflect timeline UI');
    expect(timeline[1].ai).toBeUndefined();
    expect(timeline[1].id).toMatch(/^s-5-/);
    expect(ids(timeline[1])).toEqual([5]);
    // Every raw event is shown exactly once.
    expect(timeline.flatMap(ids).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('events the model left unassigned stay on the timeline as fallback', async () => {
    const w = makeWorld(hour(), [
      modelOutput([modelActivity({ eventIds: [1, 2, 3], startedAt: t('09:00'), endedAt: t('09:45') })], [4]),
    ]);
    await w.service.analyzeWindow(WS, WE);

    const timeline = w.timeline.getToday();

    expect(timeline.map(ids)).toEqual([[1, 2, 3], [4]]);
    expect(timeline[1].ai).toBeUndefined();
  });

  it('keeps working when the intelligence store fails', () => {
    const w = makeWorld(hour());
    w.repo.getActiveMemberships = () => {
      throw new Error('db gone');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const timeline = w.timeline.getToday();

    expect(timeline.flatMap(ids).sort()).toEqual([1, 2, 3, 4]);
    errorSpy.mockRestore();
  });
});

describe('User edits take precedence over AI', () => {
  it('a user split survives AI reprocessing', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);
    const activityId = w.repo.active()[0].id;

    w.timeline.apply('split', { eventIdsHint: [1, 2, 3, 4], afterEventIndex: 1 });
    expect(w.repo.activities.get(activityId)!.userLocked).toBe(true);
    expect(w.timeline.getToday().map(ids)).toEqual([[1, 2], [3, 4]]);

    // A later run proposes a completely different reading of the same hour.
    w.gemini.push(
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1], startedAt: t('09:00'), endedAt: t('09:15'), title: 'Something else' }),
        modelActivity({ temporaryId: 'a2', eventIds: [2, 3, 4], startedAt: t('09:15'), endedAt: t('10:00'), title: 'Another thing' }),
      ]),
    );
    const rerun = await w.service.analyzeWindow(WS, WE, { force: true });

    expect(rerun).toMatchObject({ status: 'succeeded', activitiesCreated: 0, activitiesExtended: 0 });
    expect(w.repo.active()).toHaveLength(1);
    expect(w.repo.active()[0]).toMatchObject({ id: activityId, title: 'Build Reflect timeline UI', userLocked: true });
    const timeline = w.timeline.getToday();
    expect(timeline.map(ids)).toEqual([[1, 2], [3, 4]]);
    expect(timeline.map((s) => s.ai?.title)).toEqual(['Build Reflect timeline UI', 'Build Reflect timeline UI']);
  });

  it('a user merge survives AI reprocessing', async () => {
    const w = makeWorld(hour(), [
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1, 2], startedAt: t('09:00'), endedAt: t('09:30'), title: 'Research React' }),
        modelActivity({ temporaryId: 'a2', eventIds: [3, 4], startedAt: t('09:30'), endedAt: t('10:00'), title: 'Implement block' }),
      ]),
    ]);
    await w.service.analyzeWindow(WS, WE);
    expect(w.timeline.getToday().map(ids)).toEqual([[1, 2], [3, 4]]);

    w.timeline.apply('merge', { eventIdsHint: [1, 2] });
    expect(w.timeline.getToday().map(ids)).toEqual([[1, 2, 3, 4]]);
    expect(w.repo.active().every((a) => a.userLocked)).toBe(true);

    w.gemini.push(
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1], startedAt: t('09:00'), endedAt: t('09:15') }),
        modelActivity({ temporaryId: 'a2', eventIds: [2, 3], startedAt: t('09:15'), endedAt: t('09:45') }),
        modelActivity({ temporaryId: 'a3', eventIds: [4], startedAt: t('09:45'), endedAt: t('10:00') }),
      ]),
    );
    await w.service.analyzeWindow(WS, WE, { force: true });

    expect(w.timeline.getToday().map(ids)).toEqual([[1, 2, 3, 4]]);
    expect(w.repo.active().map((a) => a.title)).toEqual(['Research React', 'Implement block']);
  });

  it('a user delete is respected by later AI runs', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    w.timeline.apply('delete', { eventIdsHint: [1, 2, 3, 4] });
    expect(w.timeline.getToday()).toEqual([]);

    w.gemini.push(oneActivity('Resurrected'));
    await w.service.analyzeWindow(WS, WE, { force: true });

    expect(w.timeline.getToday()).toEqual([]);
    expect(w.repo.active().map((a) => a.title)).toEqual(['Build Reflect timeline UI']);
  });

  it('a user rename and note beat the AI title and survive reprocessing', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    w.timeline.apply('rename', { eventIdsHint: [1, 2, 3, 4], newTitle: 'Pairing with Sam' });
    w.timeline.apply('note', { eventIdsHint: [1, 2, 3, 4], note: 'remember this' });
    w.gemini.push(oneActivity('AI wants a new title'));
    await w.service.analyzeWindow(WS, WE, { force: true });

    const [block] = w.timeline.getToday();
    expect(block.customTitle).toBe('Pairing with Sam');
    expect(block.note).toBe('remember this');
    expect(block.ai?.title).toBe('Build Reflect timeline UI');
  });

  it('a manual classification overrides the AI classification and locks the activity', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);
    expect(w.timeline.getToday()[0].classification?.source).toBe('ai');

    w.categorization.saveOverride(
      [1, 2, 3, 4],
      { contextId: 'learning', areaId: 'area_leisure', intentId: 'intent_consume', qualityId: null },
      false,
    );

    const [block] = w.timeline.getToday();
    expect(block.classification).toMatchObject({
      source: 'user_override',
      isOverride: true,
      context: { id: 'learning' },
      area: { id: 'area_leisure' },
      quality: null,
    });
    const activity = w.repo.active()[0];
    expect(activity.userLocked).toBe(true);
    // The AI interpretation is kept beside the correction for later comparison.
    expect(activity).toMatchObject({ contextId: 'coding', areaId: 'area_work' });
    expect(JSON.parse(w.repo.runs[0].outputJson!).activities[0].areaId).toBe('area_work');

    w.gemini.push(oneActivity('New reading'));
    await w.service.analyzeWindow(WS, WE, { force: true });
    expect(w.timeline.getToday()[0].classification?.source).toBe('user_override');
  });

  it('a locked activity is neither extended nor rewritten by a continuation', async () => {
    const events = [...hour(), makeEvent(5, t('10:00'), t('10:30'), { app: 'VS Code', title: 'Ruler.tsx - reflect' })];
    const w = makeWorld(events, [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);
    const locked = w.repo.active()[0];
    w.timeline.apply('rename', { eventIdsHint: [1, 2, 3, 4], newTitle: 'Mine' });

    w.gemini.push(
      modelOutput(
        [modelActivity({ eventIds: [5], continuationOfActivityId: locked.id, startedAt: t('10:00'), endedAt: t('10:30'), title: 'Keep building' })],
        [],
        [t('10:00'), t('11:00')],
      ),
    );
    const result = await w.service.analyzeWindow(t('10:00'), t('11:00'));

    expect(result).toMatchObject({ status: 'succeeded', activitiesCreated: 1, activitiesExtended: 0 });
    expect(w.repo.getActivityEventIds(locked.id)).toEqual([1, 2, 3, 4]);
    expect(w.repo.activities.get(locked.id)).toMatchObject({ title: 'Build Reflect timeline UI', endedAt: t('10:00') });
    expect(w.timeline.getToday().map(ids)).toEqual([[1, 2, 3, 4], [5]]);
    expect(w.timeline.getToday()[0].customTitle).toBe('Mine');
  });

  it('an edit made on a deterministic block is not replaced by a later AI run', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    const before = w.timeline.getToday();
    w.timeline.apply('rename', { eventIdsHint: ids(before[0]), newTitle: 'My own label' });
    const edited = w.timeline.getToday();

    const result = await w.service.analyzeWindow(WS, WE);

    expect(result.status).toBe('succeeded');
    const after = w.timeline.getToday();
    expect(after.map((s) => [s.id, s.customTitle])).toEqual(edited.map((s) => [s.id, s.customTitle]));
    expect(after.find((s) => s.customTitle === 'My own label')!.ai).toBeUndefined();
    // Untouched regions are still free for the AI.
    const untouched = hour().map((e) => e.id).filter((id) => !ids(before[0]).includes(id));
    expect(w.repo.active().flatMap((a) => w.repo.getActivityEventIds(a.id)).sort()).toEqual(untouched);
  });

  it('unedited regions are updated normally', async () => {
    const w = makeWorld(hour(), [oneActivity()]);
    await w.service.analyzeWindow(WS, WE);

    w.gemini.push(oneActivity('Refined title'));
    await w.service.analyzeWindow(WS, WE, { force: true });

    expect(w.timeline.getToday().map((s) => s.ai?.title)).toEqual(['Refined title']);
  });
});
