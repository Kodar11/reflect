import { describe, it, expect } from 'vitest';
import {
  normalizeApp,
  normalizeTitle,
  normalizeUrl,
  preprocessEvents,
  redactSecrets,
} from '../../src/intelligence/IntelligencePreprocessor';
import { makeEvent, t } from './helpers';

const WS = t('09:00');
const WE = t('10:00');

describe('IntelligencePreprocessor', () => {
  it('sorts chronologically regardless of input order and keeps event ids', () => {
    const events = [
      makeEvent(3, t('09:30'), t('09:40'), { app: 'Chrome', title: 'React docs', url: 'react.dev' }),
      makeEvent(1, t('09:00'), t('09:20'), { app: 'VS Code', title: 'EventsTab.tsx - reflect' }),
      makeEvent(2, t('09:20'), t('09:30'), { app: 'WindowsTerminal.exe', title: 'npm test' }),
    ];
    const { items, droppedEventIds } = preprocessEvents(events, WS, WE);

    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.sourceEventIds)).toEqual([[1], [2], [3]]);
    expect(droppedEventIds).toEqual([]);
  });

  it('removes empty and flicker events but reports them as dropped', () => {
    const events = [
      makeEvent(1, t('09:00'), t('09:20'), { app: 'VS Code', title: 'main.ts' }),
      makeEvent(2, t('09:20'), t('09:21')), // no app/title/url at all
      makeEvent(3, t('09:21'), '2026-03-02T09:21:00.400Z', { app: 'Explorer' }), // 400ms flicker
      makeEvent(4, t('09:22'), t('09:30'), { app: 'Chrome', url: 'github.com' }),
    ];
    const { items, droppedEventIds } = preprocessEvents(events, WS, WE);

    expect(items.map((i) => i.id)).toEqual([1, 4]);
    expect(droppedEventIds).toEqual([2, 3]);
  });

  it('preserves meaningful evidence: app, browser, domain, title, project/file names', () => {
    const { items } = preprocessEvents(
      [
        makeEvent(7, t('09:00'), t('09:10'), {
          app: 'Code.exe',
          title: '● IntelligenceService.ts - reflect - Visual Studio Code',
        }),
        makeEvent(8, t('09:10'), t('09:20'), {
          app: 'Google Chrome',
          browser: 'Chrome',
          title: '(3) Structured output | Gemini API - Google Chrome',
          url: 'WWW.AI.Google.dev',
        }),
      ],
      WS,
      WE,
    );

    expect(items[0]).toMatchObject({ id: 7, app: 'VS Code', title: 'IntelligenceService.ts - reflect' });
    expect(items[1]).toMatchObject({
      id: 8,
      app: 'Chrome',
      browser: 'Chrome',
      title: 'Structured output | Gemini API',
      url: 'ai.google.dev',
    });
  });

  it('never forwards payload', () => {
    const { items } = preprocessEvents(
      [makeEvent(1, t('09:00'), t('09:10'), { app: 'VS Code', payload: '{"bundleId":4242,"id":99}' })],
      WS,
      WE,
    );
    expect(items[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(items)).not.toContain('4242');
  });

  it('compresses consecutive identical evidence and keeps every raw id traceable', () => {
    const same = { app: 'VS Code', title: 'main.ts - reflect' };
    const { items } = preprocessEvents(
      [
        makeEvent(1, t('09:00'), t('09:10'), same),
        makeEvent(2, t('09:10'), t('09:20'), same),
        makeEvent(3, t('09:20'), t('09:25'), { app: 'Chrome', url: 'youtube.com', title: 'Lofi' }),
        makeEvent(4, t('09:25'), t('09:40'), same), // not adjacent to 1/2 → separate evidence
      ],
      WS,
      WE,
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: 1, sourceEventIds: [1, 2], startedAt: t('09:00'), endedAt: t('09:20') });
    expect(items[2]).toMatchObject({ id: 4, sourceEventIds: [4] });
  });

  it('does not merge identical evidence across a long gap', () => {
    const same = { app: 'VS Code', title: 'main.ts' };
    const { items } = preprocessEvents(
      [makeEvent(1, t('09:00'), t('09:10'), same), makeEvent(2, t('09:30'), t('09:40'), same)],
      WS,
      WE,
    );
    expect(items.map((i) => i.sourceEventIds)).toEqual([[1], [2]]);
  });

  it('clips events that cross the window boundary without changing the raw event', () => {
    const crossing = makeEvent(5, t('08:50'), t('09:15'), { app: 'VS Code', title: 'main.ts' });
    const leaving = makeEvent(6, t('09:50'), t('10:20'), { app: 'Chrome', url: 'react.dev' });
    const outside = makeEvent(9, t('10:30'), t('10:40'), { app: 'Chrome' });
    const { items } = preprocessEvents([crossing, leaving, outside], WS, WE);

    expect(items.map((i) => i.id)).toEqual([5, 6]);
    expect(items[0]).toMatchObject({ startedAt: WS, endedAt: t('09:15') });
    expect(items[1]).toMatchObject({ startedAt: t('09:50'), endedAt: WE });
    expect(crossing.startedAt).toBe(t('08:50'));
    expect(leaving.endedAt).toBe(t('10:20'));
  });

  it('redacts secrets and query strings but keeps the readable part', () => {
    expect(normalizeUrl('https://github.com/acme/reflect/pull/12?token=abc123#files')).toBe(
      'github.com/acme/reflect/pull/12',
    );
    expect(normalizeUrl('https://user:hunter2@example.com/a')).toBe('example.com/a');
    expect(normalizeTitle('Reset password?token=eyJabc.def.ghi api_key=SECRETVALUE done')).toBe(
      'Reset password?token=[REDACTED] api_key=[REDACTED] done',
    );
    expect(redactSecrets('key sk-abcdefghijklmnopqrstuvwx ok')).toBe('key [REDACTED] ok');
    expect(redactSecrets('see https://a.dev/p?session=123 now')).toBe('see https://a.dev/p now');
    expect(normalizeTitle('Game Theory lecture 4 — Nash equilibrium')).toBe('Game Theory lecture 4 — Nash equilibrium');
  });

  it('normalizes duplicate application names', () => {
    expect(normalizeApp('Code.exe')).toBe('VS Code');
    expect(normalizeApp('Visual Studio Code')).toBe('VS Code');
    expect(normalizeApp('  chrome.exe ')).toBe('Chrome');
    expect(normalizeApp('Figma')).toBe('Figma');
    expect(normalizeApp('   ')).toBeNull();
  });
});
