import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightCard } from '../../src/ui/Reflection/InsightCard';
import { ReflectionContent, type ReflectionContentProps } from '../../src/ui/Reflection/ReflectionContent';
import { insight, makeView, report, week42 } from './reflectionFixtures';

/**
 * The Reflection page body, rendered for real (server-side, no DOM needed).
 * Interaction is covered by walking the rendered element tree and invoking
 * the handlers the user would trigger.
 */

function props(overrides: Partial<ReflectionContentProps> = {}): ReflectionContentProps {
  return {
    view: makeView(),
    loading: false,
    error: null,
    busy: false,
    notice: null,
    onRefresh: vi.fn(),
    onRetryLoad: vi.fn(),
    onFeedback: vi.fn(),
    onViewTimeline: vi.fn(),
    onSetPriorityStatus: vi.fn(),
    ...overrides,
  };
}

const html = (overrides: Partial<ReflectionContentProps> = {}) => renderToStaticMarkup(<ReflectionContent {...props(overrides)} />);

/** Text content with tags removed — what the user reads. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

/** Depth-first search of a rendered React element tree. */
function findAll(node: unknown, match: (el: ReactElement) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return found;
  let el = node as ReactElement;
  // Expand function components so their output is searchable too.
  while (typeof el.type === 'function') {
    el = (el.type as (p: unknown) => ReactElement)(el.props);
    if (!el || typeof el !== 'object') return found;
  }
  if (match(el)) found.push(el);
  findAll((el.props as { children?: unknown }).children, match, found);
  return found;
}

const buttonLabel = (el: ReactElement) => text(renderToStaticMarkup(el));

describe('Reflection page — a persisted reflection', () => {
  const markup = html();
  const read = text(markup);

  it('leads with the headline, then the insights, then one carry-forward', () => {
    const headline = read.indexOf('Project X received consistent attention this week');
    const firstInsight = read.indexOf('Project X moved forward every working day');
    const secondInsight = read.indexOf('Most of your time went toward your stated priority');
    const carry = read.indexOf('Carry forward');
    const numbers = read.indexOf('Supporting numbers');
    expect(headline).toBeGreaterThanOrEqual(0);
    expect([headline, firstInsight, secondInsight, carry, numbers]).toEqual(
      [headline, firstInsight, secondInsight, carry, numbers].sort((a, b) => a - b),
    );
    expect(read).toContain('Protect a dedicated Project X block before switching projects.');
  });

  it('renders each insight as observation + interpretation + relevance under its section label', () => {
    expect(read).toContain('Progress');
    expect(read).toContain('Priority alignment');
    expect(read).toContain('You spent 14h 20m on Project X across 5 days. It was your most sustained thread of the week.');
    expect(read).toContain('Launching Project X is the priority you told Reflect about.');
    expect(markup).toContain('data-insight-type="priority_alignment"');
  });

  it('makes clear which reflection this is and when it was written', () => {
    expect(read).toContain('Written Mon, Oct 19, 12:05 AM');
  });

  it('shows every piece of evidence, each with a way into the timeline', () => {
    expect(read).toContain('Evidence · 2');
    expect(read).toContain('Time on “Project X” — 14h 20m');
    expect(read).toContain('Implement Project X sync engine — 1h 20m · Mon, Oct 12, 9:00 AM');
    expect((markup.match(/View in timeline/g) ?? []).length).toBe(4); // 2 + 1 + carry-forward
    expect(read).toContain('View this period in the timeline');
  });

  it('keeps numbers small and secondary — no score, no ranking', () => {
    expect(read).toContain('Tracked 22h 40m');
    expect(read).toContain('Focused 18h 55m');
    expect(read.toLowerCase()).not.toMatch(/score|confidence|\/100|rank/);
    expect(read).toContain('Not enough history yet for a personal baseline.');
  });

  it('offers subtle feedback controls and reflects the saved choice', () => {
    expect((markup.match(/Was this insight useful\?/g) ?? []).length).toBe(2);
    for (const label of ['Useful', 'Not useful', 'Not accurate']) expect(read).toContain(label);
    expect((markup.match(/aria-pressed="true"/g) ?? []).length).toBe(1); // the insight marked "useful"
    expect(markup).not.toMatch(/<dialog|role="dialog"/); // never a modal
  });

  it('does not offer a refresh for a finished, up-to-date period', () => {
    expect(read).not.toContain('Refresh reflection');
  });
});

describe('Reflection page — interactions', () => {
  it('evidence links navigate to the supporting activity on the timeline', () => {
    const onViewTimeline = vi.fn();
    const element = <InsightCard insight={insight()} period={week42} onFeedback={vi.fn()} onViewTimeline={onViewTimeline} />;
    const links = findAll(element, (el) => el.type === 'button' && buttonLabel(el).includes('View in timeline'));
    expect(links).toHaveLength(2);

    (links[1].props as { onClick: () => void }).onClick();
    expect(onViewTimeline).toHaveBeenCalledWith({
      day: new Date(2026, 9, 12, 9).toISOString(),
      view: 'day',
      activityId: 'ai-12-0',
    });
    // A period-wide metric opens the reflection's own period.
    (links[0].props as { onClick: () => void }).onClick();
    expect(onViewTimeline).toHaveBeenLastCalledWith({ day: week42.start, view: 'week', activityId: null });
  });

  it('feedback buttons report the choice, and toggle it off', () => {
    const onFeedback = vi.fn();
    const buttons = (current: ReflectionFeedbackDto | null) =>
      findAll(
        <InsightCard insight={insight({ feedback: current })} period={week42} onFeedback={onFeedback} onViewTimeline={vi.fn()} />,
        (el) => el.type === 'button' && 'aria-pressed' in (el.props as object),
      );

    const fresh = buttons(null);
    expect(fresh.map(buttonLabel)).toEqual(['Useful', 'Not useful', 'Not accurate']);
    (fresh[2].props as { onClick: () => void }).onClick();
    expect(onFeedback).toHaveBeenLastCalledWith('i1', 'inaccurate');

    (buttons('useful')[0].props as { onClick: () => void }).onClick();
    expect(onFeedback).toHaveBeenLastCalledWith('i1', null);
  });

  it('the refresh button calls back, and is disabled while writing or when blocked', () => {
    const onRefresh = vi.fn();
    const stale = makeView({ report: report({ status: 'stale', staleReason: 'activity_changed' }), canRefresh: true, refreshBlockedReason: null });
    const refreshOf = (p: ReflectionContentProps) =>
      findAll(<ReflectionContent {...p} />, (el) => el.type === 'button' && /Refresh reflection|Writing/.test(buttonLabel(el)));

    const [button] = refreshOf(props({ view: stale, onRefresh }));
    expect((button.props as { disabled: boolean }).disabled).toBe(false);
    (button.props as { onClick: () => void }).onClick();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const [writing] = refreshOf(props({ view: stale, busy: true }));
    expect(buttonLabel(writing)).toContain('Writing…');
    expect((writing.props as { disabled: boolean }).disabled).toBe(true);
  });

  it('lets the user mark a priority completed', () => {
    const onSetPriorityStatus = vi.fn();
    const [select] = findAll(<ReflectionContent {...props({ onSetPriorityStatus })} />, (el) => el.type === 'select');
    (select.props as { onChange: (e: unknown) => void }).onChange({ target: { value: 'completed' } });
    expect(onSetPriorityStatus).toHaveBeenCalledWith('pr-1', 'completed');
  });
});

describe('Reflection page — states', () => {
  it('loading', () => {
    expect(text(html({ view: null, loading: true }))).toBe('Loading reflection…');
  });

  it('error, with a way to retry', () => {
    const onRetryLoad = vi.fn();
    const p = props({ view: null, error: 'IPC failed', onRetryLoad });
    expect(text(renderToStaticMarkup(<ReflectionContent {...p} />))).toBe('Could not load this reflection: IPC failed Try again');
    const [retry] = findAll(<ReflectionContent {...p} />, (el) => el.type === 'button');
    (retry.props as { onClick: () => void }).onClick();
    expect(onRetryLoad).toHaveBeenCalled();
  });

  it('today, still running: deterministic numbers so far and when the reflection is written', () => {
    const today = makeView({
      period: { type: 'day', key: '2026-10-19', title: 'Today', range: 'Mon, Oct 19', isCurrent: true, isClosed: false, hasNext: false },
      report: null,
      live: {
        asOf: new Date(2026, 9, 19, 16).toISOString(),
        metrics: [
          { key: 'time.tracked_minutes', label: 'Total tracked time', display: '2h 43m' },
          { key: 'time.focused_minutes', label: 'Focused time (Deep Work + Focused)', display: '1h 52m' },
          { key: 'priority.pr-1.minutes', label: 'Time linked to the priority “Launching Project X”', display: '1h 21m' },
          { key: 'block.longest_minutes', label: 'Longest uninterrupted block', display: '58m' },
        ],
      },
      canRefresh: true,
      refreshBlockedReason: null,
    });
    const read = text(html({ view: today }));
    expect(read).toContain('Today so far');
    expect(read).toContain('Tracked 2h 43m Focused 1h 52m Current priority 1h 21m Longest block 58m');
    expect(read).toContain('Today’s reflection has not been written yet.');
    expect(read).toContain('Reflect writes it around 10:00 PM');
    expect(read).toContain('Reflect now');
  });

  it('insufficient data: says so plainly and offers nothing to generate', () => {
    const thin = makeView({
      period: { type: 'day', title: 'Today', isCurrent: true, isClosed: false },
      report: null,
      sufficiency: { enough: false, message: 'Not enough activity yet to generate a meaningful reflection.' },
      canRefresh: false,
      refreshBlockedReason: 'insufficient_data',
    });
    const read = text(html({ view: thin }));
    expect(read).toContain('Not enough activity yet to generate a meaningful reflection.');
    expect(read).not.toMatch(/Reflect now|Generate reflection/);
  });

  it('a past period with no reflection: measured numbers and an offer to generate', () => {
    const past = makeView({
      report: null,
      live: { asOf: week42.end, metrics: [{ key: 'time.tracked_minutes', label: 'Total tracked time', display: '22h 40m' }] },
      canRefresh: true,
      refreshBlockedReason: null,
    });
    const read = text(html({ view: past }));
    expect(read).toContain('No reflection was written for this period.');
    expect(read).toContain('What Reflect measured');
    expect(read).toContain('Tracked 22h 40m');
    expect(read).toContain('Generate reflection');
    expect(read).not.toContain('so far');
  });

  it('generating: says a reflection is being written', () => {
    const view = makeView({ report: null, generation: { state: 'generating', errorCategory: null, message: null, at: null } });
    expect(text(html({ view }))).toContain('Writing this reflection…');
  });

  it('a failed first attempt explains what happened and offers a retry', () => {
    const view = makeView({
      report: null,
      generation: { state: 'failed', errorCategory: 'network', message: 'Reflect could not reach Gemini. Nothing was changed.', at: null },
      canRefresh: true,
      refreshBlockedReason: null,
    });
    const read = text(html({ view }));
    expect(read).toContain('This reflection could not be written.');
    expect(read).toContain('Reflect could not reach Gemini. Nothing was changed.');
    expect(read).toContain('Generate reflection');
  });

  it('a failed refresh keeps showing the previous reflection', () => {
    const view = makeView({
      generation: { state: 'failed', errorCategory: 'validation', message: 'It was discarded.', at: null },
      canRefresh: true,
      refreshBlockedReason: null,
    });
    const read = text(html({ view }));
    expect(read).toContain('The last refresh did not complete. It was discarded. The reflection below is the previous one.');
    expect(read).toContain('Project X received consistent attention this week');
  });

  it('a stale reflection is shown as written, labelled, and refreshable', () => {
    const view = makeView({ report: report({ status: 'stale', staleReason: 'activity_changed' }), canRefresh: true, refreshBlockedReason: null });
    const read = text(html({ view }));
    expect(read).toContain('The activity in this period changed after this reflection was written.');
    expect(read).toContain('Project X received consistent attention this week');
    expect(read).toContain('Refresh reflection');
  });

  it('without Gemini: no broken page, just the measured numbers', () => {
    const view = makeView({
      report: null,
      configured: false,
      live: { asOf: week42.end, metrics: [{ key: 'time.tracked_minutes', label: 'Total tracked time', display: '22h 40m' }] },
      canRefresh: false,
      refreshBlockedReason: 'not_configured',
    });
    const read = text(html({ view }));
    expect(read).toContain('Gemini is not configured, so only the measured numbers are available for this period.');
    expect(read).toContain('Tracked 22h 40m');
  });

  it('"nothing unusual": a headline and no invented insights', () => {
    const view = makeView({ report: report({ headline: 'Nothing unusual stood out this week.', insights: [], carryForward: null }) });
    const markup = html({ view });
    expect(text(markup)).toContain('Nothing unusual stood out this week.');
    expect(markup).not.toContain('data-insight-type');
    expect(text(markup)).not.toContain('Carry forward');
  });

  it('flags a priority that may no longer be current', () => {
    const view = makeView({
      priorities: [{ ...makeView().priorities[0], possiblyStale: true }],
    });
    expect(text(html({ view }))).toContain('not reconfirmed in a while — still current?');
  });

  it('shows a notice after a refresh that changed nothing', () => {
    expect(text(html({ notice: 'This reflection is already up to date.' }))).toContain('This reflection is already up to date.');
  });
});
