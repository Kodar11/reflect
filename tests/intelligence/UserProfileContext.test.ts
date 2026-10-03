import { describe, it, expect } from 'vitest';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import type { OnboardingStatus, UserProfileInput } from '../../src/profile/UserProfile';
import { FakeUserProfileRepository, makeEvent, makeHarness, modelActivity, modelOutput, t } from './helpers';

/**
 * Onboarding profile → UserProfileContextProvider → IntelligenceService →
 * prompt → (scripted) Gemini. The saved profile is the only source of user
 * context; nothing is invented when it is missing.
 */
const WS = t('09:00');
const WE = t('10:00');

const PROFILE_A: UserProfileInput = {
  roles: ['Student', 'Developer'],
  description: 'I build software projects.',
  currentWork: ['Reflect', 'College'],
  priorities: ['Graduate', 'Ship Reflect'],
  interests: ['Gaming'],
  additionalContext: 'My game project is a hobby.',
};

const PROFILE_B: UserProfileInput = {
  roles: ['Founder'],
  description: 'I run a small design studio.',
  currentWork: ['Client branding'],
  priorities: ['Grow the studio'],
  interests: ['Cycling'],
  additionalContext: 'Some YouTube usage is coursework.',
};

/** Values of the removed hardcoded prototype context. */
const PROTOTYPE_VALUES = ['Computer Science student', 'game theory', 'volleyball', 'importantProjects'];

function expectNoPrototypeValues(text: string): void {
  for (const value of PROTOTYPE_VALUES) expect(text).not.toContain(value);
}

function providerWith(input: UserProfileInput | null, status: OnboardingStatus) {
  const profiles = new FakeUserProfileRepository();
  if (input) profiles.saveProfile(input, status);
  return { profiles, provider: new UserProfileContextProvider(profiles) };
}

const gameProjectEvents = () => [
  makeEvent(1, t('09:00'), t('09:40'), { app: 'VS Code', title: 'player.ts - GameProject - Visual Studio Code' }),
];
const okOutput = () => modelOutput([modelActivity({ eventIds: [1], endedAt: t('09:40') })]);

describe('UserProfileContextProvider', () => {
  it('returns the exact saved profile values', () => {
    const { provider } = providerWith(PROFILE_A, 'completed');

    expect(provider.getUserContext()).toEqual({
      roles: ['Student', 'Developer'],
      description: 'I build software projects.',
      currentWork: ['Reflect', 'College'],
      priorities: ['Graduate', 'Ship Reflect'],
      interests: ['Gaming'],
      interpretationNotes: 'My game project is a hobby.',
    });
    expect(provider.getOnboardingStatus()).toBe('completed');
  });

  it('returns no hardcoded prototype values, with or without a profile', () => {
    expect(providerWith(null, 'not_started').provider.getUserContext()).toBeNull();
    expectNoPrototypeValues(JSON.stringify(providerWith(PROFILE_A, 'completed').provider.getUserContext()));
  });

  it('returns null when onboarding was skipped, even if answers were saved', () => {
    expect(providerWith(PROFILE_A, 'skipped').provider.getUserContext()).toBeNull();
  });

  it('returns null when the profile is missing, not started or still in progress', () => {
    expect(providerWith(null, 'not_started').provider.getUserContext()).toBeNull();
    expect(providerWith(PROFILE_A, 'not_started').provider.getUserContext()).toBeNull();
    expect(providerWith(PROFILE_A, 'in_progress').provider.getUserContext()).toBeNull();
  });

  it('returns null — not an empty shell — when onboarding completed with no answers', () => {
    const empty: UserProfileInput = { roles: [], description: null, currentWork: [], priorities: [], interests: [], additionalContext: null };
    expect(providerWith(empty, 'completed').provider.getUserContext()).toBeNull();
  });

  it('reads the repository on every call instead of caching', () => {
    const { profiles, provider } = providerWith(PROFILE_A, 'completed');
    expect(provider.getUserContext()?.roles).toEqual(['Student', 'Developer']);

    profiles.saveProfile(PROFILE_B, 'completed');
    expect(provider.getUserContext()?.roles).toEqual(['Founder']);

    profiles.clearProfile();
    expect(provider.getUserContext()).toBeNull();
  });
});

describe('IntelligenceService — user profile reaches the Gemini request', () => {
  it('sends every completed onboarding answer and none of the prototype values', async () => {
    const h = makeHarness(gameProjectEvents(), [okOutput()]);
    h.profiles.saveProfile(PROFILE_A, 'completed');

    expect((await h.service.analyzeWindow(WS, WE)).status).toBe('succeeded');
    const { prompt } = h.gemini.requests[0];

    expect(prompt).toContain('USER CONTEXT (provided by the user about themselves)');
    expect(prompt).toContain('Who the user is: Student, Developer');
    expect(prompt).toContain('In their words: I build software projects.');
    expect(prompt).toContain('Currently working on: Reflect, College');
    expect(prompt).toContain('What matters most right now: Graduate, Ship Reflect');
    expect(prompt).toContain('Outside work or study: Gaming');
    expect(prompt).toContain('Interpretation notes: My game project is a hobby.');
    expectNoPrototypeValues(prompt);
    // Raw evidence is unchanged by the context.
    expect(prompt).toContain('"app":"VS Code","browser":null,"title":"player.ts - GameProject"');
  });

  it.each<[string, OnboardingStatus | null]>([
    ['no profile', null],
    ['not started', 'not_started'],
    ['skipped', 'skipped'],
  ])('still analyses with no user context: %s', async (_label, status) => {
    const h = makeHarness(gameProjectEvents(), [okOutput()]);
    if (status) h.profiles.saveProfile(PROFILE_A, status);

    const result = await h.service.analyzeWindow(WS, WE);
    const { prompt } = h.gemini.requests[0];

    expect(result).toMatchObject({ status: 'succeeded', activitiesCreated: 1 });
    expect(prompt).toContain('USER CONTEXT\nNot provided.');
    expect(prompt).not.toContain('I build software projects.');
    expect(prompt).not.toContain('My game project is a hobby.');
    expectNoPrototypeValues(prompt);
  });

  it('uses an edited profile on the next analysis without a restart', async () => {
    const h = makeHarness(gameProjectEvents(), [okOutput(), okOutput()]);
    h.profiles.saveProfile(PROFILE_A, 'completed');

    await h.service.analyzeWindow(WS, WE);
    expect(h.gemini.requests[0].prompt).toContain('Who the user is: Student, Developer');

    // Same path as Settings → Personalization (`userProfile:update`).
    h.profiles.updateProfile(PROFILE_B);
    await h.service.analyzeWindow(WS, WE, { force: true });
    const second = h.gemini.requests[1].prompt;

    expect(second).toContain('Who the user is: Founder');
    expect(second).toContain('Currently working on: Client branding');
    expect(second).toContain('Interpretation notes: Some YouTube usage is coursework.');
    expect(second).not.toContain('Student, Developer');
    expect(second).not.toContain('My game project is a hobby.');
  });

  it('keeps profile context and user rules in separate sections', async () => {
    const h = makeHarness(gameProjectEvents(), [okOutput()]);
    h.profiles.saveProfile(PROFILE_A, 'completed');
    h.rules.push({
      id: 'rule_game', activityId: 'learning', conditions: '[{"type":"title_contains","value":"GameProject"}]',
      enabled: 1, priority: 10, areaId: 'area_leisure', intentId: null, qualityId: null, source: 'user',
    });

    await h.service.analyzeWindow(WS, WE);
    const { prompt } = h.gemini.requests[0];
    const contextAt = prompt.indexOf('USER CONTEXT');
    const rulesAt = prompt.indexOf('USER RULES (explicitly created by the user)');
    const previousAt = prompt.indexOf('PREVIOUS ACTIVITIES');

    expect(contextAt).toBeGreaterThan(-1);
    expect(rulesAt).toBeGreaterThan(contextAt);
    const contextSection = prompt.slice(contextAt, rulesAt);
    const rulesSection = prompt.slice(rulesAt, previousAt);
    expect(contextSection).toContain('Interpretation notes: My game project is a hobby.');
    expect(contextSection).not.toContain('rule_game');
    expect(rulesSection).toContain('"id":"rule_game"');
    expect(rulesSection).toContain('"areaId":"area_leisure"');
    expect(rulesSection).not.toContain('My game project is a hobby.');
  });

  it('status reports whether context is used without exposing its contents', () => {
    const h = makeHarness([]);
    expect(h.service.getStatus()).toMatchObject({ hasUserContext: false, onboardingStatus: 'not_started', userRuleCount: 0 });

    h.profiles.saveProfile(PROFILE_A, 'completed');
    h.rules.push({
      id: 'rule_game', activityId: 'learning', conditions: '[{"type":"title_contains","value":"GameProject"}]',
      enabled: 1, priority: 10, areaId: null, intentId: null, qualityId: null, source: 'user',
    });
    const status = h.service.getStatus();

    expect(status).toMatchObject({ hasUserContext: true, onboardingStatus: 'completed', userRuleCount: 1 });
    expect(status.promptVersion).toMatch(/v\d+$/);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('I build software projects.');
    expect(serialized).not.toContain('My game project is a hobby.');

    h.profiles.updateProfile({ onboardingStatus: 'skipped' });
    expect(h.service.getStatus()).toMatchObject({ hasUserContext: false, onboardingStatus: 'skipped' });
  });
});
