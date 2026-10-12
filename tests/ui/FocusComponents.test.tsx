import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EndFocusDialogView, type EndFocusDialogViewProps } from '../../src/ui/Focus/EndFocusDialog';
import { FocusActiveView, type FocusActiveViewProps } from '../../src/ui/Focus/FocusActive';
import { FocusPage } from '../../src/ui/Focus/FocusPage';
import { FocusStartView, type FocusStartViewProps } from '../../src/ui/Focus/FocusStart';
import { FocusSummaryModal } from '../../src/ui/Focus/FocusSummaryModal';
import { FocusWidget } from '../../src/ui/Focus/FocusWidget';
import type { UseFocusResult } from '../../src/ui/Focus/useFocus';
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

// ── Setup ──────────────────────────────────────────────────────────────────

const PREFERENCES: FocusPreferencesDto = {
  defaultProfileId: null,
  idleAutoPause: true,
  idleThresholdSeconds: 120,
  idleAutoResume: true,
  notifyStart: false,
  notifyIdle: true,
  notifyComplete: true,
  notifyBlocked: true,
};

function startProps(overrides: Partial<FocusStartViewProps> = {}): FocusStartViewProps {
  return {
    profiles: [profile()],
    profileId: 'profile-1',
    defaultProfileId: 'profile-1',
    task: '',
    mode: 'countdown',
    durationMinutes: 60,
    customDuration: false,
    customText: '',
    notes: '',
    notesOpen: false,
    suggestions: [],
    busy: null,
    error: null,
    blockingResidue: false,
    presetMenuOpen: false,
    sessionBlocking: true,
    presetPanelOpen: false,
    presetPanel: null,
    preferences: PREFERENCES,
    behaviorOpen: false,
    onTaskChange: vi.fn(),
    onSelectDuration: vi.fn(),
    onSelectCustom: vi.fn(),
    onSelectNoLimit: vi.fn(),
    onCustomTextChange: vi.fn(),
    onTogglePresetMenu: vi.fn(),
    onSelectProfile: vi.fn(),
    onTogglePresetPanel: vi.fn(),
    onCreatePreset: vi.fn(),
    onMakeDefault: vi.fn(),
    onToggleSessionBlocking: vi.fn(),
    onStartWithoutBlocking: vi.fn(),
    onToggleNotes: vi.fn(),
    onNotesChange: vi.fn(),
    onToggleBehavior: vi.fn(),
    onPreferenceChange: vi.fn(),
    onSubmit: vi.fn(),
    onClearResidue: vi.fn(),
    ...overrides,
  };
}

const startTree = (overrides: Partial<FocusStartViewProps> = {}) => FocusStartView(startProps(overrides)) as ReactElement;
const startText = (overrides: Partial<FocusStartViewProps> = {}) => text(renderToStaticMarkup(<FocusStartView {...startProps(overrides)} />));
const checkboxes = (tree: ReactElement) =>
  findAll(tree, (el) => el.type === 'input' && (el.props as { type?: string }).type === 'checkbox') as ReactElement<{ checked: boolean; disabled?: boolean; onChange: (e: unknown) => void }>[];
/** The checkbox inside the `<label>` that reads `name`. */
const toggle = (tree: ReactElement, name: string) => {
  const row = findAll(tree, (el) => el.type === 'label').find((l) => label(l) === name);
  if (!row) throw new Error(`no toggle "${name}"`);
  return checkboxes(row)[0];
};
const customField = (tree: ReactElement) =>
  findAll(tree, (el) => el.type === 'input' && (el.props as { 'aria-label'?: string })['aria-label'] === 'Duration in minutes') as ReactElement<{ value: string; onChange: (e: unknown) => void; 'aria-invalid'?: boolean }>[];

describe('Focus setup screen', () => {
  it('shows task, duration, preset, blocking and Start — in that order, with preferences last', () => {
    const read = startText();
    expect(read).toContain('What are you focusing on?');
    expect(read).toContain('Deep Work');
    expect(read).toContain('Blocking enabled · 38 sites · 4 apps');
    expect(read).toContain('5 rules · 38 websites · 4 applications');
    expect(read).toContain('Manage blocked sites and apps');
    expect(read).toContain('Start Focus');
    for (const preset of ['25 min', '30 min', '45 min', '1 hr', '1 hr 30 min', '2 hr', 'Custom', 'No limit']) expect(read).toContain(preset);
    for (const word of ANALYTICS) expect(read.toLowerCase()).not.toContain(word);
    // Notes stay out of the way until asked for.
    expect(renderToStaticMarkup(<FocusStartView {...startProps()} />)).not.toContain('<textarea');
    expect(read).toContain('+ Add note');
    const order = ['What are you focusing on?', 'Duration', 'Preset', 'Manage blocked sites and apps', '+ Add note', 'Start Focus', 'Focus behavior'].map((t) => read.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    for (const word of ['lease', 'rule pool', 'stopwatch', 'profile rule']) expect(read.toLowerCase()).not.toContain(word);
  });

  it('has no Focus / Preferences tabs', () => {
    const markup = renderToStaticMarkup(<FocusStartView {...startProps()} />);
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tablist"');
    expect(text(markup)).not.toContain('Preferences');
  });

  it('preselects the profile\'s default duration', () => {
    const pressed = buttons(startTree()).filter((b) => (b.props as { 'aria-pressed'?: boolean })['aria-pressed']);
    expect(pressed.map(label)).toEqual(['1 hr']);
  });

  it('cannot start without a task — and says why — and can with one', () => {
    expect(button(startTree(), 'Start Focus').props.disabled).toBe(true);
    expect(startText()).toContain('Enter what you are focusing on.');
    expect(button(startTree({ task: '   ' }), 'Start Focus').props.disabled).toBe(true);
    expect(button(startTree({ task: 'Finish authentication' }), 'Start Focus').props.disabled).toBe(false);
    expect(startText({ task: 'Finish authentication' })).not.toContain('Enter what you are focusing on.');
  });

  it('starts with nothing optional touched: no note, no menu, no preferences open', () => {
    const props = startProps({ task: 'Finish authentication' });
    const tree = FocusStartView(props) as ReactElement;
    expect(findAll(tree, (el) => el.type === 'textarea')).toHaveLength(0);
    expect(findAll(tree, (el) => (el.props as { role?: string }).role === 'option')).toHaveLength(0);
    expect(label(tree)).not.toContain('Notify me when');
    expect(button(tree, 'Start Focus').props.disabled).toBe(false);
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
    expect(submit({ task: 'x', durationMinutes: 0, customDuration: true, customText: '0' })).not.toHaveBeenCalled();
    expect(submit({ task: 'x', durationMinutes: NaN, customDuration: true, customText: '' })).not.toHaveBeenCalled();
    expect(submit({ task: 'Finish authentication', busy: 'starting' })).not.toHaveBeenCalled();
  });

  it('shows a clear in-progress state and blocks double starts', () => {
    const tree = startTree({ task: 'Finish authentication', busy: 'starting' });
    expect(button(tree, 'Starting Focus…').props.disabled).toBe(true);
    expect(startText({ task: 'x', busy: 'starting' })).toContain('approve the Windows prompt');
    const inputs = findAll(tree, (el) => el.type === 'input') as ReactElement<{ disabled?: boolean }>[];
    expect(inputs.every((i) => i.props.disabled)).toBe(true);
    // Nothing that changes the draft is clickable while the session is being created.
    for (const name of ['25 min', 'Custom', 'No limit', 'Edit preset', 'Manage blocked sites and apps']) {
      expect(button(tree, name).props.disabled).toBe(true);
    }
    // Without blocking there is no Windows prompt to mention.
    expect(startText({ task: 'x', busy: 'starting', sessionBlocking: false })).not.toContain('approve the Windows prompt');
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

  it('shows the custom field inline for Custom, and for a preset default that is not a chip', () => {
    expect(customField(startTree())).toHaveLength(0);
    expect(customField(startTree({ customDuration: true, durationMinutes: NaN }))).toHaveLength(1);
    const fifty = startTree({ durationMinutes: 50, customDuration: true, customText: '50' });
    expect(customField(fifty)[0].props.value).toBe('50');
    expect(button(fifty, 'Custom').props['aria-pressed']).toBe(true);
    // Typing goes straight to the draft; nothing opens.
    const props = startProps({ customDuration: true, durationMinutes: NaN });
    customField(FocusStartView(props) as ReactElement)[0].props.onChange({ target: { value: '75' } });
    expect(props.onCustomTextChange).toHaveBeenCalledWith('75');
  });

  it('a newly chosen Custom duration is empty — never an accidental short session', () => {
    const tree = startTree({ task: 'Finish authentication', customDuration: true, customText: '', durationMinutes: NaN });
    expect(customField(tree)[0].props.value).toBe('');
    expect(button(tree, 'Start Focus').props.disabled).toBe(true);
    expect(label(tree)).toContain('Choose a duration between 1 and 720 minutes.');
    // Nothing has been typed yet, so there is nothing to call an error.
    expect(findAll(tree, (el) => (el.props as { id?: string }).id === 'focus-custom-problem')).toHaveLength(0);
  });

  it.each([
    ['0', NaN],
    ['-5', NaN],
    ['12.5', NaN],
    ['abc', NaN],
    ['721', 721],
  ])('rejects a custom duration of "%s" inline and keeps Start disabled', (typed, minutes) => {
    const tree = startTree({ task: 'Finish authentication', customDuration: true, customText: typed, durationMinutes: typed === '0' ? 0 : minutes });
    expect(label(tree)).toContain('Enter a whole number of minutes between 1 and 720.');
    expect(customField(tree)[0].props['aria-invalid']).toBe(true);
    expect(button(tree, 'Start Focus').props.disabled).toBe(true);
  });

  it('accepts a valid custom duration', () => {
    const tree = startTree({ task: 'Finish authentication', customDuration: true, customText: '50', durationMinutes: 50 });
    expect(label(tree)).not.toContain('Enter a whole number');
    expect(button(tree, 'Start Focus').props.disabled).toBe(false);
  });

  it('a stopwatch has no planned end', () => {
    const read = startText({ mode: 'stopwatch' });
    expect(read).toContain('Runs until you end it.');
    expect(button(startTree({ mode: 'stopwatch' }), 'No limit').props['aria-pressed']).toBe(true);
    expect(customField(startTree({ mode: 'stopwatch' }))).toHaveLength(0);
  });

  it('with no presets, offers to create the first one instead of a broken form', () => {
    const props = startProps({ profiles: [], profileId: null, defaultProfileId: null });
    const tree = FocusStartView(props) as ReactElement;
    expect(label(tree)).toContain('Create your first Focus preset');
    expect(label(tree)).not.toContain('Start Focus');
    expect(findAll(tree, (el) => el.type === 'select' || el.type === 'input')).toHaveLength(0);
    button(tree, 'Create preset').props.onClick?.();
    expect(props.onCreatePreset).toHaveBeenCalled();
  });

  it('shows the current preset, marks the default, and keeps the menu closed until asked', () => {
    const props = startProps();
    const tree = FocusStartView(props) as ReactElement;
    const picker = findAll(tree, (el) => (el.props as { 'aria-haspopup'?: string })['aria-haspopup'] === 'listbox')[0] as ReactElement<{ onClick: () => void; 'aria-expanded': boolean }>;
    expect(label(picker)).toBe('Deep Work Default Blocking enabled · 38 sites · 4 apps');
    expect(picker.props['aria-expanded']).toBe(false);
    expect(findAll(tree, (el) => (el.props as { role?: string }).role === 'listbox')).toHaveLength(0);
    picker.props.onClick();
    expect(props.onTogglePresetMenu).toHaveBeenCalledTimes(1);
  });

  it('the preset menu lists every preset with its blocking, and switches in one click', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      profile({
        id: `p${i}`,
        name: `Preset ${i}`,
        isDefault: i === 0,
        description: i === 2 ? 'For long writing days' : null,
        blocking: i === 4 ? { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } : { enabled: true, ruleCount: 5, siteCount: 84, appCount: 3 },
      }),
    );
    const props = startProps({ profiles: many, profileId: 'p3', defaultProfileId: 'p0', presetMenuOpen: true });
    const tree = FocusStartView(props) as ReactElement;
    const options = findAll(tree, (el) => (el.props as { role?: string }).role === 'option') as ReactElement<{ onClick: () => void; 'aria-selected': boolean }>[];
    expect(options).toHaveLength(6);
    expect(options.filter((o) => o.props['aria-selected']).map(label)).toEqual(['Preset 3 Blocking enabled · 84 sites · 3 apps']);
    expect(label(options[0])).toBe('Preset 0 Default Blocking enabled · 84 sites · 3 apps');
    expect(label(options[2])).toContain('For long writing days');
    expect(label(options[4])).toBe('Preset 4 No blocking');
    options[5].props.onClick();
    expect(props.onSelectProfile).toHaveBeenCalledWith('p5');
    // Choosing a preset is not the same as making it the default.
    expect(props.onMakeDefault).not.toHaveBeenCalled();
    expect(props.onPreferenceChange).not.toHaveBeenCalled();
  });

  it('preset management stays one click away: new, edit, set as default', () => {
    const other = profile({ id: 'p2', name: 'Writing', isDefault: false });
    const props = startProps({ profiles: [profile(), other], profileId: 'p2', presetMenuOpen: true });
    const tree = FocusStartView(props) as ReactElement;
    button(tree, 'New preset').props.onClick?.();
    expect(props.onCreatePreset).toHaveBeenCalledTimes(1);
    button(tree, 'Edit preset').props.onClick?.();
    expect(props.onTogglePresetPanel).toHaveBeenCalledTimes(1);
    button(tree, 'Set as default').props.onClick?.();
    expect(props.onMakeDefault).toHaveBeenCalledTimes(1);
    // The default preset does not offer to become the default again.
    expect(buttons(startTree()).map(label)).not.toContain('Set as default');
  });

  it('blocking can be switched off for one session without touching the preset', () => {
    const props = startProps();
    const tree = FocusStartView(props) as ReactElement;
    const box = toggle(tree, 'Block this session');
    expect(box.props.checked).toBe(true);
    box.props.onChange({ target: { checked: false } });
    expect(props.onToggleSessionBlocking).toHaveBeenCalledWith(false);
    expect(props.onPreferenceChange).not.toHaveBeenCalled();

    const off = startText({ sessionBlocking: false });
    expect(off).toContain('Blocking off for this session');
    // What the preset holds is still shown, so switching back on is no surprise.
    expect(off).toContain('5 rules · 38 websites · 4 applications');
  });

  it('edits the preset on the page — one panel, no drawer or dialog over it', () => {
    const props = startProps();
    const closed = FocusStartView(props) as ReactElement;
    const manage = button(closed, 'Manage blocked sites and apps');
    expect((manage.props as { 'aria-expanded'?: boolean })['aria-expanded']).toBe(false);
    manage.props.onClick?.();
    button(closed, 'Edit preset').props.onClick?.();
    // Both ways in lead to the same panel.
    expect(props.onTogglePresetPanel).toHaveBeenCalledTimes(2);
    expect(label(closed)).not.toContain('EDITOR');
    expect(renderToStaticMarkup(<FocusStartView {...startProps()} />)).not.toContain('data-editing="true"');

    const openProps = startProps({ presetPanelOpen: true, presetPanel: <div>EDITOR</div> });
    const markup = renderToStaticMarkup(<FocusStartView {...openProps} />);
    const open = text(markup);
    expect(open).toContain('EDITOR');
    // It is part of the setup column, inside the preset group — not an overlay.
    expect(markup).toContain('data-editing="true"');
    expect(markup).toMatch(/<div id="focus-preset-panel" class="focus-preset-panel-slot"><div>EDITOR<\/div><\/div><\/div>/);
    for (const overlay of ['role="dialog"', 'aria-modal', 'focus-drawer', 'focus-overlay']) expect(markup).not.toContain(overlay);
    // The link that opened it becomes the way to close it; there is one of each, not two.
    const tree = FocusStartView(openProps) as ReactElement;
    expect(buttons(tree).map(label)).not.toContain('Manage blocked sites and apps');
    button(tree, 'Done editing').props.onClick?.();
    expect(openProps.onTogglePresetPanel).toHaveBeenCalledTimes(1);
    // Start is still on the page, and the session's own switch still works beside the editor.
    expect(open).toContain('Start Focus');
    expect(open).toContain('Block this session');
  });

  it('a preset that blocks nothing leads straight to choosing what to block', () => {
    const off = profile({ name: 'New preset', isDefault: false, blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } });
    const props = startProps({ profiles: [off], defaultProfileId: null });
    button(FocusStartView(props) as ReactElement, 'Choose what to block').props.onClick?.();
    expect(props.onTogglePresetPanel).toHaveBeenCalledTimes(1);
  });

  it('never nests the blocking editor\'s forms inside the setup form', () => {
    // A form inside a form submits the wrong one: adding a site must not start Focus.
    const markup = renderToStaticMarkup(
      <FocusStartView {...startProps({ task: 'Finish authentication', presetPanelOpen: true, presetPanel: <form id="inner"><input name="site" /></form> })} />,
    );
    expect(markup).toContain('<form id="focus-setup-form" hidden=""></form>');
    expect(markup.match(/<form/g)).toHaveLength(2);
    // The task field and Start still belong to the setup form, so Enter starts Focus.
    expect(markup).toMatch(/<input id="focus-task" form="focus-setup-form"/);
    expect(markup).toMatch(/<button type="submit" form="focus-setup-form"[^>]*>Start Focus/);
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
    // The draft is still there to try again with.
    expect((findAll(tree, (el) => (el.props as { id?: string }).id === 'focus-task')[0].props as { value: string }).value).toBe('Finish authentication');
    // An ordinary error offers no such thing.
    expect(startText({ task: 'x', error: 'A Focus session is already running.' })).not.toContain('Start without blocking');
  });

  it('says so when the preset blocks nothing', () => {
    const off = profile({ blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } });
    const tree = startTree({ profiles: [off] });
    const read = label(tree);
    expect(read).toContain('Nothing is blocked');
    expect(read).toContain('No blocking');
    expect(read).toContain('Choose what to block');
    // Nothing to switch off for one session.
    expect(findAll(tree, (el) => el.type === 'label').map(label)).not.toContain('Block this session');
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

  it('notes are optional and open on request', () => {
    const props = startProps({ task: 'Finish authentication' });
    button(FocusStartView(props) as ReactElement, '+ Add note').props.onClick?.();
    expect(props.onToggleNotes).toHaveBeenCalled();
    const open = startTree({ task: 'Finish authentication', notesOpen: true });
    expect(findAll(open, (el) => el.type === 'textarea')).toHaveLength(1);
    expect(button(open, 'Start Focus').props.disabled).toBe(false); // an empty note never blocks a start
  });

  it('shows errors, and leftover blocking only when the service reports it — with the reason', () => {
    expect(startText({ error: 'A Focus session is already running.' })).toContain('A Focus session is already running.');
    expect(startText()).not.toContain('earlier Focus session');

    const props = startProps({ blockingResidue: true, blockingResidueDetail: 'Reflect could not change the hosts file.' });
    const tree = FocusStartView(props) as ReactElement;
    expect(label(tree)).toContain('Blocking from an earlier Focus session may still be active.');
    expect(label(tree)).toContain('Reflect could not change the hosts file.');
    button(tree, 'Remove it').props.onClick?.();
    expect(props.onClearResidue).toHaveBeenCalled();
  });
});

describe('Focus behavior (the former Preferences tab)', () => {
  const NOTIFICATIONS = ['Focus starts', 'Focus pauses or resumes because I was away', 'Focus is complete', 'A site or app is blocked'];

  it('is one summarized line until expanded', () => {
    const props = startProps();
    const tree = FocusStartView(props) as ReactElement;
    const read = label(tree);
    expect(read).toContain('Focus behavior');
    expect(read).toContain('Pauses after 2 minutes away · 3 of 4 notifications on');
    for (const name of [...NOTIFICATIONS, 'Away after', 'Ctrl+Shift+F']) expect(read).not.toContain(name);
    const disclosure = button(tree, /^Focus behavior/);
    expect((disclosure.props as { 'aria-expanded'?: boolean })['aria-expanded']).toBe(false);
    disclosure.props.onClick?.();
    expect(props.onToggleBehavior).toHaveBeenCalledTimes(1);
  });

  it('expanded: idle, notifications and shortcuts — all of the old tab', () => {
    const tree = startTree({ behaviorOpen: true });
    const read = label(tree);
    expect((button(tree, /^Focus behavior/).props as { 'aria-expanded'?: boolean })['aria-expanded']).toBe(true);
    for (const name of ["Pause the timer when I'm away", 'Away after', "Resume when I'm back", ...NOTIFICATIONS]) expect(read).toContain(name);
    expect(read).toContain('blocking remains active while paused');
    expect(read).toContain('These settings apply to future sessions.');
    expect(read).toContain('Ctrl+Shift+F');
    expect(read).toContain('Space');
    // It comes after Start, so it never pushes the primary action down.
    expect(read.indexOf('Start Focus')).toBeLessThan(read.indexOf('Notify me when'));
  });

  it('reflects the saved values', () => {
    const tree = startTree({ behaviorOpen: true, preferences: { ...PREFERENCES, notifyStart: true, notifyBlocked: false, idleThresholdSeconds: 600 } });
    expect(NOTIFICATIONS.map((n) => toggle(tree, n).props.checked)).toEqual([true, true, true, false]);
    const select = findAll(tree, (el) => el.type === 'select')[0] as ReactElement<{ value: number }>;
    expect(select.props.value).toBe(600);
    const options = findAll(select, (el) => el.type === 'option').map(label);
    expect(options).toEqual(['1 minute', '2 minutes', '3 minutes', '5 minutes', '10 minutes', '15 minutes']);
  });

  it('keeps a stored threshold that is not one of the choices', () => {
    const tree = startTree({ behaviorOpen: true, preferences: { ...PREFERENCES, idleThresholdSeconds: 45 } });
    expect(findAll(tree, (el) => el.type === 'option').map(label)).toContain('45 seconds');
  });

  it('shows the idle options only while idle pausing is on', () => {
    const off = startTree({ behaviorOpen: true, preferences: { ...PREFERENCES, idleAutoPause: false } });
    expect(findAll(off, (el) => el.type === 'select')).toHaveLength(0);
    expect(label(off)).not.toContain("Resume when I'm back");
    expect(label(off)).not.toContain('Away after');
    expect(toggle(off, "Pause the timer when I'm away").props.checked).toBe(false);
    expect(startText({ preferences: { ...PREFERENCES, idleAutoPause: false } })).toContain('Keeps running while you are away');
  });

  it('every control saves just the setting it changed', () => {
    const props = startProps({ behaviorOpen: true });
    const tree = FocusStartView(props) as ReactElement;
    const change = props.onPreferenceChange as ReturnType<typeof vi.fn>;

    toggle(tree, "Pause the timer when I'm away").props.onChange({ target: { checked: false } });
    expect(change).toHaveBeenLastCalledWith({ idleAutoPause: false });
    toggle(tree, "Resume when I'm back").props.onChange({ target: { checked: false } });
    expect(change).toHaveBeenLastCalledWith({ idleAutoResume: false });
    (findAll(tree, (el) => el.type === 'select')[0] as ReactElement<{ onChange: (e: unknown) => void }>).props.onChange({ target: { value: '300' } });
    expect(change).toHaveBeenLastCalledWith({ idleThresholdSeconds: 300 });

    const keys = ['notifyStart', 'notifyIdle', 'notifyComplete', 'notifyBlocked'] as const;
    NOTIFICATIONS.forEach((name, i) => {
      const box = toggle(tree, name);
      box.props.onChange({ target: { checked: !box.props.checked } });
      expect(change).toHaveBeenLastCalledWith({ [keys[i]]: !PREFERENCES[keys[i]] });
    });
    // Changing a preference never starts anything or touches the draft.
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onSelectProfile).not.toHaveBeenCalled();
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

// ── The page: one state at a time ──────────────────────────────────────────

function fakeFocus(overrides: Partial<UseFocusResult> = {}): UseFocusResult {
  const never = vi.fn(async () => undefined as never);
  return {
    ready: true,
    profiles: [profile()],
    rules: [],
    preferences: PREFERENCES,
    activeSession: null,
    summary: null,
    dismissSummary: vi.fn(),
    showSummaryFor: never,
    busy: null,
    error: null,
    clearError: vi.fn(),
    blockingResidue: false,
    blockingResidueDetail: null,
    clearBlockingResidue: never,
    intent: null,
    consumeIntent: vi.fn(),
    requestIntent: vi.fn(),
    refresh: never,
    start: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    requestEnd: vi.fn(async () => null),
    confirmEnd: vi.fn(async () => null),
    restoreBlocking: never,
    savePreferences: never,
    blockingOptions: null,
    loadBlockingOptions: never,
    addBlock: vi.fn(async () => null),
    setProfileBlock: never,
    saveProfile: never,
    deleteProfile: never,
    saveRule: never,
    deleteRule: never,
    getSessionsByRange: vi.fn(async () => []),
    getSessionsForDay: vi.fn(async () => []),
    getHistory: vi.fn(async () => []),
    getSessionSummary: vi.fn(async () => null),
    ...overrides,
  };
}

const SETUP_ONLY = [
  'What are you focusing on?',
  'Duration',
  'Custom',
  'No limit',
  'Preset',
  'Set as default',
  'Edit preset',
  'Manage blocked sites and apps',
  'Block this session',
  '+ Add note',
  'Start Focus',
  'Focus behavior',
  'Notify me when',
  "Pause the timer when I'm away",
];

describe('Focus page', () => {
  const page = (focus: UseFocusResult) => renderToStaticMarkup(<FocusPage focus={focus} />);

  it('with nothing running shows setup, under one quiet header and no tabs', () => {
    const markup = page(fakeFocus());
    const read = text(markup);
    expect(read.startsWith('Focus What are you focusing on?')).toBe(true);
    for (const part of ['Duration', 'Preset', 'Manage blocked sites and apps', 'Start Focus', 'Focus behavior']) expect(read).toContain(part);
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tablist"');
    expect(read).not.toContain('Preferences');
    // The active screen is not there at the same time.
    expect(markup).not.toContain('focus-clock');
    expect(read).not.toContain('End Focus');
  });

  it('while a session runs shows only that session: every setup control is gone', () => {
    const markup = page(fakeFocus({ activeSession: active() }));
    const read = text(markup);
    expect(read).toBe('Focus Focusing Finish authentication 52:14 remaining Deep Work Blocking active Pause End Focus');
    for (const part of SETUP_ONLY) expect(read).not.toContain(part);
    for (const tag of ['<input', '<select', '<textarea', '<form', 'role="listbox"', 'role="tab"']) expect(markup).not.toContain(tag);
  });

  it('a paused session is still the active screen, not setup', () => {
    const paused = active({ isRunning: false, pauseKind: 'manual' }, { state: 'paused', pausedAt: iso(T0 + 5 * MIN), elapsedMs: 5 * MIN });
    const read = text(page(fakeFocus({ activeSession: paused })));
    expect(read).toContain('Paused');
    expect(read).toContain('Resume');
    for (const part of SETUP_ONLY) expect(read).not.toContain(part);
  });

  it('renders nothing half-populated before the first load', () => {
    const read = text(page(fakeFocus({ ready: false })));
    expect(read).toBe('Focus');
  });

  it('the active screen is unchanged by the merge: same markup as the view on its own', () => {
    const inPage = page(fakeFocus({ activeSession: active() }));
    const alone = renderToStaticMarkup(<FocusActiveView {...activeProps()} />);
    expect(inPage).toContain(alone);
  });

  it('holds together across themes and narrow windows: sizes and colours come from tokens, rows wrap', () => {
    const markup = page(fakeFocus());
    // No colour is hard-coded in the setup markup — every theme restyles it through variables.
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(markup).toContain('data-layout="setup"');
    expect(markup).toContain('class="focus-chips"');
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
