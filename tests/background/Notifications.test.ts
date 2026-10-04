import { describe, it, expect, vi } from 'vitest';
import { Notifier, type NotificationHandle } from '../../src/background/Notifier';
import { ReflectionNotifier, chooseReflectionNotice } from '../../src/background/ReflectionNotifier';
import type { GenerateResult, ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';

// ── Notifier ─────────────────────────────────────────────────────────────────

function fakeNotifications() {
  const shown: { title: string; body: string; silent: boolean; click(): void; fail(error: string): void }[] = [];
  const create = vi.fn((options: { title: string; body: string; silent: boolean }): NotificationHandle => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
      show: () => {
        shown.push({
          ...options,
          click: () => listeners.click?.forEach((l) => l()),
          fail: (error) => listeners.failed?.forEach((l) => l({}, error)),
        });
      },
      on: (event, listener) => {
        (listeners[event] ??= []).push(listener);
      },
    };
  });
  return { shown, create };
}

function makeNotifier(overrides: { enabled?: boolean; supported?: boolean } = {}) {
  const fake = fakeNotifications();
  const state = { enabled: overrides.enabled ?? true, supported: overrides.supported ?? true };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const notifier = new Notifier({ isEnabled: () => state.enabled, isSupported: () => state.supported, create: fake.create, logger });
  return { notifier, state, logger, ...fake };
}

describe('Notifier', () => {
  it('shows a calm, silent notification and runs the click handler', () => {
    const t = makeNotifier();
    const onClick = vi.fn();
    expect(t.notifier.show({ title: 'Your reflection is ready', body: 'A few things stood out about yesterday.', onClick })).toBe(true);
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]).toMatchObject({ title: 'Your reflection is ready', silent: true });
    t.shown[0].click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('honours the notification switch — except for a critical notice', () => {
    const t = makeNotifier({ enabled: false });
    expect(t.notifier.show({ title: 'Your reflection is ready', body: '' })).toBe(false);
    expect(t.notifier.show({ title: 'Focus blocking stopped', body: 'The blocker stopped responding.', critical: true })).toBe(true);
    expect(t.shown.map((n) => n.title)).toEqual(['Focus blocking stopped']);

    t.state.enabled = true; // the setting is read each time, not cached
    expect(t.notifier.show({ title: 'Focus complete', body: '' })).toBe(true);
  });

  it('does nothing where notifications are not supported', () => {
    const t = makeNotifier({ supported: false });
    expect(t.notifier.show({ title: 'x', body: 'y', critical: true })).toBe(false);
    expect(t.create).not.toHaveBeenCalled();
  });

  it('a notification that cannot be shown is logged — it never throws into the caller', () => {
    const t = makeNotifier();
    t.create.mockImplementation(() => {
      throw new Error('toast activation failed');
    });
    expect(() => t.notifier.show({ title: 'x', body: 'y' })).not.toThrow();
    expect(t.notifier.show({ title: 'x', body: 'y' })).toBe(false);
    expect(t.logger.error).toHaveBeenCalled();
  });

  it('a throwing click handler or a failed toast is contained', () => {
    const t = makeNotifier();
    t.notifier.show({
      title: 'x',
      body: 'y',
      onClick: () => {
        throw new Error('window gone');
      },
    });
    expect(() => t.shown[0].click()).not.toThrow();
    t.notifier.show({ title: 'z', body: '' });
    expect(() => t.shown[1].fail('0x80070490')).not.toThrow();
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('0x80070490'));
  });
});

// ── Reflection ready ─────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 6, 9, 0); // Tuesday morning
const today = periodContaining('day', NOW);
const yesterday = shiftPeriod(today, -1);
const daysAgo = (n: number) => shiftPeriod(today, -n);
const week = periodContaining('week', new Date(2026, 8, 30));

const succeeded = (period: ReflectionPeriod): GenerateResult => ({ status: 'succeeded', reportId: `r-${period.key}`, period, attempts: 1, insightCount: 3 });
const skipped = (period: ReflectionPeriod): GenerateResult => ({ status: 'skipped', reason: 'insufficient_data', period });
const failed = (period: ReflectionPeriod): GenerateResult => ({ status: 'failed', category: 'network', error: 'offline', reportId: null, period, attempts: 3 });

describe('chooseReflectionNotice', () => {
  it('announces tonight’s reflection', () => {
    const notice = chooseReflectionNotice([succeeded(today)], new Date(2026, 9, 6, 22, 1))!;
    expect(notice).toMatchObject({ key: `reflection-ready:${today.key}`, title: 'Your reflection is ready' });
    expect(notice.body).toBe('A short briefing on today, and what might be worth doing next.');
  });

  it('a reflection recovered the next morning talks about yesterday', () => {
    expect(chooseReflectionNotice([succeeded(yesterday)], NOW)!.body).toBe('A few things stood out about yesterday.');
  });

  it('a backlog of several days is one notification — for the most recent day', () => {
    const notice = chooseReflectionNotice([succeeded(daysAgo(3)), succeeded(daysAgo(2)), skipped(yesterday), succeeded(week)], NOW)!;
    expect(notice.period.key).toBe(daysAgo(2).key);
    expect(notice.body).toMatch(/^A few things stood out about \w+\.$/);
  });

  it('mentions an open question from the coach', () => {
    expect(chooseReflectionNotice([succeeded(today)], NOW, 1)!.body).toBe('Reflect also has a question about something you planned.');
  });

  it('says nothing for weekly reports, failures, skips or a very old day', () => {
    expect(chooseReflectionNotice([succeeded(week)], NOW)).toBeNull();
    expect(chooseReflectionNotice([failed(today), skipped(yesterday)], NOW)).toBeNull();
    expect(chooseReflectionNotice([succeeded(daysAgo(9))], NOW)).toBeNull();
    expect(chooseReflectionNotice([], NOW)).toBeNull();
  });
});

function makeReflectionNotifier(overrides: Partial<{ wants: boolean; looking: boolean; notifyThrows: boolean }> = {}) {
  const claimed = new Set<string>(); // the persisted ledger
  const state = { wants: overrides.wants ?? true, looking: overrides.looking ?? false };
  const notify = vi.fn((_request: { title: string; body: string; onClick?: () => void }) => {
    if (overrides.notifyThrows) throw new Error('notification centre unavailable');
    return true;
  });
  const onPending = vi.fn();
  const open = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn() };
  const build = () =>
    new ReflectionNotifier({
      ledger: {
        claim: (key) => {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        },
      },
      wantsNotification: () => state.wants,
      isUserLooking: () => state.looking,
      pendingQuestions: () => 0,
      notify,
      onPending,
      open,
      now: () => NOW,
      logger,
    });
  return { notifier: build(), build, claimed, state, notify, onPending, open, logger };
}

describe('ReflectionNotifier', () => {
  it('notifies once, and the click opens that day’s reflection', () => {
    const t = makeReflectionNotifier();
    t.notifier.onGenerated([succeeded(yesterday)]);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.onPending).toHaveBeenCalledTimes(1);

    t.notify.mock.calls[0][0].onClick!();
    expect(t.open).toHaveBeenCalledWith(expect.objectContaining({ period: yesterday }));
  });

  it('never notifies twice for the same day: scheduler retries and regenerated reports stay silent', () => {
    const t = makeReflectionNotifier();
    t.notifier.onGenerated([succeeded(today)]);
    t.notifier.onGenerated([succeeded(today)]); // retry
    t.notifier.onGenerated([{ ...succeeded(today), reportId: 'r-final' }]); // the finalised report of the same day
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('the claim is persisted: a restart after the report was announced does not announce it again', () => {
    const t = makeReflectionNotifier();
    t.notifier.onGenerated([succeeded(yesterday)]);
    const afterRestart = t.build(); // new process, same ledger
    afterRestart.onGenerated([succeeded(yesterday)]);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('a new day is a new notification', () => {
    const t = makeReflectionNotifier();
    t.notifier.onGenerated([succeeded(yesterday)]);
    t.notifier.onGenerated([succeeded(today)]);
    expect(t.notify).toHaveBeenCalledTimes(2);
  });

  it('with notifications off the reflection is still marked as waiting — quietly', () => {
    const t = makeReflectionNotifier({ wants: false });
    t.notifier.onGenerated([succeeded(today)]);
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.onPending).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the user is already looking at Reflect', () => {
    const t = makeReflectionNotifier({ looking: true });
    t.notifier.onGenerated([succeeded(today)]);
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.onPending).not.toHaveBeenCalled();
    // ...and does not come back later for the same day.
    t.state.looking = false;
    t.notifier.onGenerated([succeeded(today)]);
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('a failing notification is logged and swallowed — the scheduler is not affected', () => {
    const t = makeReflectionNotifier({ notifyThrows: true });
    expect(() => t.notifier.onGenerated([succeeded(today)])).not.toThrow();
    expect(t.logger.error).toHaveBeenCalled();
    // The day stays claimed: no retry storm.
    t.notifier.onGenerated([succeeded(today)]);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });
});
