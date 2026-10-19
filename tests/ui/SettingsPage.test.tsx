import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPage, ThemeChoice, DataPrivacyCard } from '../../src/ui/Settings/SettingsPage';
import { TrackingStatusView, DailyReflectionView } from '../../src/ui/Settings/BackgroundControls';
import { GeminiSettingsView, type GeminiSettingsViewProps } from '../../src/ui/Settings/GeminiSettings';
import { describeGeminiBadge } from '../../src/ui/Settings/geminiSettingsView';
import { PersonalContextView } from '../../src/ui/Onboarding/PersonalContextCard';
import { useThemeStore } from '../../src/ui/store/themeStore';
import { emptyProfile, type UserProfile } from '../../src/profile/UserProfile';

/**
 * Settings rendered for real (server-side, no DOM). Effects do not run, so
 * the data-loading sections show their placeholders; the presentational views
 * are rendered with explicit props. Clicks are simulated by invoking the
 * handlers on the element tree.
 */

type AnyElement = ReactElement<Record<string, any>>;
function elements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, out);
  else if (node && typeof node === 'object' && 'props' in (node as AnyElement)) {
    const el = node as AnyElement;
    out.push(el);
    elements(el.props.children, out);
    elements(el.props.control, out);
  }
  return out;
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const render = (el: ReactElement) => renderToStaticMarkup(el);

describe('Settings page', () => {
  it('renders the six sections in order of importance', () => {
    const html = render(<SettingsPage />);
    const headings = [...html.matchAll(/<h2 id="settings-[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1].replace('&amp;', '&'));
    expect(headings).toEqual(['Tracking', 'Daily Reflection', 'AI — Gemini', 'Personalization', 'Appearance', 'Data &amp; Privacy'.replace('&amp;', '&')]);
    expect(html).toContain('aria-labelledby="settings-tracking"');
    expect(text(html)).toContain('Export data…');
  });
});

describe('Tracking', () => {
  const running = { tracking: 'running' as const, pausedUntil: null, todayTrackedMs: (3 * 60 + 18) * 60_000 };

  it('shows that tracking is on, today’s total and a pause action', () => {
    const t = text(render(<TrackingStatusView status={running} busy={false} onPause={() => {}} onResume={() => {}} />));
    expect(t).toContain('Tracking is on');
    expect(t).toContain('3h 18m tracked today');
    expect(t).toContain('Pause tracking');
    expect(t).toContain('15 minutes');
    expect(t).toContain('Until tomorrow');
  });

  it('pausing keeps the existing durations: manual, 15m, 1h, tomorrow', () => {
    const onPause = vi.fn();
    const tree = TrackingStatusView({ status: running, busy: false, onPause, onResume: () => {} });
    for (const button of elements(tree).filter((e) => e.type === 'button')) button.props.onClick();
    expect(onPause.mock.calls.map((c) => c[0])).toEqual(['manual', '15m', '1h', 'tomorrow']);
  });

  it('when paused, offers Resume as the primary action', () => {
    const onResume = vi.fn();
    const tree = TrackingStatusView({ status: { ...running, tracking: 'paused' }, busy: false, onPause: () => {}, onResume });
    const resume = elements(tree).find((e) => e.type === 'button' && e.props.children === 'Resume tracking')!;
    expect(resume.props.className).toContain('btn-primary');
    resume.props.onClick();
    expect(onResume).toHaveBeenCalledOnce();
    expect(text(render(tree))).toContain('Paused');
  });

  it('disables actions while one is running', () => {
    const html = render(<TrackingStatusView status={running} busy onPause={() => {}} onResume={() => {}} />);
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });
});

describe('Daily Reflection', () => {
  const coach = { reflectionMinutes: 21 * 60 + 30, dayStartMinutes: 4 * 60, notifyDailyReflection: true };

  it('explains the schedule in plain language and shows the saved times', () => {
    const html = render(<DailyReflectionView coach={coach} notificationsEnabled onSave={() => {}} onNotifications={() => {}} />);
    expect(text(html)).toContain('Reflect prepares your daily reflection at this time, or the next time it runs if your computer is off.');
    expect(html).toContain('value="21:30"');
    expect(html).toContain('value="04:00"');
    expect(html).toContain('max="06:00"');
  });

  it('the reflection notification follows the master switch', () => {
    const html = render(<DailyReflectionView coach={coach} notificationsEnabled={false} onSave={() => {}} onNotifications={() => {}} />);
    expect(html).toMatch(/aria-checked="false" aria-label="Notify when the reflection is ready" class="switch" disabled=""/);
  });

  it('switches save through the existing settings calls', () => {
    const onSave = vi.fn();
    const onNotifications = vi.fn();
    const tree = DailyReflectionView({ coach, notificationsEnabled: true, onSave, onNotifications });
    const switches = elements(tree).filter((e) => typeof e.type === 'function' && e.props.label);
    switches.find((s) => s.props.label === 'Notifications')!.props.onChange(false);
    switches.find((s) => s.props.label === 'Notify when the reflection is ready')!.props.onChange(false);
    expect(onNotifications).toHaveBeenCalledWith(false);
    expect(onSave).toHaveBeenCalledWith({ notifyDailyReflection: false });
  });
});

describe('AI — Gemini', () => {
  const base: GeminiConfigStatusDto = { configured: true, source: 'stored', hasStoredKey: true, storedKeyUnreadable: false, canStore: true, model: 'gemini-2.5-flash' };
  const props = (overrides: Partial<GeminiSettingsViewProps> = {}): GeminiSettingsViewProps => ({
    status: base,
    keyInput: '',
    busy: null,
    notice: null,
    onKeyInput: () => {},
    onSave: () => {},
    onTest: () => {},
    onRemove: () => {},
    onOpenKeyPage: () => {},
    ...overrides,
  });

  it('distinguishes a key from the environment from one saved in Reflect', () => {
    expect(describeGeminiBadge({ ...base, source: 'environment' }).label).toBe('Environment variable');
    expect(describeGeminiBadge(base).label).toBe('Saved in Reflect');
    expect(describeGeminiBadge({ ...base, configured: false, source: null, hasStoredKey: false }).label).toBe('Not set up');
    expect(text(render(<GeminiSettingsView {...props({ status: { ...base, source: 'environment' } })} />))).toContain('GEMINI_API_KEY environment variable');
  });

  it('shows the model, where the key is stored and where it is sent — and never a key', () => {
    const html = render(<GeminiSettingsView {...props()} />);
    const t = text(html);
    expect(t).toContain('gemini-2.5-flash');
    expect(t).toContain('encrypted by Windows');
    expect(t).toContain('Google Gemini');
    expect(t).toContain('aistudio.google.com/apikey');
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
  });

  it('labels each action with its own loading state', () => {
    expect(text(render(<GeminiSettingsView {...props({ busy: 'test' })} />))).toContain('Testing…');
    expect(text(render(<GeminiSettingsView {...props({ busy: 'save', keyInput: 'x' })} />))).toContain('Checking…');
    expect(text(render(<GeminiSettingsView {...props({ busy: 'remove' })} />))).toContain('Removing…');
  });

  it('shows success and failure notices with the right roles', () => {
    expect(render(<GeminiSettingsView {...props({ notice: { tone: 'ok', text: 'Gemini accepted the key' } })} />)).toContain('role="status"');
    expect(render(<GeminiSettingsView {...props({ notice: { tone: 'error', text: 'Refused' } })} />)).toContain('role="alert"');
  });

  it('offers Test only when a key is configured, and the link opens through the main process', () => {
    const onOpenKeyPage = vi.fn();
    const off = text(render(<GeminiSettingsView {...props({ status: { ...base, configured: false, source: null, hasStoredKey: false } })} />));
    expect(off).not.toContain('Test connection');
    const tree = GeminiSettingsView(props({ onOpenKeyPage }));
    elements(tree).find((e) => e.props.className === 'settings-link mt-2')!.props.onClick();
    expect(onOpenKeyPage).toHaveBeenCalledOnce();
  });
});

describe('Personalization', () => {
  const profile: UserProfile = {
    ...emptyProfile(),
    roles: ['Student', 'Software Developer'],
    currentWork: ['Reflect', 'Thesis', 'Job search', 'Gym'],
    priorities: ['Finish my degree'],
    onboardingStatus: 'completed',
  };

  it('summarises the saved context compactly and offers Edit', () => {
    const onEdit = vi.fn();
    const tree = PersonalContextView({ profile, onEdit });
    const t = text(render(tree));
    expect(t).toContain('Student · Software Developer');
    expect(t).toContain('Reflect · Thesis · Job search +1');
    expect(t).toContain('Finish my degree');
    const edit = elements(tree).find((e) => e.type === 'button')!;
    expect(edit.props.children).toBe('Edit');
    edit.props.onClick();
    expect(onEdit).toHaveBeenCalledWith(profile);
  });

  it('invites setting it up when empty', () => {
    expect(text(render(<PersonalContextView profile={emptyProfile()} onEdit={() => {}} />))).toContain('Set up');
  });
});

describe('Appearance', () => {
  it('a labelled System / Light / Dark choice that applies immediately', () => {
    useThemeStore.setState({ theme: 'dark' });
    const html = render(<ThemeChoice />);
    expect(text(html)).toBe('System Light Dark');
    expect(html.match(/type="radio"/g)?.length).toBe(3);
    expect(html).toMatch(/data-checked="true"><input type="radio" class="sr-only" name="theme" checked=""\/>.*Dark/);
    useThemeStore.setState({ theme: 'system' });
  });
});

describe('Data & Privacy', () => {
  it('explains local storage accurately and offers one export action', () => {
    const onExport = vi.fn();
    const tree = DataPrivacyCard({ onExport });
    const t = text(render(tree));
    expect(t).toContain('database on this computer');
    expect(t).toContain('Only when a Gemini key is set');
    const buttons = elements(tree).filter((e) => e.type === 'button');
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick();
    expect(onExport).toHaveBeenCalledOnce();
  });
});
