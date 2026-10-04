import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionBlockView, sessionBlockLabel, type SessionBlockViewProps } from '../../src/ui/Timeline/SessionBlock';
import { TimelineCanvas } from '../../src/ui/Timeline/TimelineCanvas';
import { TimelineToolbar } from '../../src/ui/Timeline/TimelineToolbar';
import { InlineEditor } from '../../src/ui/Timeline/InlineEditor';
import {
  blockMode,
  computeDayLayout,
  pxPerHourFor,
  CHIP_HEIGHT,
  TIMELINE_DENSITIES,
} from '../../src/ui/Timeline/timelineLayout';
import { fullDayHeight } from '../../src/ui/Timeline/timelineUtils';
import { DAY, denseDay, session } from './timelineFixtures';

/**
 * The timeline blocks, rendered for real (server-side, no DOM needed).
 * Interaction is covered by invoking the handlers on the rendered element
 * tree, the way a click / key press / context menu would.
 */

const LONG_TITLE =
  'Researching tools for thinking on video sites and reference pages while planning the dataset work for tomorrow';

function actions() {
  return {
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onStartDrag: vi.fn(),
    onStartResize: vi.fn(),
    onContextMenu: vi.fn(),
  };
}

function viewProps(overrides: Partial<SessionBlockViewProps> = {}): SessionBlockViewProps {
  return {
    session: session('s1', '10:00', '11:00'),
    top: 720,
    height: 72,
    width: '100%',
    left: '0%',
    isSelected: false,
    editing: false,
    onEditingChange: vi.fn(),
    actions: actions(),
    ...overrides,
  };
}

type AnyProps = Record<string, any>;

/** The block's root element — `SessionBlockView` has no hooks, so it can be called directly. */
const root = (props: SessionBlockViewProps) => SessionBlockView(props) as ReactElement<AnyProps>;

/** Depth-first search of plain (host) elements below a node. */
function findAll(node: unknown, match: (el: ReactElement<AnyProps>) => boolean, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return found;
  const el = node as ReactElement<AnyProps>;
  if (match(el)) found.push(el);
  findAll(el.props.children, match, found);
  return found;
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const markupOf = (props: SessionBlockViewProps) => renderToStaticMarkup(<SessionBlockView {...props} />);
const mouse = (extra: AnyProps = {}) => ({ stopPropagation: vi.fn(), preventDefault: vi.fn(), button: 0, ...extra });

// ── what a block shows ──────────────────────────────────────────────────────

describe('SessionBlockView — density-aware content', () => {
  it('shows title, time range and duration on a long activity', () => {
    const html = markupOf(viewProps({ session: session('long', '10:20', '12:05', { title: 'Build billing' }), height: 252 }));
    const shown = text(html);
    expect(shown).toContain('Build billing');
    expect(shown).toContain('10:20 – 12:05');
    expect(shown).toContain('1h 45m');
    expect(html).toContain('data-block-mode="full"');
  });

  it('shows a one-line title and duration on a short activity', () => {
    const html = markupOf(viewProps({ session: session('short', '10:42', '10:46', { title: 'Check mail' }), height: CHIP_HEIGHT }));
    expect(html).toContain('data-block-mode="line"');
    expect(text(html)).toBe('Check mail 4m');
  });

  it('drops the duration, not the title, when a line block is narrow', () => {
    const html = markupOf(viewProps({ session: session('short', '10:42', '10:46', { title: 'Check mail' }), height: CHIP_HEIGHT, widthPx: 70 }));
    expect(text(html)).toBe('Check mail');
  });

  it('draws a very short activity as a sliver with no text, but keeps it described', () => {
    const s = session('tiny', '10:42:00', '10:42:20', { title: 'Tab switch', eventCount: 3 });
    const html = markupOf(viewProps({ session: s, height: 4 }));
    expect(html).toContain('data-block-mode="marker"');
    expect(text(html)).toBe('');
    // Not hidden: reachable by pointer, keyboard and assistive tech.
    expect(html).toContain('data-session-id="tiny"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Tab switch, 10:42 to 10:42, 20s"');
    expect(html).toContain('Tab switch\n10:42 – 10:42 · 20s\n3 events\nClick for details');
  });

  it('includes the classification in the hover details when there is one', () => {
    const s = session('c', '10:00', '10:03', {
      title: 'Standup',
      classification: {
        context: { id: 'ctx', name: 'Work', color: null },
        area: { id: 'area', name: 'Meetings' },
        intent: null,
        quality: null,
        source: 'rule',
        reason: '',
        matchedRuleId: null,
        matchedConditions: null,
        isOverride: false,
      },
    });
    expect(root(viewProps({ session: s, height: 4 })).props.title).toContain('Work · Meetings');
  });

  it('never draws a short activity at card size', () => {
    const el = root(viewProps({ session: session('tiny', '10:42', '10:43'), height: 4 }));
    expect(el.props.style.height).toBeLessThan(CHIP_HEIGHT);
  });

  it('marks the real duration on a block drawn taller than its duration', () => {
    const el = root(viewProps({ session: session('grown', '10:00', '10:01'), height: CHIP_HEIGHT, trueHeight: 2.4 }));
    const bars = findAll(el.props.children, (c) => c.type === 'span' && c.props['aria-hidden'] === true);
    expect(bars).toHaveLength(2);
    expect(bars[1].props.style.height).toBeCloseTo(2.4);
    // A block drawn at its real size has one full-height bar.
    const plain = root(viewProps({ height: 72, trueHeight: 72 }));
    const plainBars = findAll(plain.props.children, (c) => c.type === 'span' && c.props['aria-hidden'] === true);
    expect(plainBars).toHaveLength(1);
    expect(plainBars[0].props.style.height).toBe('100%');
  });

  it('labels untitled activities instead of rendering an empty block', () => {
    expect(text(markupOf(viewProps({ session: session('u', '10:00', '11:00', { title: '' }) })))).toContain('(unlabelled)');
    expect(sessionBlockLabel(session('o', '10:00', '11:00', { title: '', source: 'user' }))).toContain('(offline)');
  });
});

// ── titles cannot escape their block ────────────────────────────────────────

describe('SessionBlockView — title containment', () => {
  const heights = [4, 14, CHIP_HEIGHT, 30, 44, 60, 72, 100, 140, 400];

  it.each(heights)('clips its content at height %ipx', (height) => {
    const el = root(viewProps({ session: session('t', '10:00', '11:00', { title: LONG_TITLE }), height }));
    expect(el.props.style.overflow).toBe('hidden');
    expect(el.props.style.position).toBe('absolute');
    // The box is exactly as tall as the layout allowed (less the 1px seam).
    expect(el.props.style.height).toBe(Math.max(4, height) - 1);
  });

  it.each(heights.filter((h) => blockMode(h) !== 'marker'))('keeps every text line single-line with an ellipsis at height %ipx', (height) => {
    const el = root(viewProps({ session: session('t', '10:00', '11:00', { title: LONG_TITLE }), height }));
    const textBoxes = findAll(el.props.children, (c) => c.type === 'div' && typeof c.props.style?.fontSize === 'string');
    expect(textBoxes.length).toBeGreaterThan(0);
    for (const box of textBoxes) expect(box.props.style.whiteSpace).toBe('nowrap');
    const title = textBoxes[0];
    expect(title.props.children).toBe(LONG_TITLE);
    expect(title.props.style).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
  });

  it('shows no clipped half-word on a block too narrow for text', () => {
    const html = markupOf(viewProps({ session: session('n', '10:00', '10:01', { title: 'New Tab' }), height: CHIP_HEIGHT, widthPx: 22 }));
    expect(text(html)).toBe('');
    expect(html).toContain('aria-label="New Tab, 10:00 to 10:01, 1m"');
  });

  it('keeps the full title available when it is truncated', () => {
    const el = root(viewProps({ session: session('t', '10:00', '10:04', { title: LONG_TITLE }), height: CHIP_HEIGHT, widthPx: 90 }));
    expect(el.props.title).toContain(LONG_TITLE);
    expect(el.props['aria-label']).toContain(LONG_TITLE);
  });

  it('positions the block in the lane it was given', () => {
    const pct = root(viewProps({ left: '71.4%', width: '28.6%' }));
    expect(pct.props.style.left).toBe('71.4%');
    expect(pct.props.style.width).toBe('calc(28.6% - 4px)');
    const px = root(viewProps({ left: 40, width: 120 }));
    expect(px.props.style).toMatchObject({ left: 40, width: 116 });
  });
});

// ── interaction targets the right activity ──────────────────────────────────

describe('SessionBlockView — selection and edit actions', () => {
  it.each([4, CHIP_HEIGHT, 50, 120])('selects its own activity on click at height %ipx', (height) => {
    const a = actions();
    const el = root(viewProps({ session: session('mine', '10:00', '10:05'), height, actions: a }));
    const click = mouse();
    el.props.onClick(click);
    expect(a.onSelect).toHaveBeenCalledExactlyOnceWith('mine');
    // The click must not fall through to the canvas (which clears the selection).
    expect(click.stopPropagation).toHaveBeenCalled();
  });

  it('selects the right one of two overlapping activities', () => {
    const outer = session('outer', '10:00', '12:00');
    const inner = session('inner', '10:30', '11:15');
    const layout = computeDayLayout([outer, inner], DAY);
    const a = actions();
    const els = [outer, inner].map((s) => {
      const b = layout.byId.get(s.id)!;
      return root(viewProps({ session: s, top: b.top, height: b.height, left: `${b.left * 100}%`, width: `${b.width * 100}%`, actions: a }));
    });
    // Side by side, not stacked: their boxes cannot be confused.
    expect(els[0].props.style.left).toBe('0%');
    expect(els[1].props.style.left).toBe('50%');
    els[1].props.onClick(mouse());
    expect(a.onSelect).toHaveBeenLastCalledWith('inner');
    els[0].props.onClick(mouse());
    expect(a.onSelect).toHaveBeenLastCalledWith('outer');
  });

  it('selects from the keyboard with Enter or Space', () => {
    const a = actions();
    const el = root(viewProps({ session: session('kb', '10:00', '10:05'), height: 4, actions: a }));
    for (const key of ['Enter', ' ']) {
      const target = {};
      el.props.onKeyDown({ key, target, currentTarget: target, preventDefault: vi.fn() });
    }
    expect(a.onSelect).toHaveBeenCalledTimes(2);
    expect(a.onSelect).toHaveBeenLastCalledWith('kb');
    // Keys typed into the inline rename field are not selection keys.
    el.props.onKeyDown({ key: ' ', target: {}, currentTarget: {}, preventDefault: vi.fn() });
    expect(a.onSelect).toHaveBeenCalledTimes(2);
  });

  it('exposes one tab stop and the pressed state', () => {
    expect(root(viewProps({ tabbable: true })).props.tabIndex).toBe(0);
    expect(root(viewProps({ tabbable: false })).props.tabIndex).toBe(-1);
    expect(root(viewProps({ isSelected: true })).props['aria-pressed']).toBe(true);
    expect(root(viewProps({ isSelected: false })).props['aria-pressed']).toBe(false);
  });

  it('opens the context menu (split / merge / delete / …) for its own activity', () => {
    const a = actions();
    const s = session('ctx', '10:00', '10:02');
    const el = root(viewProps({ session: s, height: 4, actions: a }));
    const event = mouse();
    el.props.onContextMenu(event);
    expect(a.onContextMenu).toHaveBeenCalledExactlyOnceWith(event, s);
  });

  it('starts a drag for its own activity, and not in read-only mode', () => {
    const a = actions();
    const down = mouse();
    root(viewProps({ session: session('drag', '10:00', '11:00'), actions: a })).props.onMouseDown(down);
    expect(a.onStartDrag).toHaveBeenCalledExactlyOnceWith('drag', down);
    root(viewProps({ session: session('ro', '10:00', '11:00'), actions: a, readonly: true })).props.onMouseDown(mouse());
    root(viewProps({ session: session('rb', '10:00', '11:00'), actions: a })).props.onMouseDown(mouse({ button: 2 }));
    expect(a.onStartDrag).toHaveBeenCalledTimes(1);
  });

  it('renames its own activity through the inline editor', () => {
    const a = actions();
    const onEditingChange = vi.fn();
    const closed = root(viewProps({ session: session('rn', '10:00', '11:00'), actions: a, onEditingChange }));
    closed.props.onDoubleClick(mouse());
    expect(onEditingChange).toHaveBeenCalledWith(true);

    const open = root(viewProps({ session: session('rn', '10:00', '11:00', { title: 'Old' }), actions: a, onEditingChange, editing: true }));
    const editor = findAll(open.props.children, (c) => c.type === InlineEditor)[0];
    expect(editor.props.initial).toBe('Old');
    editor.props.onCommit('New title');
    expect(a.onRename).toHaveBeenCalledExactlyOnceWith('rn', 'New title');
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('gives a sliver room for the rename field while editing', () => {
    const el = root(viewProps({ session: session('rn', '10:00', '10:01'), height: 4, editing: true }));
    expect(el.props.style.height).toBeGreaterThanOrEqual(24);
    expect(findAll(el.props.children, (c) => c.type === InlineEditor)).toHaveLength(1);
  });

  it('does not open the rename field in read-only mode', () => {
    const onEditingChange = vi.fn();
    root(viewProps({ readonly: true, onEditingChange })).props.onDoubleClick(mouse());
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('resizes its own activity from either edge', () => {
    const a = actions();
    const el = root(viewProps({ session: session('rs', '10:00', '11:00'), height: 72, actions: a }));
    const handle = (name: string) => findAll(el.props.children, (c) => c.props.className === name)[0];
    const top = mouse();
    handle('resize-handle-top').props.onMouseDown(top);
    expect(a.onStartResize).toHaveBeenLastCalledWith('rs', 'top', top);
    const bottom = mouse();
    handle('resize-handle-bottom').props.onMouseDown(bottom);
    expect(a.onStartResize).toHaveBeenLastCalledWith('rs', 'bottom', bottom);
    // A resize must not also start a drag.
    expect(top.stopPropagation).toHaveBeenCalled();
  });

  it('has no resize handles where they would cover the whole block', () => {
    for (const height of [4, 14, CHIP_HEIGHT]) {
      const el = root(viewProps({ height }));
      expect(findAll(el.props.children, (c) => /resize-handle/.test(c.props.className ?? ''))).toHaveLength(0);
    }
    const readonly = root(viewProps({ height: 120, readonly: true }));
    expect(findAll(readonly.props.children, (c) => /resize-handle/.test(c.props.className ?? ''))).toHaveLength(0);
  });
});

// ── dense day, end to end ───────────────────────────────────────────────────

describe('dense day smoke test', () => {
  const baseProps = {
    baseDay: DAY,
    selectedId: null,
    isToday: false,
    readonly: true,
    onSelect: () => {},
    onOpenFocus: () => {},
    onRename: () => {},
    onStartDrag: () => {},
    onStartResize: () => {},
  };

  it.each(TIMELINE_DENSITIES)('renders every activity of a dense day as its own block at %s density', (density) => {
    const sessions = denseDay();
    const pxPerHour = pxPerHourFor(density);
    const layout = computeDayLayout(sessions, DAY, pxPerHour);

    const html = sessions
      .map((s) => {
        const b = layout.byId.get(s.id)!;
        return markupOf(viewProps({ session: s, top: b.top, height: b.height, trueHeight: b.trueHeight, left: `${b.left * 100}%`, width: `${b.width * 100}%` }));
      })
      .join('');

    for (const s of sessions) {
      expect(html).toContain(`data-session-id="${s.id}"`);
      expect(html).toContain(`aria-label="${sessionBlockLabel(s)}"`);
    }
    expect(html.match(/data-session-id=/g)).toHaveLength(sessions.length);
    // The old renderer drew every block at least 56px tall; short ones are compact now.
    const short = sessions.filter((s) => s.duration < 5 * 60_000);
    expect(short.length).toBeGreaterThan(10);
    for (const s of short) expect(layout.byId.get(s.id)!.height).toBeLessThanOrEqual(Math.max(CHIP_HEIGHT, layout.byId.get(s.id)!.trueHeight));
  });

  it('renders the day canvas as a vertically scrollable full day', () => {
    for (const density of TIMELINE_DENSITIES) {
      const pxPerHour = pxPerHourFor(density);
      const html = renderToStaticMarkup(<TimelineCanvas {...baseProps} sessions={denseDay()} pxPerHour={pxPerHour} />);
      expect(html).toContain('data-timeline-canvas');
      expect(html).toContain('overflow-y:auto');
      expect(html).toContain(`height:${fullDayHeight(pxPerHour)}px`);
    }
  });

  it('renders the after-midnight overlaps side by side, without the old minimum card height', () => {
    const html = renderToStaticMarkup(<TimelineCanvas {...baseProps} sessions={denseDay()} pxPerHour={pxPerHourFor('normal')} />);
    // First viewport of the day: the cluster of genuinely overlapping ranges.
    expect(html).toContain('data-session-id="d00"');
    expect(html).toContain('data-session-id="d03"');
    expect(html).not.toContain('height:56px');
    // Exactly one block is the keyboard tab stop.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('still shows the empty state on a day without activity', () => {
    const html = renderToStaticMarkup(<TimelineCanvas {...baseProps} sessions={[]} />);
    // Wording depends on whether the fixture day happens to be today.
    expect(text(html)).toMatch(/No activity (for this day|tracked yet)/);
    expect(html).not.toContain('data-session-id');
  });
});

// ── density control ─────────────────────────────────────────────────────────

describe('TimelineToolbar — density control', () => {
  const toolbarProps = {
    onViewChange: () => {},
    dayLabel: 'Sun, Oct 4',
    onPrevDay: () => {},
    onNextDay: () => {},
    onPickDay: () => {},
    onToday: () => {},
    isToday: false,
    canUndo: false,
    canRedo: false,
    activeEdits: 0,
    onUndo: () => {},
    onRedo: () => {},
    onInsertOffline: () => {},
    density: 'normal' as const,
    onDensityChange: () => {},
    customStart: '2026-10-01',
    customEnd: '2026-10-04',
    onCustomStartChange: () => {},
    onCustomEndChange: () => {},
  };

  it('offers three densities in the Day View, with the current one pressed', () => {
    const html = renderToStaticMarkup(<TimelineToolbar {...toolbarProps} view="day" />);
    expect(html).toContain('aria-label="Timeline density"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-pressed="true" aria-label="Normal density"/);
  });

  it.each(['week', 'month', 'year', 'custom'] as const)('has no density control in the %s view', (view) => {
    const html = renderToStaticMarkup(<TimelineToolbar {...toolbarProps} view={view} />);
    expect(html).not.toContain('Timeline density');
  });
});
