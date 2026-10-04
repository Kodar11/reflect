import { describe, it, expect } from 'vitest';
import { validateAnalysisOutput, type ValidationContext } from '../../src/intelligence/IntelligenceValidator';
import type { EvidenceItem } from '../../src/intelligence/IntelligenceModels';
import { modelActivity, modelOutput, t } from './helpers';

function evidence(id: number, start: string, end: string, sourceEventIds = [id]): EvidenceItem {
  return { id, watcher: 'window', startedAt: start, endedAt: end, app: 'VS Code', browser: null, title: null, url: null, sourceEventIds };
}

const ctx: ValidationContext = {
  windowStart: t('09:00'),
  windowEnd: t('10:00'),
  evidence: [
    evidence(1, t('09:00'), t('09:20'), [1, 2]),
    evidence(3, t('09:20'), t('09:30')),
    evidence(4, t('09:30'), t('09:45')),
    evidence(5, t('09:45'), t('10:00')),
  ],
  taxonomy: {
    contexts: [{ id: 'coding', name: 'Coding' }],
    areas: [{ id: 'area_work', name: 'Work' }, { id: 'area_leisure', name: 'Leisure' }],
    intents: [{ id: 'intent_create', name: 'Create' }, { id: 'intent_consume', name: 'Consume' }],
    qualities: [{ id: 'quality_focused', name: 'Focused' }],
  },
  previousActivityIds: ['ai-prev'],
};

function errorsOf(raw: unknown): string[] {
  const result = validateAnalysisOutput(raw, ctx);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

describe('IntelligenceValidator', () => {
  it('accepts a valid result and expands evidence ids to raw event ids', () => {
    const result = validateAnalysisOutput(
      modelOutput(
        [
          modelActivity({ temporaryId: 'a1', eventIds: [3, 1], startedAt: t('09:00'), endedAt: t('09:30') }),
          modelActivity({
            temporaryId: 'a2',
            eventIds: [4],
            startedAt: t('09:30'),
            endedAt: t('09:45'),
            title: 'Watch YouTube',
            contextId: null,
            areaId: 'area_leisure',
            intentId: 'intent_consume',
            qualityId: null,
          }),
        ],
        [],
      ),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activities[0].eventIds).toEqual([1, 2, 3]); // chronological, merged block expanded
    expect(result.activities[1]).toMatchObject({ contextId: null, areaId: 'area_leisure', qualityId: null });
    // Event 5 was neither assigned nor listed → implicitly unassigned.
    expect(result.unassignedEventIds).toEqual([5]);
  });

  it('rejects a response that does not match the schema', () => {
    expect(errorsOf({ activities: 'nope' })[0]).toContain('schema');
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], confidence: 1.4 })])).join()).toContain('confidence');
    expect(errorsOf({ ...modelOutput([]), schemaVersion: 2 }).join()).toContain('schemaVersion');
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [] })])).join()).toContain('eventIds');
  });

  it('rejects an unknown event id', () => {
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1, 999] })]))).toContain('activity a1: unknown event id 999');
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1] })], [777]))).toContain(
      'unassignedEventIds: unknown event id 777',
    );
  });

  it('rejects an unknown classification id in any dimension', () => {
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], contextId: 'gaming' })])).join()).toContain(
      'contextId "gaming" is not an allowed id',
    );
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], areaId: 'area_made_up' })])).join()).toContain(
      'areaId "area_made_up" is not an allowed id',
    );
    // A real id from the wrong dimension is still invalid.
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], intentId: 'area_work' })])).join()).toContain(
      'intentId "area_work" is not an allowed id',
    );
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], qualityId: 'quality_deep' })])).join()).toContain(
      'qualityId',
    );
  });

  it('rejects duplicate event assignment within and across activities', () => {
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1, 1] })])).join()).toContain(
      'event id 1 listed more than once',
    );
    expect(
      errorsOf(
        modelOutput([
          modelActivity({ temporaryId: 'a1', eventIds: [1, 3] }),
          modelActivity({ temporaryId: 'a2', eventIds: [3, 4], startedAt: t('09:20'), endedAt: t('09:45') }),
        ]),
      ).join(),
    ).toContain('event id 3 is assigned to both activity a1 and activity a2');
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1] })], [1])).join()).toContain(
      'both assigned and unassigned',
    );
  });

  it('rejects invalid timestamps', () => {
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], startedAt: 'yesterday' })])).join()).toContain(
      'valid ISO timestamps',
    );
    expect(
      errorsOf(modelOutput([modelActivity({ eventIds: [1], startedAt: t('09:30'), endedAt: t('09:10') })])).join(),
    ).toContain('startedAt must be before endedAt');
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], endedAt: t('11:30') })])).join()).toContain(
      'endedAt is after the analysis window',
    );
    expect(errorsOf(modelOutput([modelActivity({ eventIds: [1], startedAt: t('07:00') })])).join()).toContain(
      'startedAt is before the first event shown',
    );
  });

  it('rejects an invalid continuation id and accepts a supplied one', () => {
    expect(
      errorsOf(modelOutput([modelActivity({ eventIds: [1], continuationOfActivityId: 'ai-invented' })])).join(),
    ).toContain('"ai-invented" is not one of the previous activities');

    expect(
      errorsOf(
        modelOutput([
          modelActivity({ temporaryId: 'a1', eventIds: [1], continuationOfActivityId: 'ai-prev' }),
          modelActivity({ temporaryId: 'a2', eventIds: [3], continuationOfActivityId: 'ai-prev' }),
        ]),
      ).join(),
    ).toContain('continued more than once');

    // A continued activity may have started before the window.
    const ok = validateAnalysisOutput(
      modelOutput([modelActivity({ eventIds: [1], continuationOfActivityId: 'ai-prev', startedAt: t('08:10') })]),
      ctx,
    );
    expect(ok.ok).toBe(true);
  });

  it('accepts an activity whose events surround another activity (an interruption does not end it)', () => {
    const result = validateAnalysisOutput(
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1, 4], endedAt: t('09:45') }),
        modelActivity({ temporaryId: 'a2', eventIds: [3], startedAt: t('09:20'), endedAt: t('09:30') }),
      ]),
      ctx,
    );
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.activities.map((a) => a.eventIds)).toEqual([[1, 2, 4], [3]]);
  });

  it('returns activities in the order they began, however the model listed them', () => {
    const result = validateAnalysisOutput(
      modelOutput([
        modelActivity({ temporaryId: 'late', eventIds: [4], startedAt: t('09:30'), endedAt: t('09:45') }),
        modelActivity({ temporaryId: 'early', eventIds: [1], startedAt: t('09:00'), endedAt: t('09:20') }),
      ]),
      ctx,
    );
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.activities.map((a) => a.temporaryId)).toEqual(['early', 'late']);
  });

  it('measures "before the window" from the start of the evidence when lookback context was sent', () => {
    const early = modelOutput([modelActivity({ eventIds: [1], startedAt: t('08:10') })]);
    expect(errorsOf(early).join()).toContain('startedAt is before the first event shown');
    expect(validateAnalysisOutput(early, { ...ctx, evidenceStart: t('08:00') }).ok).toBe(true);
  });

  it('treats "" as null and bounds free-text fields', () => {
    const result = validateAnalysisOutput(
      modelOutput([
        modelActivity({
          eventIds: [1],
          contextId: '',
          continuationOfActivityId: '',
          title: 'T'.repeat(500),
          uncertainty: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        }),
      ]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activities[0].contextId).toBeNull();
    expect(result.activities[0].continuationOfActivityId).toBeNull();
    expect(result.activities[0].title.length).toBeLessThanOrEqual(120);
    expect(result.activities[0].uncertainty).toHaveLength(5);
  });
});
