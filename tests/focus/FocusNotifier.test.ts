import { describe, it, expect } from 'vitest';
import { DEFAULT_FOCUS_PREFERENCES, type FocusPreferences } from '../../src/focus/FocusModels.js';
import { FocusNotifier, displayTarget, type FocusNotification } from '../../src/focus/FocusNotifier.js';
import { makeProfile, makeSession } from './helpers.js';

function notifier(prefs: Partial<FocusPreferences> = {}) {
  const shown: FocusNotification[] = [];
  const current = { ...DEFAULT_FOCUS_PREFERENCES, ...prefs };
  return { shown, n: new FocusNotifier(() => current, (x) => shown.push(x)), prefs: current };
}

const session = makeSession({ task: 'Finish authentication', plannedDurationMinutes: 60 });
const profile = makeProfile();

describe('FocusNotifier', () => {
  it('announces a fulfilled countdown, and nothing for an early or abandoned end', () => {
    const { n, shown } = notifier();
    n.onSummary({ ...session, state: 'completed', endReason: 'completed' }, profile);
    n.onSummary({ ...session, state: 'cancelled', endReason: 'ended-early' }, profile);
    n.onSummary({ ...session, state: 'cancelled', endReason: 'abandoned' }, profile);
    n.onSummary({ ...session, state: 'completed', endReason: 'finished' }, profile);
    expect(shown).toEqual([{ title: 'Focus complete', body: 'Finish authentication' }]);
  });

  it('respects every preference', () => {
    const off = notifier({ notifyStart: false, notifyIdle: false, notifyComplete: false, notifyBlocked: false });
    off.n.onNotice({ kind: 'started', session, profile });
    off.n.onNotice({ kind: 'idle-paused', session });
    off.n.onNotice({ kind: 'idle-resumed', session });
    off.n.onNotice({ kind: 'blocked', session, type: 'app', target: 'discord.exe' });
    off.n.onSummary({ ...session, endReason: 'completed' }, profile);
    expect(off.shown).toEqual([]);

    const on = notifier({ notifyStart: true });
    on.n.onNotice({ kind: 'started', session, profile });
    on.n.onNotice({ kind: 'idle-paused', session });
    on.n.onNotice({ kind: 'idle-resumed', session });
    expect(on.shown.map((x) => x.title)).toEqual(['Focus started', 'Focus paused', 'Focus resumed']);
    expect(on.shown[0].body).toBe('Finish authentication · 60 min');
  });

  it('mentions a blocked target once per session, not on every attempt', () => {
    const { n, shown } = notifier();
    for (let i = 0; i < 5; i += 1) n.onNotice({ kind: 'blocked', session, type: 'app', target: 'discord.exe' });
    n.onNotice({ kind: 'blocked', session, type: 'website', target: 'www.youtube.com' });
    expect(shown.map((x) => x.title)).toEqual(['Discord is blocked during Focus', 'youtube.com is blocked during Focus']);

    // A new session may mention it again.
    n.onNotice({ kind: 'blocked', session: { ...session, id: 'session-2' }, type: 'app', target: 'discord.exe' });
    expect(shown).toHaveLength(3);
  });

  it('always reports that blocking stopped, even with notifications off', () => {
    const { n, shown } = notifier({ notifyStart: false, notifyIdle: false, notifyComplete: false, notifyBlocked: false });
    n.onNotice({ kind: 'blocking-lost', session, message: 'The blocker stopped responding.' });
    expect(shown).toEqual([{ title: 'Focus blocking stopped', body: 'The blocker stopped responding.' }]);
  });

  it('never offers a way around blocking or comments on the user', () => {
    const { n, shown } = notifier({ notifyStart: true });
    n.onNotice({ kind: 'started', session, profile });
    n.onNotice({ kind: 'idle-paused', session });
    n.onNotice({ kind: 'blocked', session, type: 'website', target: 'youtube.com' });
    n.onNotice({ kind: 'blocking-lost', session, message: 'x' });
    n.onSummary({ ...session, endReason: 'completed' }, profile);
    const text = shown.map((x) => `${x.title} ${x.body}`).join(' ').toLowerCase();
    for (const word of ['open anyway', 'disable', 'skip', 'unblock', 'great job', 'gave up', 'productive', 'well done']) {
      expect(text).not.toContain(word);
    }
  });

  it('formats targets for display', () => {
    expect(displayTarget('discord.exe')).toBe('Discord');
    expect(displayTarget('www.youtube.com')).toBe('youtube.com');
  });
});
