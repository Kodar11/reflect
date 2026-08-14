import { describe, it, expect } from 'vitest';
import { ClassificationEngine } from '../../src/categorization/ClassificationEngine.js';
import type {
  CategorizationRule,
  CategorizationOverride,
  ContextEntry,
  DimensionEntry,
  EventLike,
  FocusContextSignal,
  RuleCondition,
  SessionLike,
} from '../../src/categorization/Classification.js';
import { UNCLASSIFIED } from '../../src/categorization/Classification.js';

function makeSession(overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    id: 's-1-1',
    startedAt: '2024-01-01T10:00:00Z',
    endedAt: '2024-01-01T10:30:00Z',
    primaryApp: 'VS Code',
    primaryBrowser: undefined,
    primaryTitle: 'main.ts',
    primaryUrl: undefined,
    appsUsed: ['VS Code'],
    browserTabs: [],
    events: [{ id: 1 }],
    ...overrides,
  };
}

const CONTEXTS: ContextEntry[] = [
  { id: 'planmay', name: 'Planmay', color: 'blue' },
  { id: 'hobby', name: 'Hobby', color: 'green' },
  { id: 'video_editing', name: 'Video Editing', color: 'purple' },
];

const DIMENSIONS: DimensionEntry[] = [
  { id: 'area_work', dimension: 'area', name: 'Work', sortOrder: 0 },
  { id: 'area_learning', dimension: 'area', name: 'Learning', sortOrder: 1 },
  { id: 'area_personal', dimension: 'area', name: 'Personal', sortOrder: 2 },
  { id: 'area_leisure', dimension: 'area', name: 'Leisure', sortOrder: 3 },
  { id: 'intent_create', dimension: 'intent', name: 'Create', sortOrder: 0 },
  { id: 'intent_learn', dimension: 'intent', name: 'Learn', sortOrder: 1 },
  { id: 'intent_communicate', dimension: 'intent', name: 'Communicate', sortOrder: 2 },
  { id: 'intent_consume', dimension: 'intent', name: 'Consume', sortOrder: 3 },
  { id: 'quality_deep', dimension: 'quality', name: 'Deep', sortOrder: 0 },
  { id: 'quality_focused', dimension: 'quality', name: 'Focused', sortOrder: 1 },
  { id: 'quality_routine', dimension: 'quality', name: 'Routine', sortOrder: 2 },
  { id: 'quality_distracting', dimension: 'quality', name: 'Distracting', sortOrder: 3 },
];

function makeRule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: 'rule_1',
    conditions: [{ type: 'app_equals', value: 'VS Code' }],
    contextId: 'planmay',
    areaId: 'area_work',
    intentId: 'intent_create',
    qualityId: 'quality_deep',
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

const engine = new ClassificationEngine();

function classifySession(
  session: SessionLike,
  rules: CategorizationRule[] = [],
  overrides: CategorizationOverride[] = [],
  focusSignals: FocusContextSignal[] = [],
) {
  return engine.classify({
    session,
    rules,
    overrides,
    contexts: CONTEXTS,
    dimensions: DIMENSIONS,
    focusSignals,
  });
}

// ── Test A: App-only rule ──
describe('Test A: App-only rule', () => {
  it('classifies VS Code as Work', () => {
    const rule = makeRule();
    const result = classifySession(makeSession(), [rule]);
    expect(result.source).toBe('user_rule');
    expect(result.context?.name).toBe('Planmay');
    expect(result.area?.name).toBe('Work');
    expect(result.matchedRuleId).toBe('rule_1');
  });
});

// ── Test B: App + website rule ──
describe('Test B: App + website rule', () => {
  it('classifies Chrome + github.com as Work', () => {
    const rule = makeRule({
      id: 'rule_github',
      conditions: [
        { type: 'app_equals', value: 'Chrome' },
        { type: 'domain_equals', value: 'github.com' },
      ],
      contextId: 'planmay',
    });
    const session = makeSession({
      primaryApp: 'Chrome',
      primaryUrl: 'github.com',
      appsUsed: ['Chrome'],
      browserTabs: ['github.com'],
    });
    const result = classifySession(session, [rule]);
    expect(result.source).toBe('user_rule');
    expect(result.context?.name).toBe('Planmay');
  });
});

// ── Test C: Title rule ──
describe('Test C: Title rule', () => {
  it('classifies YouTube + "React tutorial" as Learning', () => {
    const rule = makeRule({
      id: 'rule_react',
      conditions: [
        { type: 'domain_equals', value: 'youtube.com' },
        { type: 'title_contains', value: 'React tutorial' },
      ],
      contextId: 'planmay',
      areaId: 'area_learning',
      intentId: 'intent_learn',
      qualityId: 'quality_focused',
    });
    const session = makeSession({
      primaryApp: 'Brave Browser',
      primaryUrl: 'youtube.com',
      primaryTitle: 'React tutorial for beginners - YouTube',
      appsUsed: ['Brave Browser'],
      browserTabs: ['youtube.com'],
    });
    const result = classifySession(session, [rule]);
    expect(result.source).toBe('user_rule');
    expect(result.area?.name).toBe('Learning');
    expect(result.intent?.name).toBe('Learn');
  });
});

// ── Test D: Specific rule overrides broad rule ──
describe('Test D: Specific beats broad', () => {
  it('Chrome+GitHub rule beats Chrome-only rule', () => {
    const broad = makeRule({
      id: 'rule_broad',
      conditions: [{ type: 'app_equals', value: 'Chrome' }],
      contextId: 'hobby',
      areaId: 'area_personal',
    });
    const specific = makeRule({
      id: 'rule_specific',
      conditions: [
        { type: 'app_equals', value: 'Chrome' },
        { type: 'domain_equals', value: 'github.com' },
      ],
      contextId: 'planmay',
      areaId: 'area_work',
    });
    const session = makeSession({
      primaryApp: 'Chrome',
      primaryUrl: 'github.com',
      appsUsed: ['Chrome'],
      browserTabs: ['github.com'],
    });
    const result = classifySession(session, [broad, specific]);
    expect(result.source).toBe('user_rule');
    expect(result.context?.name).toBe('Planmay');
    expect(result.matchedRuleId).toBe('rule_specific');
  });
});

// ── Test E: Historical override ──
describe('Test E: Historical override', () => {
  it('override wins over matching rules', () => {
    const rule = makeRule({ id: 'rule_auto' });
    const override: CategorizationOverride = {
      id: 'ov_1',
      eventIds: [1],
      anchorEventId: 1,
      contextId: 'hobby',
      areaId: 'area_personal',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    };
    const result = classifySession(makeSession(), [rule], [override]);
    expect(result.source).toBe('user_override');
    expect(result.context?.name).toBe('Hobby');
    expect(result.area?.name).toBe('Personal');
    expect(result.isOverride).toBe(true);
  });

  it('override survives timeline edits via anchor event id', () => {
    const rule = makeRule({ id: 'rule_auto' });
    const override: CategorizationOverride = {
      id: 'ov_1',
      eventIds: [1, 2],
      anchorEventId: 1,
      contextId: 'hobby',
      areaId: 'area_personal',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    };
    // Session was split/merged: exact event-id set changed, but anchor event 1 remains.
    const editedSession = makeSession({ events: [{ id: 1 }, { id: 3 }] });
    const result = classifySession(editedSession, [rule], [override]);
    expect(result.source).toBe('user_override');
    expect(result.context?.name).toBe('Hobby');
  });
});

// ── Test F: Remember rule behavior is tested via CategorizationService ──

// ── Test G: Focus context ──
describe('Test G: Focus context', () => {
  it('focus supplies context name when no rule matches', () => {
    const signals: FocusContextSignal[] = [{
      task: 'Build Planmay authentication',
      profileName: 'Development',
      sessionStartedAt: '2024-01-01T09:00:00Z',
      sessionEndedAt: '2024-01-01T12:00:00Z',
    }];
    const result = classifySession(makeSession(), [], [], signals);
    expect(result.source).toBe('focus_context');
    expect(result.context?.name).toBe('Build Planmay authentication');
    expect(result.area).toBeNull();
    expect(result.intent).toBeNull();
    expect(result.quality).toBeNull();
  });
});

// ── Test H: User override beats everything ──
describe('Test H: User override beats rules and focus', () => {
  it('override wins over rules and focus', () => {
    const rule = makeRule({ id: 'rule_auto' });
    const signals: FocusContextSignal[] = [{
      task: 'Some Focus Task',
      profileName: 'Dev',
      sessionStartedAt: '2024-01-01T09:00:00Z',
      sessionEndedAt: '2024-01-01T12:00:00Z',
    }];
    const override: CategorizationOverride = {
      id: 'ov_1',
      eventIds: [1],
      contextId: 'video_editing',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    };
    const result = classifySession(makeSession(), [rule], [override], signals);
    expect(result.source).toBe('user_override');
    expect(result.context?.name).toBe('Video Editing');
  });
});

// ── Test I: Determinism ──
describe('Test I: Determinism', () => {
  it('same inputs yield same output', () => {
    const rule = makeRule();
    const session = makeSession();
    const r1 = classifySession(session, [rule]);
    const r2 = classifySession(session, [rule]);
    expect(r1).toEqual(r2);
  });
});

// ── Test J: No matching rule → Unclassified ──
describe('Test J: No matching rule', () => {
  it('returns unclassified', () => {
    const result = classifySession(makeSession(), []);
    expect(result.source).toBe('unclassified');
    expect(result.context).toBeNull();
    expect(result.area).toBeNull();
  });
});

// ── Test K: Multiple rules → deterministic winner ──
describe('Test K: Multiple rules, deterministic winner', () => {
  it('higher priority wins', () => {
    const low = makeRule({ id: 'a', priority: 0, contextId: 'hobby' });
    const high = makeRule({ id: 'b', priority: 1, contextId: 'planmay' });
    const result = classifySession(makeSession(), [low, high]);
    expect(result.matchedRuleId).toBe('b');
  });

  it('equal priority, higher specificity wins', () => {
    const broad = makeRule({
      id: 'a',
      priority: 0,
      conditions: [{ type: 'app_equals', value: 'VS Code' }],
      contextId: 'hobby',
    });
    const specific = makeRule({
      id: 'b',
      priority: 0,
      conditions: [
        { type: 'app_equals', value: 'VS Code' },
        { type: 'title_contains', value: 'main' },
      ],
      contextId: 'planmay',
    });
    const session = makeSession({ primaryTitle: 'main.ts' });
    const result = classifySession(session, [broad, specific]);
    expect(result.matchedRuleId).toBe('b');
  });
});

// ── Test N: Rule deletion → falls back ──
describe('Test N: Rule deletion fallback', () => {
  it('empty rules → unclassified', () => {
    const rule = makeRule();
    const resultWithRule = classifySession(makeSession(), [rule]);
    expect(resultWithRule.source).toBe('user_rule');
    // Simulate deletion by not passing the rule
    const resultWithoutRule = classifySession(makeSession(), []);
    expect(resultWithoutRule.source).toBe('unclassified');
  });
});

// ── Test O: Rule disable → falls back ──
describe('Test O: Rule disable fallback', () => {
  it('disabled rule is skipped', () => {
    const rule = makeRule({ enabled: false });
    const result = classifySession(makeSession(), [rule]);
    expect(result.source).toBe('unclassified');
  });
});

function classifyEvent(
  event: EventLike,
  rules: CategorizationRule[] = [],
) {
  return engine.classifyEvent(event, rules, CONTEXTS, DIMENSIONS);
}

// ── Event-level classification ──
describe('Event-level classification', () => {
  it('classifies an unclassified event by domain rule', () => {
    const rule: CategorizationRule = {
      id: 'rule_yt',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      contextId: 'hobby',
      areaId: 'area_learning',
      intentId: 'intent_learn',
      qualityId: 'quality_focused',
      priority: 0,
      enabled: true,
    };
    const event: EventLike = {
      id: 1,
      app: 'Brave Browser',
      url: 'https://youtube.com/watch',
      title: 'Some video',
    };
    const result = classifyEvent(event, [rule]);
    expect(result.source).toBe('user_rule');
    expect(result.context?.name).toBe('Hobby');
    expect(result.area?.name).toBe('Learning');
    expect(result.matchedRuleId).toBe('rule_yt');
  });

  it('classifies an unclassified event by app rule', () => {
    const rule: CategorizationRule = {
      id: 'rule_vscode',
      conditions: [{ type: 'app_equals', value: 'VS Code' }],
      contextId: 'planmay',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      priority: 0,
      enabled: true,
    };
    const event: EventLike = {
      id: 2,
      app: 'Visual Studio Code',
      title: 'main.ts',
    };
    const result = classifyEvent(event, [rule]);
    expect(result.source).toBe('user_rule');
    expect(result.context?.name).toBe('Planmay');
    expect(result.matchedRuleId).toBe('rule_vscode');
  });

  it('returns unclassified when no rule matches', () => {
    const event: EventLike = {
      id: 3,
      app: 'Brave Browser',
      url: 'https://example.com',
    };
    const result = classifyEvent(event, []);
    expect(result.source).toBe('unclassified');
    expect(result.context).toBeNull();
  });

  it('skips disabled rules', () => {
    const rule: CategorizationRule = {
      id: 'rule_yt',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      contextId: 'hobby',
      areaId: 'area_learning',
      intentId: 'intent_learn',
      qualityId: 'quality_focused',
      priority: 0,
      enabled: false,
    };
    const event: EventLike = {
      id: 4,
      url: 'https://youtube.com/watch',
    };
    const result = classifyEvent(event, [rule]);
    expect(result.source).toBe('unclassified');
  });

  it('uses specificity as a tie-breaker for event rules', () => {
    const broad: CategorizationRule = {
      id: 'rule_broad',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      contextId: 'hobby',
      areaId: 'area_learning',
      intentId: 'intent_learn',
      qualityId: 'quality_focused',
      priority: 10,
      enabled: true,
    };
    const specific: CategorizationRule = {
      id: 'rule_specific',
      conditions: [
        { type: 'domain_equals', value: 'youtube.com' },
        { type: 'title_contains', value: 'tutorial' },
      ],
      contextId: 'planmay',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      priority: 10,
      enabled: true,
    };
    const event: EventLike = {
      id: 5,
      url: 'https://youtube.com/watch',
      title: 'React tutorial',
    };
    const result = classifyEvent(event, [broad, specific]);
    expect(result.matchedRuleId).toBe('rule_specific');
  });
});

// ── Test Q: Browser website classification ──
describe('Test Q: Browser website classification', () => {
  it('YouTube → Learning/Learn/Focused', () => {
    const rule = makeRule({
      id: 'rule_yt',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      areaId: 'area_learning',
      intentId: 'intent_learn',
      qualityId: 'quality_focused',
    });
    const session = makeSession({
      primaryApp: 'Brave Browser',
      primaryUrl: 'youtube.com',
      primaryTitle: 'Some video - YouTube',
      appsUsed: ['Brave Browser'],
      browserTabs: ['youtube.com'],
    });
    const result = classifySession(session, [rule]);
    expect(result.area?.name).toBe('Learning');
    expect(result.intent?.name).toBe('Learn');
  });

  it('ChatGPT → Work/Create/Deep', () => {
    const rule = makeRule({
      id: 'rule_gpt',
      conditions: [{ type: 'domain_equals', value: 'chatgpt.com' }],
      contextId: 'planmay',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });
    const session = makeSession({
      primaryApp: 'Brave Browser',
      primaryUrl: 'chatgpt.com',
      primaryTitle: 'ChatGPT',
      appsUsed: ['Brave Browser'],
      browserTabs: ['chatgpt.com'],
    });
    const result = classifySession(session, [rule]);
    expect(result.area?.name).toBe('Work');
    expect(result.intent?.name).toBe('Create');
  });

  it('YouTube and GitHub → different classifications', () => {
    const ytRule = makeRule({
      id: 'rule_yt',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });
    const ghRule = makeRule({
      id: 'rule_gh',
      conditions: [{ type: 'domain_equals', value: 'github.com' }],
      contextId: 'planmay',
      areaId: 'area_work',
      intentId: 'intent_communicate',
      qualityId: 'quality_routine',
    });
    const ytSession = makeSession({
      primaryApp: 'Brave Browser',
      primaryUrl: 'youtube.com',
      primaryTitle: 'Cat videos',
      appsUsed: ['Brave Browser'],
      browserTabs: ['youtube.com'],
    });
    const ghSession = makeSession({
      id: 's-2-1',
      events: [{ id: 2 }],
      primaryApp: 'Brave Browser',
      primaryUrl: 'github.com',
      primaryTitle: 'Pull request',
      appsUsed: ['Brave Browser'],
      browserTabs: ['github.com'],
    });
    const ytResult = classifySession(ytSession, [ytRule, ghRule]);
    const ghResult = classifySession(ghSession, [ytRule, ghRule]);
    expect(ytResult.area?.name).toBe('Leisure');
    expect(ghResult.area?.name).toBe('Work');
  });
});

// ── Test R: Mixed browser contexts ──
describe('Test R: Mixed browser, different websites', () => {
  it('same browser, different sites → different classifications', () => {
    const ytRule = makeRule({
      id: 'yt',
      conditions: [{ type: 'domain_equals', value: 'youtube.com' }],
      areaId: 'area_leisure',
    });
    const ghRule = makeRule({
      id: 'gh',
      conditions: [{ type: 'domain_equals', value: 'github.com' }],
      areaId: 'area_work',
    });
    const ytSession = makeSession({
      primaryUrl: 'youtube.com',
      browserTabs: ['youtube.com'],
    });
    const ghSession = makeSession({
      id: 's-2-1',
      events: [{ id: 2 }],
      primaryUrl: 'github.com',
      browserTabs: ['github.com'],
    });
    expect(classifySession(ytSession, [ytRule, ghRule]).area?.name).toBe('Leisure');
    expect(classifySession(ghSession, [ytRule, ghRule]).area?.name).toBe('Work');
  });
});

// ── Test P: Category deletion/renaming ──
describe('Test P: Category deletion safety', () => {
  it('override with deleted context_id → context null, others intact', () => {
    const override: CategorizationOverride = {
      id: 'ov_1',
      eventIds: [1],
      anchorEventId: 1,
      contextId: 'nonexistent',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    };
    const result = classifySession(makeSession(), [], [override]);
    expect(result.context).toBeNull();
    expect(result.area?.name).toBe('Work');
  });
});

// ── Test S: Realistic day integration ──
describe('Test S: Realistic day integration', () => {
  it('classifies a full day of mixed activities', () => {
    const rules: CategorizationRule[] = [
      {
        id: 'rule_vscode',
        conditions: [{ type: 'app_equals', value: 'VS Code' }],
        contextId: 'planmay',
        areaId: 'area_work',
        intentId: 'intent_create',
        qualityId: 'quality_deep',
        priority: 0,
        enabled: true,
      },
      {
        id: 'rule_github',
        conditions: [{ type: 'domain_equals', value: 'github.com' }],
        contextId: 'planmay',
        areaId: 'area_work',
        intentId: 'intent_communicate',
        qualityId: 'quality_routine',
        priority: 0,
        enabled: true,
      },
      {
        id: 'rule_yt_react',
        conditions: [
          { type: 'domain_equals', value: 'youtube.com' },
          { type: 'title_contains', value: 'React tutorial' },
        ],
        contextId: 'hobby',
        areaId: 'area_learning',
        intentId: 'intent_learn',
        qualityId: 'quality_focused',
        priority: 0,
        enabled: true,
      },
      {
        id: 'rule_chatgpt',
        conditions: [{ type: 'domain_equals', value: 'chatgpt.com' }],
        contextId: 'planmay',
        areaId: 'area_work',
        intentId: 'intent_create',
        qualityId: 'quality_deep',
        priority: 0,
        enabled: true,
      },
      {
        id: 'rule_resolve',
        conditions: [{ type: 'app_equals', value: 'DaVinci Resolve' }],
        contextId: 'video_editing',
        areaId: 'area_work',
        intentId: 'intent_create',
        qualityId: 'quality_deep',
        priority: 0,
        enabled: true,
      },
    ];

    const sessions: SessionLike[] = [
      {
        id: 's-09-vscode',
        startedAt: '2024-01-01T09:00:00Z',
        endedAt: '2024-01-01T09:59:00Z',
        primaryApp: 'Visual Studio Code',
        primaryTitle: 'ic_launcher_round.xml - vrat - Visual Studio Code',
        appsUsed: ['Visual Studio Code'],
        browserTabs: [],
        events: [{ id: 1 }],
      },
      {
        id: 's-10-github',
        startedAt: '2024-01-01T10:00:00Z',
        endedAt: '2024-01-01T10:19:00Z',
        primaryApp: 'Google Chrome',
        primaryUrl: 'github.com',
        appsUsed: ['Google Chrome'],
        browserTabs: ['github.com'],
        events: [{ id: 2 }],
      },
      {
        id: 's-10-yt',
        startedAt: '2024-01-01T10:20:00Z',
        endedAt: '2024-01-01T10:59:00Z',
        primaryApp: 'Google Chrome',
        primaryUrl: 'youtube.com',
        primaryTitle: 'React tutorial for beginners - YouTube',
        appsUsed: ['Google Chrome'],
        browserTabs: ['youtube.com'],
        events: [{ id: 3 }],
      },
      {
        id: 's-11-gpt',
        startedAt: '2024-01-01T11:00:00Z',
        endedAt: '2024-01-01T11:59:00Z',
        primaryApp: 'Google Chrome',
        primaryUrl: 'chatgpt.com',
        primaryTitle: 'ChatGPT',
        appsUsed: ['Google Chrome'],
        browserTabs: ['chatgpt.com'],
        events: [{ id: 4 }],
      },
      {
        id: 's-12-insta',
        startedAt: '2024-01-01T12:00:00Z',
        endedAt: '2024-01-01T12:59:00Z',
        primaryApp: 'Google Chrome',
        primaryUrl: 'instagram.com',
        primaryTitle: 'Instagram',
        appsUsed: ['Google Chrome'],
        browserTabs: ['instagram.com'],
        events: [{ id: 5 }],
      },
      {
        id: 's-14-resolve',
        startedAt: '2024-01-01T14:00:00Z',
        endedAt: '2024-01-01T15:59:00Z',
        primaryApp: 'DaVinci Resolve',
        primaryTitle: 'Edit - DaVinci Resolve',
        appsUsed: ['DaVinci Resolve'],
        browserTabs: [],
        events: [{ id: 6 }],
      },
    ];

    const results = engine.classifyAll(sessions, rules, [], CONTEXTS, DIMENSIONS, []);

    const vscode = results.get('s-09-vscode')!;
    expect(vscode.source).toBe('user_rule');
    expect(vscode.context?.name).toBe('Planmay');
    expect(vscode.area?.name).toBe('Work');
    expect(vscode.intent?.name).toBe('Create');
    expect(vscode.quality?.name).toBe('Deep');

    const github = results.get('s-10-github')!;
    expect(github.source).toBe('user_rule');
    expect(github.intent?.name).toBe('Communicate');
    expect(github.quality?.name).toBe('Routine');

    const yt = results.get('s-10-yt')!;
    expect(yt.source).toBe('user_rule');
    expect(yt.area?.name).toBe('Learning');
    expect(yt.intent?.name).toBe('Learn');

    const gpt = results.get('s-11-gpt')!;
    expect(gpt.source).toBe('user_rule');
    expect(gpt.intent?.name).toBe('Create');
    expect(gpt.quality?.name).toBe('Deep');

    const insta = results.get('s-12-insta')!;
    expect(insta.source).toBe('unclassified');

    const resolve = results.get('s-14-resolve')!;
    expect(resolve.source).toBe('user_rule');
    expect(resolve.context?.name).toBe('Video Editing');
  });
});

function classifyEventDefault(event: EventLike, dims: DimensionEntry[] = DIMENSIONS) {
  return engine.classifyEventDefault(event, CONTEXTS, dims);
}

// ── Default event-level classification ──
describe('Default event-level classification', () => {
  it('ChatGPT domain → Work / Learn / Focused with null context', () => {
    const event: EventLike = {
      id: 100,
      app: 'Brave Browser',
      url: 'https://chatgpt.com/c/abc',
      title: 'ChatGPT',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.reason).toBe('Default: ChatGPT');
    expect(result.context).toBeNull();
    expect(result.area?.name).toBe('Work');
    expect(result.intent?.name).toBe('Learn');
    expect(result.quality?.name).toBe('Focused');
    expect(result.matchedRuleId).toBeNull();
    expect(result.isOverride).toBe(false);
  });

  it('ChatGPT app → Work / Learn / Focused', () => {
    const event: EventLike = {
      id: 101,
      app: 'ChatGPT',
      title: 'ChatGPT',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.area?.name).toBe('Work');
    expect(result.intent?.name).toBe('Learn');
  });

  it('uses Research intent when it exists', () => {
    const withResearch: DimensionEntry[] = [
      ...DIMENSIONS,
      { id: 'intent_research', dimension: 'intent', name: 'Research', sortOrder: 4 },
    ];
    const event: EventLike = {
      id: 102,
      url: 'https://chatgpt.com/c/abc',
    };
    const result = classifyEventDefault(event, withResearch);
    expect(result.intent?.id).toBe('intent_research');
    expect(result.intent?.name).toBe('Research');
  });

  it('VS Code: app → Work / Create / Focused with null context', () => {
    const event: EventLike = {
      id: 103,
      app: 'Visual Studio Code',
      title: 'main.ts',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.reason).toBe('Default: VS Code:');
    expect(result.context).toBeNull();
    expect(result.area?.name).toBe('Work');
    expect(result.intent?.name).toBe('Create');
    expect(result.quality?.name).toBe('Focused');
  });

  it('YouTube domain → Leisure / Consume / Routine with null context', () => {
    const event: EventLike = {
      id: 104,
      app: 'Brave Browser',
      url: 'https://youtube.com/watch?v=abc',
      title: 'Cat videos',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.reason).toBe('Default: YouTube');
    expect(result.context).toBeNull();
    expect(result.area?.name).toBe('Leisure');
    expect(result.intent?.name).toBe('Consume');
    expect(result.quality?.name).toBe('Routine');
  });

  it.each([
    'https://react.dev/learn/thinking-in-react',
    'https://developer.mozilla.org/en-US/docs/Web/API',
    'https://docs.python.org/3/tutorial',
  ])('documentation domain %s → Learning / Learn / Focused', (url) => {
    const event: EventLike = { id: 105, app: 'Brave Browser', url };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.reason).toBe('Default: Documentation');
    expect(result.area?.name).toBe('Learning');
    expect(result.intent?.name).toBe('Learn');
    expect(result.quality?.name).toBe('Focused');
  });

  it('unknown app returns unclassified', () => {
    const event: EventLike = {
      id: 106,
      app: 'SomeRandomApp',
      title: 'Untitled',
    };
    const result = classifyEventDefault(event);
    expect(result).toBe(UNCLASSIFIED);
  });

  it('context remains null when there is no reliable context signal', () => {
    const event: EventLike = {
      id: 107,
      url: 'https://chatgpt.com/c/abc',
    };
    const result = classifyEventDefault(event);
    expect(result.context).toBeNull();
  });

  it('case differences do not break matching', () => {
    const event: EventLike = {
      id: 108,
      app: 'brave browser',
      url: 'https://WWW.YOUTUBE.COM/watch',
      title: 'Video',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.area?.name).toBe('Leisure');
  });

  it('www normalization works', () => {
    const event: EventLike = {
      id: 109,
      url: 'https://www.chatgpt.com/',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.area?.name).toBe('Work');
  });

  it('missing URL does not crash', () => {
    const event: EventLike = {
      id: 110,
      app: 'VS Code:',
      title: 'main.ts',
      url: null,
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.area?.name).toBe('Work');
  });

  it('missing app does not crash', () => {
    const event: EventLike = {
      id: 111,
      app: null,
      url: 'https://youtube.com/watch',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
    expect(result.area?.name).toBe('Leisure');
  });

  it('missing title does not crash', () => {
    const event: EventLike = {
      id: 112,
      app: null,
      title: null,
      url: 'https://chatgpt.com/',
    };
    const result = classifyEventDefault(event);
    expect(result.source).toBe('default');
  });

  it('missing dimensions do not produce invalid IDs', () => {
    const emptyDimensions: DimensionEntry[] = [];
    const event: EventLike = {
      id: 113,
      url: 'https://chatgpt.com/',
    };
    const result = classifyEventDefault(event, emptyDimensions);
    expect(result.source).toBe('default');
    expect(result.area).toBeNull();
    expect(result.intent).toBeNull();
    expect(result.quality).toBeNull();
  });

  it('is deterministic across repeated calls', () => {
    const event: EventLike = {
      id: 114,
      url: 'https://chatgpt.com/',
    };
    const r1 = classifyEventDefault(event);
    const r2 = classifyEventDefault(event);
    expect(r1).toEqual(r2);
  });
});