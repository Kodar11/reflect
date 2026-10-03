import { describe, it, expect } from 'vitest';
import {
  PROMPT_VERSION,
  buildAnalysisPrompt,
  buildResponseJsonSchema,
  buildRetryFeedback,
  buildSystemInstruction,
} from '../../src/intelligence/IntelligencePrompt';
import type { AnalysisPromptInput } from '../../src/intelligence/IntelligenceModels';
import { t } from './helpers';

const input: AnalysisPromptInput = {
  windowStart: t('10:00'),
  windowEnd: t('11:00'),
  userContext: {
    roles: ['Student', 'Developer'],
    description: 'I build software projects.',
    currentWork: ['Reflect', 'College'],
    priorities: ['Graduate', 'Ship Reflect'],
    interests: ['Gaming'],
    interpretationNotes: 'My game project is a hobby.',
  },
  userRules: [
    {
      id: 'rule_gametheory',
      conditions: [{ type: 'title_contains', value: 'GameTheory' }],
      classification: { contextId: 'learning', areaId: 'area_personal', intentId: null, qualityId: null },
    },
  ],
  previousActivities: [
    {
      id: 'ai-prev-1',
      startedAt: t('09:10'),
      endedAt: t('09:58'),
      title: 'Implement Reflect classification system',
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
    },
  ],
  focus: [{ task: 'Ship Gemini layer', profileName: 'Deep Work', startedAt: t('09:55'), endedAt: null }],
  taxonomy: {
    contexts: [{ id: 'coding', name: 'Coding' }, { id: 'learning', name: 'Learning' }],
    areas: [{ id: 'area_work', name: 'Work' }, { id: 'area_personal', name: 'Personal' }],
    intents: [{ id: 'intent_create', name: 'Create' }],
    qualities: [{ id: 'quality_focused', name: 'Focused' }],
  },
  events: [
    {
      id: 123,
      watcher: 'window',
      startedAt: t('10:00'),
      endedAt: t('10:20'),
      app: 'VS Code',
      browser: null,
      title: 'EventsTab.tsx',
      url: null,
    },
  ],
};

describe('IntelligencePrompt', () => {
  const prompt = buildAnalysisPrompt(input);

  it('includes the user context', () => {
    expect(prompt).toContain(
      'USER CONTEXT (provided by the user about themselves)\n' +
        'Who the user is: Student, Developer\n' +
        'In their words: I build software projects.\n' +
        'Currently working on: Reflect, College\n' +
        'What matters most right now: Graduate, Ship Reflect\n' +
        'Outside work or study: Gaming\n' +
        'Interpretation notes: My game project is a hobby.',
    );
  });

  it('states that no user context was provided instead of assuming a persona', () => {
    const none = buildAnalysisPrompt({ ...input, userContext: null });
    expect(none).toContain('USER CONTEXT\nNot provided.');
    expect(none).not.toContain('Who the user is');
    // Rules, focus and evidence are unaffected by the missing context.
    expect(none).toContain('"id":"rule_gametheory"');
    expect(none).toContain('Ship Gemini layer');
    expect(none).toContain('EVENTS (1, chronological)');
  });

  it('keeps user context and user rules in separate sections', () => {
    const contextAt = prompt.indexOf('USER CONTEXT');
    const rulesAt = prompt.indexOf('USER RULES');
    expect(contextAt).toBeGreaterThan(-1);
    expect(rulesAt).toBeGreaterThan(contextAt);
    const contextSection = prompt.slice(contextAt, rulesAt);
    expect(contextSection).not.toContain('rule_gametheory');
    expect(prompt.slice(rulesAt)).not.toContain('My game project is a hobby.');
  });

  it('includes user rules compactly', () => {
    expect(prompt).toContain('USER RULES');
    expect(prompt).toContain('"id":"rule_gametheory"');
    expect(prompt).toContain('"conditions":[{"type":"title_contains","value":"GameTheory"}]');
    expect(prompt).toContain('"classification":{"contextId":"learning"');
  });

  it('includes the previous activity with its existing id', () => {
    expect(prompt).toContain('PREVIOUS ACTIVITIES');
    expect(prompt).toContain('"id":"ai-prev-1"');
    expect(prompt).toContain('Implement Reflect classification system');
  });

  it('includes the allowed taxonomy', () => {
    expect(prompt).toContain('ALLOWED CLASSIFICATIONS');
    expect(prompt).toContain('contexts: [{"id":"coding","name":"Coding"},{"id":"learning","name":"Learning"}]');
    expect(prompt).toContain('{"id":"area_work","name":"Work"}');
    expect(prompt).toContain('{"id":"intent_create","name":"Create"}');
    expect(prompt).toContain('{"id":"quality_focused","name":"Focused"}');
  });

  it('includes focus context and the current events with ids', () => {
    expect(prompt).toContain('Ship Gemini layer');
    expect(prompt).toContain('EVENTS (1, chronological)');
    expect(prompt).toContain(
      `{"id":123,"watcher":"window","startedAt":"${t('10:00')}","endedAt":"${t('10:20')}","app":"VS Code","browser":null,"title":"EventsTab.tsx","url":null}`,
    );
    expect(prompt).toContain(`"windowStart":"${t('10:00')}"`);
  });

  it('states absence explicitly instead of inventing rules or history', () => {
    const empty = buildAnalysisPrompt({ ...input, userRules: [], previousActivities: [], focus: [] });
    expect(empty).toContain('The user has not defined any personal rules.');
    expect(empty).toContain('Every activity in this window is new');
    expect(empty).toContain('FOCUS SESSIONS\nNone.');
  });

  it('system instruction carries the core rules and no application-reputation shortcuts', () => {
    const system = buildSystemInstruction();
    for (const heading of [
      'ROLE',
      'PRIMARY OBJECTIVE',
      'EVIDENCE PRINCIPLES',
      'ACTIVITY BOUNDARY RULE',
      'CONTINUITY RULE',
      'AMBIGUITY RULE',
      'CLASSIFICATION RULE',
      'USER RULE PRIORITY',
      'USER CONTEXT',
      'TIMELINE QUALITY',
      'NO JUDGMENT',
    ]) {
      expect(system).toContain(heading);
    }
    expect(system).toContain('Applications are evidence, not conclusions.');
    expect(PROMPT_VERSION).toMatch(/v\d+$/);
  });

  it('response schema only allows supplied classification and continuation ids', () => {
    const schema = buildResponseJsonSchema(input.taxonomy, ['ai-prev-1']) as any;
    const props = schema.properties.activities.items.properties;

    expect(props.contextId).toEqual({ anyOf: [{ type: 'string', enum: ['coding', 'learning'] }, { type: 'null' }] });
    expect(props.areaId.anyOf[0].enum).toEqual(['area_work', 'area_personal']);
    expect(props.continuationOfActivityId.anyOf[0].enum).toEqual(['ai-prev-1']);
    expect(schema.required).toContain('activities');

    const noHistory = buildResponseJsonSchema(input.taxonomy, []) as any;
    expect(noHistory.properties.activities.items.properties.continuationOfActivityId).toEqual({ type: 'null' });
  });

  it('retry feedback lists the rejection reasons', () => {
    expect(buildRetryFeedback(['activity a1: unknown event id 999'])).toContain('- activity a1: unknown event id 999');
  });
});
