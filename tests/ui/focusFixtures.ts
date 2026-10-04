/** Fixtures for the Focus view tests. Shapes mirror the DTOs in types.d.ts. */

export const T0 = Date.parse('2026-03-02T09:00:00.000Z');
export const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function profile(overrides: Partial<FocusProfileDto> = {}): FocusProfileDto {
  return {
    id: 'profile-1',
    name: 'Deep Work',
    description: null,
    isDefault: true,
    mode: 'countdown',
    defaultDurationMinutes: 60,
    blocksDistractions: true,
    soundCue: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    rules: [],
    ruleIds: [],
    blocking: { enabled: true, ruleCount: 5, siteCount: 38, appCount: 4 },
    ...overrides,
  };
}

export function session(overrides: Partial<FocusSessionDto> = {}): FocusSessionDto {
  return {
    id: 'session-1',
    profileId: 'profile-1',
    task: 'Finish authentication',
    notes: null,
    mode: 'countdown',
    plannedDurationMinutes: 60,
    state: 'active',
    startedAt: iso(T0),
    endedAt: null,
    pausedAt: null,
    totalPauseMs: 0,
    elapsedMs: 0,
    blockingLeaseId: 'lease-1',
    endReason: null,
    endNote: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

export function active(overrides: Partial<ActiveFocusSessionDto> = {}, sessionOverrides: Partial<FocusSessionDto> = {}): ActiveFocusSessionDto {
  return {
    session: session(sessionOverrides),
    profile: profile(),
    liveElapsedMs: 0,
    isRunning: true,
    remainingMs: 60 * MIN,
    plannedEndsAt: iso(T0 + 60 * MIN),
    pauseKind: null,
    blocking: { status: 'active', ruleCount: 5, message: null },
    ...overrides,
  };
}

export function stopwatch(overrides: Partial<ActiveFocusSessionDto> = {}, sessionOverrides: Partial<FocusSessionDto> = {}): ActiveFocusSessionDto {
  return active(
    { remainingMs: null, plannedEndsAt: null, ...overrides },
    { mode: 'stopwatch', plannedDurationMinutes: null, ...sessionOverrides },
  );
}

export function challenge(overrides: Partial<EndFocusChallengeDto> = {}): EndFocusChallengeDto {
  return {
    token: 'token-1',
    sessionId: 'session-1',
    early: true,
    requiresPhrase: true,
    phrase: 'END',
    remainingMs: 38 * MIN,
    expiresAt: iso(T0 + 24 * MIN),
    ...overrides,
  };
}

export function summary(sessionOverrides: Partial<FocusSessionDto> = {}): FocusSummaryDto {
  return {
    session: session({ state: 'completed', endReason: 'completed', endedAt: iso(T0 + 60 * MIN), elapsedMs: 54 * MIN, ...sessionOverrides }),
    profile: profile(),
    trackedSessionIds: [],
    interruptionCount: 3,
    blockedAttemptCount: 7,
    productiveMs: 50 * MIN,
  };
}

export { iso };
