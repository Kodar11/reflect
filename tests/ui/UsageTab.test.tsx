import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageDetail, UsageList, UsageView, type UsageViewProps } from '../../src/ui/pages/Activity/UsageTab';
import { COLLAPSED_LIST } from '../../src/ui/pages/Activity/usageView';
import { HOUR, MIN, NOW, WEEK_WINDOW, makeReport, manyApps } from './usageFixtures';

/**
 * The Usage page rendered for real (server-side, no DOM needed). Interaction
 * is covered by invoking the handlers on the rendered element tree, the way a
 * click would.
 */

type AnyElement = ReactElement<Record<string, any>>;

/** Every element of a rendered tree, depth first. */
function elements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (node && typeof node === 'object' && 'props' in (node as AnyElement)) {
    const el = node as AnyElement;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}

const buttons = (tree: ReactElement) => elements(tree).filter((el) => el.type === 'button');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const textOf = (el: AnyElement) => text(renderToStaticMarkup(el));
const count = (html: string, needle: string) => html.split(needle).length - 1;

function props(overrides: Partial<UsageViewProps> = {}): UsageViewProps {
  return {
    request: { type: 'week' },
    report: makeReport(),
    loading: false,
    stale: false,
    error: null,
    lists: { app: COLLAPSED_LIST, website: COLLAPSED_LIST },
    query: '',
    now: NOW,
    onRequest: vi.fn(),
    onRetry: vi.fn(),
    onToggleList: vi.fn(),
    onShowAll: vi.fn(),
    onQuery: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

const render = (overrides: Partial<UsageViewProps> = {}) => renderToStaticMarkup(<UsageView {...props(overrides)} />);

describe('period selector', () => {
  it('offers Today, Week, Month, Year and Custom, and marks the active one', () => {
    const html = render();
    for (const label of ['Today', 'Week', 'Month', 'Year', 'Custom']) expect(html).toContain(`>${label}</button>`);
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Week</);
  });

  it('shows the dates of a custom range, never beyond today', () => {
    const html = render({ request: { type: 'custom', startDate: '2026-10-01', endDate: '2026-10-07' } });
    expect(html).toContain('aria-label="Range start"');
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('value="2026-10-07"');
    expect(count(html, 'max="2026-10-14"')).toBe(2);
    expect(render()).not.toContain('type="date"');
  });

  it('states the range being measured', () => {
    expect(text(render())).toContain('Mon, Oct 12 – Wed, Oct 14, 3:00 PM');
  });
});

describe('summary cards', () => {
  const page = text(render());

  it('total tracked time, with its change', () => {
    expect(page).toContain('Total tracked time 26h');
    expect(page).toContain('No change vs last week');
  });

  it('most used application and website, with time and share', () => {
    expect(page).toContain('Most used application Brave Browser 15h · 58% of tracked time');
    expect(page).toContain('Most used website chatgpt.com 12h · 46% of tracked time');
  });

  it('most opened, labelled for what it counts', () => {
    expect(page).toContain('Most opened Brave Browser Application · brought to the front 110 times');
  });

  it('with no websites: an empty state, not a zero', () => {
    const html = text(render({ report: makeReport({ current: manyApps(3), previous: [] }) }));
    expect(html).toContain('Most used website — No websites tracked');
    expect(html).not.toContain('0% of tracked time');
  });
});

describe('comparison with the previous period', () => {
  it('is always on the page, with both ranges named', () => {
    const page = text(render());
    expect(page).toContain('This week vs last week');
    expect(page).toContain('Mon, Oct 12 – Wed, Oct 14, 3:00 PM compared with Mon, Oct 5 – Wed, Oct 7, 3:00 PM');
    expect(page).toContain('This week is still in progress, so both ranges stop at the same point.');
  });

  it('shows current, previous, difference and percentage for each total', () => {
    const page = text(render());
    expect(page).toContain('On websites 15h +3h · +25% Last week: 12h');
    expect(page).toContain('Outside websites 11h −3h · −21% Last week: 14h');
  });

  it('lists the largest changes, including what is no longer used', () => {
    const page = text(render());
    expect(page).toMatch(/Largest changes .*Netflix −5h · −100%/);
    expect(page).toMatch(/chatgpt\.com \+4h · \+50%/);
    expect(page).toMatch(/Figma \+2h new/);
  });

  it('says so when there is no earlier data, instead of showing increases from zero', () => {
    const page = text(render({ report: makeReport({ previous: [], trackingSince: WEEK_WINDOW.current.start }) }));
    expect(page).toContain('No comparison yet: tracking began');
    expect(page).toContain('Last week: not available');
    expect(page).not.toContain('Largest changes');
    expect(page).not.toMatch(/\+\d+h · new/);
  });

  it('flags a previous range that tracking only partly covers', () => {
    const since = new Date(2026, 9, 6, 9, 0).toISOString();
    expect(text(render({ report: makeReport({ trackingSince: since }) }))).toContain(
      'Tracking began Tue, Oct 6, 9:00 AM, part-way through the earlier range, so its figures cover only part of it.',
    );
  });

  it('never colours a change as good or bad', () => {
    // Direction is an arrow and a sign; the colour comes from the neutral text tokens only.
    expect(render()).not.toMatch(/class="usage-change"[^>]*style=/);
    const css = fs.readFileSync(path.resolve(__dirname, '../../src/ui/index.css'), 'utf8');
    const rules = css.match(/\.usage-(change|new)[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/danger|success|warning|#[0-9a-f]{3,6}/i);
  });
});

describe('top five', () => {
  it('ranks applications and websites separately by time, with share and change', () => {
    const page = text(render());
    expect(page).toMatch(/Top applications .* 1 Brave Browser 15h 58% \+3h · \+25% 2 Visual Studio Code 9h 35% No change 3 Figma 2h 8% \+2h new/);
    expect(page).toMatch(/Top websites .* 1 chatgpt\.com 12h 46% \+4h · \+50% 2 youtube\.com 3h 12% −1h · −25%/);
  });

  it('shows no more than five of many', () => {
    const report = makeReport({ current: manyApps(25) });
    const html = render({ report });
    expect(report.topApps).toHaveLength(5);
    expect(html).toContain('App 05');
    expect(html).not.toContain('App 06');
  });

  it('scales every bar of a list to its first row', () => {
    const html = render();
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:60%"'); // VS Code, 9h of 15h
    expect(html).toContain('style="width:25%"'); // youtube.com, 3h of 12h
  });

  it('explains that the two lists overlap', () => {
    expect(text(render())).toContain("Time on a website is also part of its browser's time");
  });

  it('gives the full name of every row for when it is cut short', () => {
    const long = 'A very long application name that will not fit in the column';
    const html = render({ report: makeReport({ current: [{ app: long, url: null, ms: HOUR, appOpens: 1, urlOpens: 0, lastStartedAt: NOW.toISOString() }] }) });
    expect(html).toContain(`title="${long}"`);
  });
});

describe('full lists', () => {
  const report = makeReport({ current: manyApps(25) });
  const list = (overrides: Partial<UsageViewProps> = {}) => {
    const p = props({ report, ...overrides });
    return { tree: UsageList({ ...p, report, kind: 'app', title: 'All applications', items: report.apps }), p };
  };

  it('are collapsed by default: a header with the count, no rows', () => {
    const html = render({ report });
    expect(html).toContain('All applications');
    expect(html).toContain('All websites');
    expect(count(html, 'aria-expanded="false"')).toBe(2);
    expect(html).not.toContain('App 06');
    expect(html).not.toContain('usage-list-body');
  });

  it('expand to the ten most used, with a way to see the rest', () => {
    const html = render({ report, lists: { app: { open: true, showAll: false }, website: COLLAPSED_LIST } });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('App 10');
    expect(html).not.toContain('App 11');
    expect(text(html)).toContain('Show all 25 applications');
  });

  it('show everything on request, and can go back to ten', () => {
    const html = render({ report, lists: { app: { open: true, showAll: true }, website: COLLAPSED_LIST } });
    expect(html).toContain('App 25');
    expect(text(html)).toContain('Show top 10 only');
    expect(text(html)).not.toContain('Show all 25');
  });

  it('each row keeps time, share, opens and change', () => {
    const html = text(render({ lists: { app: { open: true, showAll: false }, website: COLLAPSED_LIST } }));
    expect(html).toMatch(/All applications 3 Brave Browser 15h 58% 110 opens \+3h · \+25%/);
  });

  it('toggling, showing all and selecting call back with the right list and item', () => {
    const collapsed = list();
    buttons(collapsed.tree)[0].props.onClick();
    expect(collapsed.p.onToggleList).toHaveBeenCalledWith('app');

    const open = list({ lists: { app: { open: true, showAll: false }, website: COLLAPSED_LIST } });
    const all = buttons(open.tree).find((b) => textOf(b).startsWith('Show all'))!;
    all.props.onClick();
    expect(open.p.onShowAll).toHaveBeenCalledWith('app', true);

    const full = list({ lists: { app: { open: true, showAll: true }, website: COLLAPSED_LIST } });
    buttons(full.tree).find((b) => textOf(b).startsWith('Show top'))!.props.onClick();
    expect(full.p.onShowAll).toHaveBeenCalledWith('app', false);
  });

  it('search finds items beyond the first ten, without expanding first', () => {
    const html = render({ report, query: 'app 2' });
    expect(html).toContain('App 25');
    expect(html).not.toContain('App 19');
    expect(text(html)).toContain('6 of 25');
    expect(text(html)).toContain('No websites match “app 2”.');
  });

  it('says how many items are negligible rather than hiding that they exist', () => {
    const current = [...manyApps(3), { app: 'Blip', url: null, ms: 20_000, appOpens: 1, urlOpens: 0, lastStartedAt: NOW.toISOString() }];
    const page = text(render({ report: makeReport({ current }) }));
    expect(page).toContain('All applications 4 1 under 1m');
    expect(page).not.toMatch(/Top applications.*Blip.*All applications/);
  });
});

describe('selecting an item', () => {
  it('a ranking row opens that item', () => {
    const p = props();
    const tree = UsageView(p);
    // The page is composed of components; render the ranking row markup and click through the element tree of one list.
    const report = p.report!;
    const listTree = UsageList({ ...p, report, lists: { app: { open: true, showAll: false }, website: COLLAPSED_LIST }, kind: 'app', title: 'All applications', items: report.apps });
    expect(tree).toBeTruthy();
    const rowEl = elements(listTree).find((el) => el.props.item?.name === 'Figma')!;
    rowEl.props.onSelect(rowEl.props.item);
    expect(p.onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'app', name: 'Figma' }));
  });

  it('the detail states the item\'s figures for both ranges and its window titles', () => {
    const report = makeReport();
    const item = report.websites[0];
    const html = text(
      renderToStaticMarkup(
        <UsageDetail
          item={item}
          report={report}
          now={NOW}
          onClose={() => {}}
          state={{
            status: 'ready',
            detail: { kind: 'website', key: item.key, titles: [{ title: 'Usage redesign', ms: 5 * HOUR }, { title: 'SQL window functions', ms: 90 * MIN }], titleCount: 14, latestTitle: 'Usage redesign', lastActiveAt: item.lastActiveAt },
          }}
        />,
      ),
    );
    expect(html).toContain('Website chatgpt.com');
    expect(html).toContain('This week 12h');
    expect(html).toContain('Last week 8h');
    expect(html).toContain('Change +4h · +50%');
    expect(html).toContain('Share of tracked time 46%');
    expect(html).toContain('Share of website time 80%');
    expect(html).toContain('Brought to the front 80 times');
    expect(html).toContain('Mon, Oct 12 – Wed, Oct 14, 3:00 PM, compared with Mon, Oct 5 – Wed, Oct 7, 3:00 PM.');
    expect(html).toContain('Usage redesign 5h');
    expect(html).toContain('2 of 14 titles shown.');
  });

  it('the detail of something no longer used shows zero, accurately', () => {
    const report = makeReport();
    const gone = report.movers.find((m) => m.name === 'Netflix')!;
    const html = text(renderToStaticMarkup(<UsageDetail item={gone} report={report} now={NOW} onClose={() => {}} state={{ status: 'loading' }} />));
    expect(html).toContain('This week 0s');
    expect(html).toContain('Last week 5h');
    expect(html).toContain('Change −5h · −100%');
  });
});

describe('loading, empty and error states', () => {
  it('first load: placeholders, no figures', () => {
    const html = render({ report: null, loading: true, stale: true });
    expect(html).toContain('usage-skeleton');
    expect(html).toContain('Loading…');
    expect(html).not.toContain('Total tracked time');
  });

  it('switching period: the last figures stay, dimmed, instead of flashing empty', () => {
    const html = render({ request: { type: 'month' }, loading: true, stale: true });
    expect(html).toContain('data-loading="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Total tracked time');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Month</);
    // The range caption belongs to the period being loaded, so it is not shown yet.
    expect(html).toContain('Loading…');
  });

  it('a period with no activity: zero, stated plainly, still compared', () => {
    const page = text(render({ report: makeReport({ current: [] }) }));
    expect(page).toContain('Total tracked time 0s');
    expect(page).toContain('−26h · −100% vs last week');
    expect(page).toContain('No tracked activity this week.');
    expect(page).toContain('Most used application — No applications tracked');
    expect(page).not.toContain('Top applications');
  });

  it('a custom range with no activity', () => {
    const window = { ...WEEK_WINDOW, type: 'custom' as const, inProgress: false };
    const page = text(render({ request: { type: 'custom', startDate: '2026-10-12', endDate: '2026-10-18' }, report: makeReport({ window, current: [], previous: [] }) }));
    expect(page).toContain('No tracked activity in this range.');
    expect(page).toContain('Selected range vs preceding range');
  });

  it('nothing ever tracked', () => {
    const page = text(render({ report: makeReport({ current: [], previous: [], trackingSince: null }) }));
    expect(page).toContain('Reflect has not recorded any activity yet.');
    expect(page).toContain('No comparison yet: nothing has been tracked before this period.');
  });

  it('a failed first load: the error and a way to retry, no stale or empty figures', () => {
    const p = props({ report: null, stale: true, error: 'database is locked' });
    const html = renderToStaticMarkup(<UsageView {...p} />);
    expect(text(html)).toContain('Usage could not be loaded. database is locked');
    expect(html).not.toContain('usage-skeleton');
    expect(html).not.toContain('Total tracked time');

    buttons(UsageView(p) as ReactElement).find((b) => textOf(b).includes('Try again'))!.props.onClick();
    expect(p.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a failed load of another period never shows the previous period\'s figures as if they were its own', () => {
    const html = render({ request: { type: 'year' }, stale: true, error: 'boom' });
    expect(html).not.toContain('Total tracked time');
  });

  it('a failed refresh keeps the figures already shown and says they are the last read', () => {
    const page = text(render({ error: 'boom' }));
    expect(page).toContain('showing the last figures read');
    expect(page).toContain('Total tracked time 26h');
  });
});
