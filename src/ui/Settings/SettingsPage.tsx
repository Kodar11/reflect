import { useState, type ReactNode } from 'react';
import { Download, Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, type Theme } from '../store/themeStore';
import { OnboardingFlow } from '../Onboarding/OnboardingFlow';
import { PersonalContextCard } from '../Onboarding/PersonalContextCard';
import type { UserProfile } from '../../profile/UserProfile';
import { APP_VERSION } from '../lib/version';
import { DailyReflectionSettings, TrackingSettings } from './BackgroundControls';
import { GeminiSettings } from './GeminiSettings';
import { ExportDialog } from './ExportDialog';
import { initialExportDraft, type ExportDraft } from './exportView';

/**
 * Settings: six sections, each answering one question, in order of how often
 * they matter — is Reflect running, when is my reflection written, is AI set
 * up, what does Reflect know about me, how does it look, and what data does it
 * keep. Every control saves immediately; nothing here is destructive.
 */
export function SettingsPage() {
  const [editingContext, setEditingContext] = useState<UserProfile | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // The export choices survive closing the dialog, for the rest of the visit.
  const [exportDraft, setExportDraft] = useState<ExportDraft>(() => initialExportDraft(new Date()));

  if (editingContext) {
    return <OnboardingFlow mode="edit" initialProfile={editingContext} onExit={() => setEditingContext(null)} />;
  }

  return (
    <div className="settings-page" style={{ animation: 'fadeIn 180ms var(--ease-out)' }}>
      <header>
        <h1 className="text-[28px] font-extrabold tracking-tight">Settings</h1>
        <p className="text-[14px] text-muted mt-1">How Reflect runs, what it knows about your work, and your data.</p>
      </header>

      <SettingsSection id="tracking" title="Tracking" description="Reflect notes the app, window title and website in front of you.">
        <TrackingSettings />
      </SettingsSection>

      <SettingsSection id="daily-reflection" title="Daily Reflection" description="When Reflect writes up your day, and how it tells you.">
        <DailyReflectionSettings />
      </SettingsSection>

      <SettingsSection id="ai" title="AI — Gemini" description="Reflections, the Coach and the AI timeline are written by Google Gemini, using your own API key.">
        <GeminiSettings />
      </SettingsSection>

      <SettingsSection id="personalization" title="Personalization" description="What Reflect knows about your work and priorities.">
        <PersonalContextCard onEdit={setEditingContext} />
      </SettingsSection>

      <SettingsSection id="appearance" title="Appearance">
        <div className="card">
          <div className="bg-row flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[15px] font-semibold">Theme</div>
              <p className="text-[13px] text-muted mt-0.5">System follows your Windows setting.</p>
            </div>
            <ThemeChoice />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="data" title="Data & Privacy" description="What Reflect stores, and how to take a copy of it.">
        <DataPrivacyCard onExport={() => setExportOpen(true)} />
      </SettingsSection>

      <p className="text-[12px] text-faint">Reflect {APP_VERSION}</p>

      {exportOpen && <ExportDialog initialDraft={exportDraft} onDraftChange={setExportDraft} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

export function SettingsSection(props: { id: string; title: string; description?: string; children: ReactNode }) {
  const headingId = `settings-${props.id}`;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section-head">
        <h2 id={headingId}>{props.title}</h2>
        {props.description && <p>{props.description}</p>}
      </div>
      {props.children}
    </section>
  );
}

const THEMES: { id: Theme; label: string; Icon: typeof Sun }[] = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
];

/** System / Light / Dark. Applies immediately. */
export function ThemeChoice() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ id, label, Icon }) => (
        <label key={id} className="seg-option seg-option-row" data-checked={theme === id}>
          <input type="radio" className="sr-only" name="theme" checked={theme === id} onChange={() => setTheme(id)} />
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

export function DataPrivacyCard({ onExport }: { onExport: () => void }) {
  return (
    <div className="card">
      <div className="bg-row">
        <dl className="settings-facts">
          <dt>Stored</dt>
          <dd>Your activity, Timeline, Focus sessions, reflections and settings are kept in a database on this computer. Reflect has no account and no server of its own.</dd>
          <dt>Shared</dt>
          <dd>
            Only when a Gemini key is set: app names, window titles and website addresses (with obvious secrets removed) and your personal context go to
            Google Gemini to write the AI timeline, reflections and the Coach.
          </dd>
          <dt>Hidden</dt>
          <dd>Events you hide on the Activity page are left out of everything Reflect shows, sends or exports.</dd>
        </dl>
      </div>
      <div className="bg-row flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">Export data</div>
          <p className="text-[13px] text-muted mt-0.5">
            Save your Timeline, activity, Focus sessions, reflections and settings as JSON or CSV — for any period or everything.
          </p>
        </div>
        <button type="button" className="btn btn-primary shrink-0" onClick={onExport}>
          <Download size={15} strokeWidth={2} aria-hidden /> Export data…
        </button>
      </div>
    </div>
  );
}
