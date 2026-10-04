import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EndFocusDialogView, type EndFocusDialogViewProps } from '../../src/ui/Focus/EndFocusDialog';
import { FocusActiveView, type FocusActiveViewProps } from '../../src/ui/Focus/FocusActive';
import { FocusStartView, type FocusStartViewProps } from '../../src/ui/Focus/FocusStart';
import { FocusSummaryModal } from '../../src/ui/Focus/FocusSummaryModal';
import { FocusWidget } from '../../src/ui/Focus/FocusWidget';
import { MIN, T0, active, challenge, iso, profile, stopwatch, summary } from './focusFixtures';

/**
 * The Focus screens, rendered for real (server-side, no DOM needed).
 * Interaction is covered by walking the rendered element tree and invoking
 * the handlers the user would trigger.
 */

/** Text content with tags removed — what the user reads. */
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Depth-first search of an element tree; components with hooks are left unexpanded. */
function findAll(node: unknown, match: (el: ReactElement) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return found;
  let el = node as ReactElement;
  while (typeof el.type === 'function') {
    try {
      el = (el.type as (p: unknown) => ReactElement)(el.props);
    } catch {
      return found; // uses hooks; rendered separately via markup
    }
    if (!el || typeof el !== 'object') return found;
  }
  if (match(el)) found.push(el);
  findAll((el.props as { children?: unknown }).children, match, found);
  return found;
}

const label = (el: ReactElement) => text(renderToStaticMarkup(el));
const buttons = (tree: ReactElement) => findAll(tree, (el) => el.type === 'button');
const button = (tree: ReactElement, name: string | RegExp) => {
  const hit = buttons(tree).find((b) => (typeof name === 'string' ? label(b) === name : name.test(label(b))));
  if (!hit) throw new Error(`no button ${name}; have: ${buttons(tree).map(label).join(' | ')}`);
  return hit as ReactElement<{ onClick?: () => void; disabled?: boolean; 'aria-pressed'?: boolean; type?: string }>;
};

/** Things that belong in Timeline / Activity / Reflection, never on the Focus page. */
const ANALYTICS = ['history', 'recent sessions', 'interruptions', 'blocked attempts', 'productive', 'score', 'streak', 'chart', 'trend'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 7 * MIN + 46_000);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Start ──────────────────────────────────────────────────────────────────

function startProps(overrides: Partial<FocusStartViewProps> = {}): FocusStartViewProps {
  return {
    profiles: [profile()],
    profileId: 'profile-1',
    task: '',
    mode: 'countdown',
    durationMinutes: 60,
    customDuration: false,
    notes: '',
    notesOpen: false,
    suggestions: [],
    busy: null,
    error: null,
    blockingResidue: false,
    onTaskChange: vi.fn(),
    onSelectDuration: vi.fn(),
    onSelectCustom: vi.fn(),
    onSelectNoLimit: vi.fn(),
    onCustomDurationChange: vi.fn(),
    onSelectProfile: vi.fn(),
    onEditBlocking: vi.fn(),
    onCreatePreset: vi.fn(),
    onStartWithoutBlocking: vi.fn(),
    onToggleNotes: vi.fn(),
    onNotesChange: vi.fn(),
    onSubmit: vi.fn(),
    onClearResidue: vi.fn(),
    ...overrides,
  };
}

const startTree = (overrides: Partial<FocusStartViewProps> = {}) => FocusStartView(startProps(overrides)) as ReactElement;
const startText = (overrides: Partial<FocusStartViewProps> = {}) => text(renderToStaticMarkup(<FocusStartView {...startProps(overrides)} />));

describe('Focus start screen', () => {
  it('asks only for what is needed to start', () => {
    const read = startText();
    expect(read).toContain('What are you focusing on?');
    expect(read).toContain('Deep Work');
    expect(read).toContain('Blocking: 5 rules · 38 sites · 4 apps');
    expect(read).toContain('Start Focus');
    for (const preset of ['25 min', '30 min', '45 min', '1 hr', '1 hr 30 min', '2 hr', 'Custom', 'No limit']) expect(read).toContain(preset);
    for (const word of ANALYTICS) expect(read.toLowerCase()).not.toContain(word);
    // Notes stay out of the way until asked for.
    expect(renderToStaticMarkup(<FocusStartView {...startProps()} />)).not.toContain('<textarea');
    expect(read).toContain('+ Add note');
    // The task comes first, then duration, then the preset, then Start.
    const order = ['What are you focusing on?', 'Duration', 'Preset', 'Start Focus'].map((t) => read.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    for (const word of ['lease', 'rule pool', 'stopwatch', 'profile rule']) expect(read.toLowerCase()).not.toContain(word);
  });

  it('preselects the profile\'s default duration', () => {
    const pressed = buttons(startTree()).filter((b) => (b.props as { 'aria-pressed'?: boolean })['aria-pressed']);
    expect(pressed.map(label)).toEqual(['1 hr']);
  });

  it('cannot start without a task, and can with one', () => {
    expect(button(startTree(), 'Start Focus').props.disabled).toBe(true);
    expect(button(startTree({ task: '   ' }), 'Start Focus').props.disabled).toBe(true);
    expect(button(startTree({ task: 'Finish authentication' }), 'Start Focus').props.disabled).toBe(false);
  });

  it('submits through the form, and not when invalid or already starting', () => {
    const submit = (overrides: Partial<FocusStartViewProps>) => {
      const props = startProps(overrides);
      const form = findAll(FocusStartView(props), (el) => el.type === 'form')[0] as ReactElement<{ onSubmit: (e: unknown) => void }>;
      form.props.onSubmit({ preventDefault: () => {} });
      return props.onSubmit as ReturnType<typeof vi.fn>;
    };
    expect(submit({ task: 'Finish authentication' })).toHaveBeenCalledTimes(1);
    expect(submit({ task: '' })).not.toHaveBeenCalled();
    expect(submit({ task: 'x', durationMinutes: 0, customDuration: true })).not.toHaveBeenCalled();
    expect(submit({ task: 'Finish authentication', busy: 'starting' })).not.toHaveBeenCalled();
  });

  it('shows a clear in-progress state and blocks double starts', () => {
    const tree = startTree({ task: 'Finish authentication', busy: 'starting' });
    expect(button(tree, 'Starting Focus…').props.disabled).toBe(true);
    expect(startText({ task: 'x', busy: 'starting' })).toContain('approve the Windows prompt');
    const inputs = findAll(tree, (el) => el.type === 'input') as ReactElement<{ disabled?: boolean }>[];
    expect(inputs.every((i) => i.props.disabled)).toBe(true);
  });

  it('duration chips drive the selection', () => {
    const props = startProps();
    const tree = FocusStartView(props) as ReactElement;
    button(tree, '1 hr 30 min').props.onClick?.();
    expect(props.onSelectDuration).toHaveBeenCalledWith(90);
    button(tree, 'Custom').props.onClick?.();
    expect(props.onSelectCustom).toHaveBeenCalled();
    button(tree, 'No limit').props.onClick?.();
    expect(props.onSelectNoLimit).toHaveBeenCalled();
  });

  it('shows a number field for a custom duration, and for a profile default that is not a preset', () => {
    const numberInputs = (overrides: Partial<FocusStartViewProps>) =>
      findAll(startTree(overrides), (el) => el.type === 'input' && (el.props as { type?: string }).type === 'number');
    expect(numberInputs({})).toHaveLength(0);
    expect(numberInputs({ customDuration: true })).toHaveLength(1);
    expect(numberInputs({ durationMinutes: 50 })).toHaveLength(1);
    expect(button(startTree({ durationMinutes: 50 }), 'Custom').props['aria-pressed']).toBe(true);
  });

  it('a stopwatch has no planned end', () => {
    const read = startText({ mode: 'stopwatch' });
    expect(read).toContain('Runs until you end it.');
    expect(button(startTree({ mode: 'stopwatch' }), 'No limit').props['aria-pressed']).toBe(true);
  });

  it('with no presets, offers to create the first one instead of a broken form', () => {
    const props = startProps({ profiles: [], profileId: null });
    const tree = FocusStartView(props) as ReactElement;
    expect(label(tree)).toContain('Create your first Focus preset');
    expect(label(tree)).not.toContain('Start Focus');
    expect(findAll(tree, (el) => el.type === 'select' || el.type === 'input')).toHaveLength(0);
    button(tree, 'Create preset').props.onClick?.();
    expect(props.onCreatePreset).toHaveBeenCalled();
  });

  it('with one preset shows it without a chooser', () => {
    expect(findAll(startTree(), (el) => (el.props as { role?: string }).role === 'radio')).toHaveLength(0);
  });

  it('switches preset in one click', () => {
    const many = Array.from({ length: 6 }, (_, i) => profile({ id: `p${i}`, name: `Preset ${i}`, isDefault: i === 0 }));
    const props = startProps({ profiles: many, profileId: 'p3' });
    const tree = FocusStartView(props) as ReactElement;
    const radios = findAll(tree, (el) => (el.props as { role?: string }).role === 'radio') as ReactElement<{ onClick: () => void; 'aria-checked': boolean }>[];
    expect(radios).toHaveLength(6);
    expect(radios.filter((r) => r.props['aria-checked']).map(label)).toEqual(['Preset 3']);
    radios[5].props.onClick();
    expect(props.onSelectProfile).toHaveBeenCalledWith('p5');
  });

  it('opens what the selected preset blocks in one click', () => {
    const props = startProps();
    const tree = FocusStartView(props) as ReactElement;
    button(tree, /What’s blocked/).props.onClick?.();
    expect(props.onEditBlocking).toHaveBeenCalledTimes(1);
  });

  it('when blocking could not be turned on, says so and offers a retry or an honest start without it', () => {
    const props = startProps({ task: 'Finish authentication', error: 'Administrator permission was declined, so blocking could not be turned on. Focus was not started.' });
    const tree = FocusStartView(props) as ReactElement;
    const read = label(tree);
    expect(read).toContain('Couldn’t turn on blocking.');
    expect(read).toContain('Administrator permission was declined');
    expect(button(tree, 'Try again').props.type).toBe('submit');
    button(tree, 'Start without blocking').props.onClick?.();
    expect(props.onStartWithoutBlocking).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
    // An ordinary error offers no such thing.
    expect(startText({ task: 'x', error: 'A Focus session is already running.' })).not.toContain('Start without blocking');
  });

  it('says so when the profile blocks nothing', () => {
    const off = profile({ blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } });
    const read = startText({ profiles: [off] });
    expect(read).toContain('Nothing is blocked');
    expect(read).toContain('Choose what to block');
  });

  it('keeps very long names from breaking the layout: they are titled and truncated by class', () => {
    const long = 'A'.repeat(180);
    const markup = renderToStaticMarkup(<FocusStartView {...startProps({ profiles: [profile({ name: long })], suggestions: [long] })} />);
    expect(markup).toContain(`class="focus-preset-name" title="${long}"`);
    expect(markup).toContain(`data-quiet="true" title="${long}"`);
  });

  it('offers recent tasks only while the field is empty', () => {
    const props = startProps({ suggestions: ['Write proposal', 'Review PRs'] });
    const tree = FocusStartView(props) as ReactElement;
    button(tree, 'Write proposal').props.onClick?.();
    expect(props.onTaskChange).toHaveBeenCalledWith('Write proposal');
    expect(startText({ suggestions: ['Write proposal'], task: 'Something' })).not.toContain('Write proposal');
  });

  it('shows the error and leftover-blocking notices', () => {
    expect(startText({ error: 'A Focus session is already running.' })).toContain('A Focus session is already running.');
    const props = startProps({ blockingResidue: true });
    const tree = FocusStartView(props) as ReactElement;
    expect(label(tree)).toContain('Blocking from an earlier Focus session is still in place.');
    button(tree, 'Remove it').props.onClick?.();
    expect(props.onClearResidue).toHaveBeenCalled();
  });
});

// ── Active ─────────────────────────────────────────────────────────────────

function activeProps(overrides: Partial<FocusActiveViewProps> = {}): FocusActiveViewProps {
  return {
    session: active(),
    busy: null,
    error: null,
    pausePickerOpen: false,
    pauseReason: null,
    onPauseReasonChange: vi.fn(),
    onOpenPausePicker: vi.fn(),
    onClosePausePicker: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onEnd: vi.fn(),
    onRestoreBlocking: vi.fn(),
    ...overrides,
  };
}

const activeTree = (overrides: Partial<FocusActiveViewProps> = {}) => FocusActiveView(activeProps(overrides)) as ReactElement;
const activeText = (overrides: Partial<FocusActiveViewProps> = {}) => text(renderToStaticMarkup(<FocusActiveView {...activeProps(overrides)} />));

describe('Active Focus screen', () => {
  it('shows one task, one timer, the state and the blocking state — and nothing else', () => {
    const read = activeText({ session: active({}, { notes: 'secret context notes' }) });
    expect(read).toBe('Focusing Finish authentication 52:14 remaining Deep Work Blocking active Pause End Focus');
    for (const word of ANALYTICS) expect(read.toLowerCase()).not.toContain(word);
    expect(read).not.toContain('secret context notes');
    expect(read).not.toContain('Started');
  });

  it('a stopwatch shows elapsed time', () => {
    expect(activeText({ session: stopwatch() })).toContain('7:46 elapsed');
  });

  it('the timer never shows a negative or stale "over" state at expiry', () => {
    vi.setSystemTime(T0 + 61 * MIN);
    expect(activeText()).toContain('0:00 remaining');
  });

  it('pausing takes a second, deliberate step', () => {
    const props = activeProps();
    button(FocusActiveView(props) as ReactElement, 'Pause').props.onClick?.();
    expect(props.onOpenPausePicker).toHaveBeenCalled();
    expect(props.onPause).not.toHaveBeenCalled();

    // The prompt is not on screen until Pause is pressed.
    expect(activeText()).not.toContain('Pause Focus?');
  });

  it('the pause prompt is compact: optional reason, Pause, and a real Keep Focusing button', () => {
    const open = activeProps({ pausePickerOpen: true });
    const tree = FocusActiveView(open) as ReactElement;
    expect(label(tree)).toContain('Pause Focus?');
    for (const reason of ['Quick break', 'Phone call', 'Meeting', 'Distraction', 'Other']) expect(label(tree)).toContain(reason);

    // Picking a reason only selects it.
    button(tree, 'Phone call').props.onClick?.();
    expect(open.onPauseReasonChange).toHaveBeenCalledWith('Phone call');
    expect(open.onPause).not.toHaveBeenCalled();

    const keep = button(tree, 'Keep Focusing');
    expect((keep.props as { className?: string }).className).toBe('focus-btn');
    expect((keep.props as { 'data-variant'?: string })['data-variant']).toBe('primary');
    keep.props.onClick?.();
    expect(open.onClosePausePicker).toHaveBeenCalled();

    // Pause works with or without a reason, and records the one chosen.
    button(tree, 'Pause').props.onClick?.();
    expect(open.onPause).toHaveBeenCalledWith(null);
    const chosen = activeProps({ pausePickerOpen: true, pauseReason: 'Meeting' });
    const chosenTree = FocusActiveView(chosen) as ReactElement;
    expect(button(chosenTree, 'Meeting').props['aria-pressed']).toBe(true);
    button(chosenTree, 'Pause').props.onClick?.();
    expect(chosen.onPause).toHaveBeenCalledWith('Meeting');
  });

  it('paused: offers Resume and says blocking stays on', () => {
    const paused = active({ isRunning: false, pauseKind: 'manual' }, { state: 'paused', pausedAt: iso(T0 + 5 * MIN), elapsedMs: 5 * MIN });
    const props = activeProps({ session: paused });
    const tree = FocusActiveView(props) as ReactElement;
    const read = activeText({ session: paused });
    expect(read).toContain('Paused');
    expect(read).toContain('Blocking active');
    expect(read).toContain('Blocking remains active while paused.');
    expect(buttons(tree).map(label)).toEqual(['Resume', 'End Focus']);
    button(tree, 'Resume').props.onClick?.();
    expect(props.onResume).toHaveBeenCalled();
    expect(activeText({ session: active({ isRunning: false, pauseKind: 'idle' }) })).toContain('Paused — no activity');
  });

  it('End Focus only asks to end — it has no direct stop', () => {
    const props = activeProps();
    const end = button(FocusActiveView(props) as ReactElement, 'End Focus');
    // A clear secondary action: a bordered button, not a danger button.
    expect((end.props as { 'data-variant'?: string })['data-variant']).toBeUndefined();
    end.props.onClick?.();
    expect(props.onEnd).toHaveBeenCalledTimes(1);
    expect(Object.keys(props).some((k) => /stop|complete|cancel/i.test(k))).toBe(false);
  });

  it('tells the truth when blocking is not healthy', () => {
    const degraded = active({ blocking: { status: 'degraded', ruleCount: 5, message: 'The blocker stopped responding.' } });
    const props = activeProps({ session: degraded });
    const tree = FocusActiveView(props) as ReactElement;
    const read = activeText({ session: degraded });
    expect(read).toContain('Blocking stopped');
    expect(read).toContain('The blocker stopped responding.');
    expect(read).not.toContain('Blocking active');
    button(tree, 'Restore').props.onClick?.();
    expect(props.onRestoreBlocking).toHaveBeenCalled();

    expect(activeText({ session: active({ blocking: { status: 'recovering', ruleCount: 5, message: null } }) })).toContain('Restoring blocking…');
    expect(activeText({ session: active({ blocking: { status: 'off', ruleCount: 0, message: null } }) })).toContain('Blocking off');
    expect(activeText({ session: active({ blocking: { status: 'unavailable', ruleCount: 5, message: null } }) })).toContain('Blocking unavailable');
  });

  it('never offers a way around blocking', () => {
    const read = [activeText(), activeText({ pausePickerOpen: true }), activeText({ session: active({ isRunning: false, pauseKind: 'manual' }) })]
      .join(' ')
      .toLowerCase();
    for (const phrase of ['open anyway', 'disable', 'skip', 'unblock', 'turn off blocking', 'edit profile', 'settings']) {
      expect(read).not.toContain(phrase);
    }
  });

  it('disables every action while an operation is in flight', () => {
    for (const busy of ['pausing', 'resuming', 'ending', 'restoring'] as const) {
      const tree = activeTree({ busy });
      expect(buttons(tree).every((b) => (b.props as { disabled?: boolean }).disabled)).toBe(true);
    }
    const picker = activeTree({ busy: 'pausing', pausePickerOpen: true });
    expect(button(picker, 'Meeting').props.disabled).toBe(true);
  });

  it('shows errors, and carries long task and profile names safely', () => {
    expect(activeText({ error: 'Something failed.' })).toContain('Something failed.');
    const long = 'L'.repeat(190);
    const session = active({ profile: profile({ name: long }) }, { task: long });
    const markup = renderToStaticMarkup(<FocusActiveView {...activeProps({ session })} />);
    expect(markup).toContain(`class="focus-task" title="${long}"`);
    expect(markup).toContain(`class="focus-meta" title="${long}"`);
  });
});

// ── Exit dialog ────────────────────────────────────────────────────────────

function endProps(overrides: Partial<EndFocusDialogViewProps> = {}): EndFocusDialogViewProps {
  return {
    challenge: challenge(),
    task: 'Finish authentication',
    step: 'confirm',
    typed: '',
    reason: null,
    busy: false,
    error: null,
    onKeep: vi.fn(),
    onContinue: vi.fn(),
    onTypedChange: vi.fn(),
    onReasonChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

const endTree = (overrides: Partial<EndFocusDialogViewProps> = {}) => EndFocusDialogView(endProps(overrides)) as ReactElement;

describe('End Focus dialog', () => {
  it('first states what is left and makes staying the primary action', () => {
    const tree = endTree();
    expect(label(tree)).toBe('End Focus? Finish authentication You still have 38 minutes remaining. Your commitment is still active. Keep Focusing End Anyway');
    expect((button(tree, 'Keep Focusing').props as { 'data-variant'?: string })['data-variant']).toBe('primary');
  });

  it('"End Anyway" does not end anything — it leads to the typed confirmation', () => {
    const props = endProps();
    button(EndFocusDialogView(props) as ReactElement, 'End Anyway').props.onClick?.();
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('the final button stays disabled until END is typed', () => {
    const disabled = (typed: string) => button(endTree({ step: 'type', typed }), 'End Focus').props.disabled;
    expect(disabled('')).toBe(true);
    expect(disabled('EN')).toBe(true);
    expect(disabled('quit')).toBe(true);
    expect(disabled('END')).toBe(false);
    expect(disabled(' end ')).toBe(false);
  });

  it('submitting without the phrase does nothing; with it, it confirms', () => {
    const submit = (typed: string) => {
      const props = endProps({ step: 'type', typed });
      const form = findAll(EndFocusDialogView(props), (el) => el.type === 'form')[0] as ReactElement<{ onSubmit: (e: unknown) => void }>;
      form.props.onSubmit({ preventDefault: () => {} });
      return props.onSubmit as ReturnType<typeof vi.fn>;
    };
    expect(submit('')).not.toHaveBeenCalled();
    expect(submit('nope')).not.toHaveBeenCalled();
    expect(submit('END')).toHaveBeenCalledTimes(1);
  });

  it('offers short optional reasons and no long explanation', () => {
    const props = endProps({ step: 'type', reason: 'Meeting' });
    const tree = EndFocusDialogView(props) as ReactElement;
    for (const r of ['Changed task', 'Meeting', 'Finished early', 'Needed to stop', 'Other']) expect(label(tree)).toContain(r);
    expect(button(tree, 'Meeting').props['aria-pressed']).toBe(true);
    button(tree, 'Other').props.onClick?.();
    expect(props.onReasonChange).toHaveBeenCalledWith('Other');
    button(tree, 'Meeting').props.onClick?.();
    expect(props.onReasonChange).toHaveBeenCalledWith(null);
    expect(findAll(tree, (el) => el.type === 'textarea')).toHaveLength(0);
  });

  it('keeping the session is one click at every step', () => {
    for (const step of ['confirm', 'type'] as const) {
      const props = endProps({ step });
      button(EndFocusDialogView(props) as ReactElement, 'Keep Focusing').props.onClick?.();
      expect(props.onKeep).toHaveBeenCalledTimes(1);
    }
  });

  it('a stopwatch has a single plain confirmation', () => {
    const tree = endTree({ challenge: challenge({ early: false, requiresPhrase: false, remainingMs: null }) });
    expect(label(tree)).toContain('End Focus');
    expect(label(tree)).not.toContain('remaining');
    expect(buttons(tree).map(label)).toEqual(['Keep Focusing', 'End Focus']);
  });

  it('locks while ending and shows a refusal from the service', () => {
    const busy = endTree({ step: 'type', typed: 'END', busy: true });
    expect(buttons(busy).every((b) => (b.props as { disabled?: boolean }).disabled)).toBe(true);
    expect(label(busy)).toContain('Ending…');
    expect(label(endTree({ step: 'type', error: 'Type END to end this Focus session.' }))).toContain('Type END to end this Focus session.');
  });

  it('asks without guilt', () => {
    const read = [label(endTree()), label(endTree({ step: 'type' }))].join(' ').toLowerCase();
    for (const phrase of ['give up', 'giving up', 'quit', 'fail', 'disappoint', 'really sure', 'weak']) expect(read).not.toContain(phrase);
  });
});

// ── Summary and widget ─────────────────────────────────────────────────────

describe('Focus summary', () => {
  const read = (s: FocusSummaryDto) => text(renderToStaticMarkup(<FocusSummaryModal summary={s} onClose={() => {}} />));

  it('a completed session: planned and active, nothing more', () => {
    expect(read(summary())).toBe('Focus complete Finish authentication 60 min planned 54 min active Deep Work Done');
  });

  it('an early end is factual', () => {
    const early = summary({ state: 'cancelled', endReason: 'ended-early', endedAt: iso(T0 + 17 * MIN), elapsedMs: 17 * MIN });
    expect(read(early)).toBe('Focus ended Finish authentication 17 min active 43 min remaining Deep Work Done');
    // The check mark is for a fulfilled commitment only.
    const mark = (s: FocusSummaryDto) => renderToStaticMarkup(<FocusSummaryModal summary={s} onClose={() => {}} />).includes('focus-summary-mark');
    expect(mark(summary())).toBe(true);
    expect(mark(early)).toBe(false);
  });

  it('carries no analytics even though the summary DTO has them', () => {
    const lower = read(summary()).toLowerCase();
    for (const word of [...ANALYTICS, 'pauses', '7', '3 ']) expect(lower).not.toContain(word);
  });
});

describe('Focus widget (other pages)', () => {
  it('shows the timer and task and only links back to Focus', () => {
    const onOpen = vi.fn();
    const markup = renderToStaticMarkup(<FocusWidget session={active()} onOpen={onOpen} />);
    expect(text(markup)).toBe('52:14 Finish authentication');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(text(renderToStaticMarkup(<FocusWidget session={active({ isRunning: false, pauseKind: 'manual' })} onOpen={onOpen} />))).toContain('Paused · Finish authentication');
  });
});
