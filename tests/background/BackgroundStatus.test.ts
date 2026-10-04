import { describe, it, expect, vi } from 'vitest';
import { BackgroundStatusService, activityLabel, toBackgroundFocus } from '../../src/background/BackgroundStatus';
import { formatFocusClock, formatPauseEnd, formatTrackedDuration, trackingLabel } from '../../src/background/statusFormat';
import type { TrackingState } from '../../src/background/TrackingController';
import type { ActiveFocusSessionDto } from '../../src/focus/FocusModels';
import type { Event } from '../../src/models/Event';
import { manualTimers } from './helpers';

const NOW = new Date(2026, 9, 5, 14, 0, 0);
const iso = (h: number, m = 0, s = 0) => new Date(2026, 9, 5, h, m, s).toISOString();

const event = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  watcher: 'window',
  startedAt: iso(13, 40),
  endedAt: iso(13, 59, 56),
  app: 'Code',
  browser: null,
  title: 'secret-plan.md — Visual Studio Code',
  url: null,
  payload: null,
  createdAt: null,
  ...overrides,
});

const activeFocus = {
  session: { id: 'fs-1', task: 'Build landing page' },
  profile: { name: 'Deep Work' },
  liveElapsedMs: 696_000,
  isRunning: true,
  remainingMs: 2_304_000,
  plannedEndsAt: iso(14, 38, 24),
  pauseKind: null,
  blocking: { status: 'active', ruleCount: 3, message: null },
} as unknown as ActiveFocusSessionDto;

function setup() {
  const state = {
    tracking: { state: 'running', pausedSince: null, pausedUntil: null } as TrackingState,
    trackedMs: (3 * 60 + 18) * 60_000,
    latest: event() as Event | null,
    focus: null as ActiveFocusSessionDto | null,
    widgetVisible: true,
    now: NOW,
  };
  const sumTrackedMs = vi.fn((_from: string, _to: string) => state.trackedMs);
  const timers = manualTimers();
  const logger = { error: vi.fn() };
  const service = new BackgroundStatusService({
    tracking: { getState: () => state.tracking },
    events: { sumTrackedMs, getLatest: () => state.latest },
    focus: { getActiveSession: () => state.focus },
    widgetVisible: () => state.widgetVisible,
    dayStart: (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4), // the user's day starts at 04:00
    now: () => state.now,
    timers,
    logger,
  });
  return { service, state, sumTrackedMs, timers, logger };
}

describe('BackgroundStatusService', () => {
  it('describes the runtime: tracking, today, the current activity, the widget', () => {
    const { service, sumTrackedMs } = setup();
    expect(service.getStatus()).toEqual({
      tracking: 'running',
      pausedSince: null,
      pausedUntil: null,
      todayTrackedMs: (3 * 60 + 18) * 60_000,
      currentActivity: { label: 'Code', since: iso(13, 40) },
      focus: null,
      widgetVisible: true,
      reflectionPending: false,
      asOf: NOW.toISOString(),
    });
    // "Today" starts at the user's day boundary, not at midnight.
    expect(sumTrackedMs).toHaveBeenCalledWith(iso(4), NOW.toISOString());
  });

  it('never exposes a window title — only the app, and the site for a browser', () => {
    expect(activityLabel(event())).toBe('Code');
    expect(activityLabel(event({ app: 'chrome.exe', browser: 'Chrome', url: 'github.com' }))).toBe('Chrome · github.com');
    expect(JSON.stringify(setup().service.getStatus())).not.toContain('secret-plan');
  });

  it('does not pretend tracking continued: paused means no current activity', () => {
    const { service, state } = setup();
    state.tracking = { state: 'paused', pausedSince: iso(13, 30), pausedUntil: iso(14, 30) };
    expect(service.getStatus()).toMatchObject({
      tracking: 'paused',
      pausedSince: iso(13, 30),
      pausedUntil: iso(14, 30),
      currentActivity: null,
    });
  });

  it('shows no current activity when nothing was observed lately', () => {
    const { service, state } = setup();
    state.latest = event({ endedAt: iso(13, 50) }); // ten minutes ago
    expect(service.getStatus().currentActivity).toBeNull();
    state.latest = null;
    expect(service.getStatus().currentActivity).toBeNull();
  });

  it('reads Focus from FocusService and keeps no Focus state of its own', () => {
    const { service, state } = setup();
    state.focus = activeFocus;
    expect(service.getStatus().focus).toEqual({
      sessionId: 'fs-1',
      task: 'Build landing page',
      profileName: 'Deep Work',
      isRunning: true,
      pauseKind: null,
      remainingMs: 2_304_000,
      elapsedMs: 696_000,
      blocking: 'active',
    });
    state.focus = null;
    expect(service.getStatus().focus).toBeNull();
    expect(toBackgroundFocus(null)).toBeNull();
  });

  it('tells listeners only when something a surface shows has changed', () => {
    const { service, state } = setup();
    const listener = vi.fn();
    service.onChanged(listener);

    service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);

    state.now = new Date(NOW.getTime() + 20_000); // only the clock moved
    service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);

    state.trackedMs += 60_000;
    service.refresh();
    expect(listener).toHaveBeenCalledTimes(2);

    state.widgetVisible = false;
    service.refresh();
    expect(listener.mock.calls.at(-1)![0].widgetVisible).toBe(false);
  });

  it('has exactly one slow timer, and none after stop()', () => {
    const { service, timers } = setup();
    service.start();
    service.start();
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0].ms).toBe(60_000);
    service.stop();
    expect(timers.pending).toHaveLength(0);
  });

  it('a failing source degrades to "nothing known" instead of throwing', () => {
    const { service, sumTrackedMs, logger } = setup();
    sumTrackedMs.mockImplementation(() => {
      throw new Error('database is closed');
    });
    expect(service.getStatus()).toMatchObject({ tracking: 'running', todayTrackedMs: 0 });
    expect(logger.error).toHaveBeenCalled();
  });

  it('a failing listener does not stop the others', () => {
    const { service } = setup();
    const widget = vi.fn();
    service.onChanged(() => {
      throw new Error('tray destroyed');
    });
    service.onChanged(widget);
    expect(() => service.refresh()).not.toThrow();
    expect(widget).toHaveBeenCalled();
  });

  it('tracks an unread reflection until the user opens it', () => {
    const { service } = setup();
    const listener = vi.fn();
    service.onChanged(listener);

    service.markReflectionPending(iso(0));
    expect(service.getStatus().reflectionPending).toBe(true);
    expect(service.reflectionAnchor).toBe(iso(0));

    service.clearReflectionPending();
    expect(service.getStatus().reflectionPending).toBe(false);
    expect(service.reflectionAnchor).toBeNull();
    expect(listener.mock.calls.map(([s]) => s.reflectionPending)).toEqual([true, false]);
  });
});

describe('status wording', () => {
  it('formats tracked time and the Focus clock', () => {
    expect(formatTrackedDuration(0)).toBe('0m');
    expect(formatTrackedDuration(42 * 60_000 + 59_000)).toBe('42m');
    expect(formatTrackedDuration((3 * 60 + 18) * 60_000)).toBe('3h 18m');
    expect(formatFocusClock(38 * 60_000 + 24_000)).toBe('38:24');
    expect(formatFocusClock(3_725_000)).toBe('1:02:05');
    expect(formatFocusClock(-5)).toBe('0:00');
  });

  it('says plainly whether tracking is on, paused, and until when', () => {
    expect(trackingLabel({ tracking: 'running', pausedUntil: null }, NOW)).toBe('Tracking');
    expect(trackingLabel({ tracking: 'paused', pausedUntil: null }, NOW)).toBe('Tracking paused');
    const today = trackingLabel({ tracking: 'paused', pausedUntil: iso(15, 30) }, NOW);
    expect(today).toMatch(/^Tracking paused until .*3:30|15:30/);
    // A pause that ends on another day names the day.
    const tomorrow = new Date(2026, 9, 6, 0, 0).toISOString();
    expect(formatPauseEnd(tomorrow, NOW).length).toBeGreaterThan(formatPauseEnd(iso(15, 30), NOW).length);
  });
});
