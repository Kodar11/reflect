import { describe, it, expect } from 'vitest';
import { buildWidgetView, focusClockMs } from '../../src/ui/widget/widgetView';
import { focusStatus, status } from '../background/helpers';

const AS_OF = new Date('2026-10-05T09:00:00.000Z');
const labels = (view: ReturnType<typeof buildWidgetView>) => view.card.buttons.map((b) => b.label);

describe('floating widget view', () => {
  it('normally: a quiet pill with the tracking state and today’s time', () => {
    const view = buildWidgetView(status(), AS_OF);
    expect(view.tone).toBe('running');
    expect(view.pill).toEqual({ label: 'Tracking', value: '3h 18m' });
    expect(view.card.title).toBe('Tracking');
    expect(view.card.rows).toEqual([
      { label: 'Today', value: '3h 18m' },
      { label: 'Current', value: 'Code' },
    ]);
    expect(labels(view)).toEqual(['Open Reflect', 'Focus', 'Pause', 'Hide']);
    expect(view.ticking).toBe(false); // nothing repaints per second
  });

  it('shows a dash when there is no current activity', () => {
    expect(buildWidgetView(status({ currentActivity: null }), AS_OF).card.rows[1]).toEqual({ label: 'Current', value: '—' });
  });

  it('says clearly that tracking is paused, until when, and offers Resume', () => {
    const until = new Date(AS_OF.getTime() + 30 * 60_000).toISOString();
    const view = buildWidgetView(status({ tracking: 'paused', pausedUntil: until, currentActivity: null }), AS_OF);
    expect(view.tone).toBe('paused');
    expect(view.pill).toEqual({ label: 'Tracking paused', value: '' });
    expect(view.card.title).toBe('Tracking paused');
    expect(view.card.rows[1].label).toBe('Resumes');
    expect(view.card.buttons.find((b) => b.label === 'Resume')?.action).toEqual({ type: 'resume-tracking' });
    expect(labels(view)).not.toContain('Pause');

    const manual = buildWidgetView(status({ tracking: 'paused', currentActivity: null }), AS_OF);
    expect(manual.card.rows[1]).toEqual({ label: 'Resumes', value: 'When you resume it' });
  });

  it('offers the four pause lengths before pausing', () => {
    const view = buildWidgetView(status(), AS_OF, true);
    expect(view.card.title).toBe('Pause tracking for…');
    expect(view.card.grid).toBe(true);
    expect(view.card.buttons.map((b) => b.action)).toEqual([
      { type: 'pause-tracking', duration: '15m' },
      { type: 'pause-tracking', duration: '1h' },
      { type: 'pause-tracking', duration: 'tomorrow' },
      { type: 'pause-tracking', duration: 'manual' },
      'cancel-pause',
    ]);
    // Already paused: there is nothing to choose.
    expect(buildWidgetView(status({ tracking: 'paused' }), AS_OF, true).card.title).toBe('Tracking paused');
  });

  it('during Focus, Focus comes first: clock, task, profile', () => {
    const view = buildWidgetView(status({ focus: focusStatus() }), AS_OF);
    expect(view.tone).toBe('focus');
    expect(view.pill).toEqual({ label: 'Focus', value: '38:24' });
    expect(view.card.title).toBe('Focus');
    expect(view.card.clock).toBe('38:24 left');
    expect(view.card.lines.map((l) => l.text)).toEqual(['Build landing page', 'Deep Work · Tracking on']);
    expect(view.ticking).toBe(true);
    // The widget opens Focus; pausing or ending it stays on the Focus page.
    expect(labels(view)).toEqual(['Open Focus', 'Pause', 'Hide']);
    expect(view.card.buttons[0].action).toEqual({ type: 'open-focus' });
    expect(view.card.buttons.map((b) => JSON.stringify(b.action)).join()).not.toMatch(/end|stop|confirm/);
  });

  it('a paused Focus session is frozen, not counting', () => {
    const view = buildWidgetView(status({ focus: focusStatus({ isRunning: false, pauseKind: 'idle' }) }), new Date(AS_OF.getTime() + 60_000));
    expect(view.tone).toBe('focus-paused');
    expect(view.pill).toEqual({ label: 'Focus paused', value: '38:24' });
    expect(view.ticking).toBe(false);
  });

  it('counts the Focus clock on from the last status, in the right direction', () => {
    const countdown = status({ focus: focusStatus() });
    const later = new Date(AS_OF.getTime() + 24_000);
    expect(focusClockMs(countdown, later)).toBe(38 * 60_000);
    expect(buildWidgetView(countdown, later).pill.value).toBe('38:00');
    expect(focusClockMs(countdown, new Date(AS_OF.getTime() + 3 * 3_600_000))).toBe(0); // never negative

    const stopwatch = status({ focus: focusStatus({ remainingMs: null }) });
    expect(focusClockMs(stopwatch, later)).toBe(12 * 60_000);
    expect(buildWidgetView(stopwatch, later).card.clock).toBe('12:00');
  });

  it('shows both states when tracking is paused during Focus', () => {
    const view = buildWidgetView(status({ tracking: 'paused', focus: focusStatus() }), AS_OF);
    expect(view.card.lines[1].text).toBe('Deep Work · Tracking paused');
    expect(labels(view)).toEqual(['Open Focus', 'Resume', 'Hide']);
  });

  it('points at a reflection that is waiting', () => {
    const view = buildWidgetView(status({ reflectionPending: true }), AS_OF);
    expect(view.card.lines).toEqual([{ text: 'Your reflection is ready', kind: 'note' }]);
    expect(view.card.buttons[0]).toMatchObject({ label: 'Open reflection', action: { type: 'open-reflection' } });
  });

  it('always offers Hide — and hiding is not pausing', () => {
    for (const s of [status(), status({ tracking: 'paused' }), status({ focus: focusStatus() })]) {
      const hide = buildWidgetView(s, AS_OF).card.buttons.find((b) => b.label === 'Hide');
      expect(hide?.action).toEqual({ type: 'hide' });
    }
  });
});
