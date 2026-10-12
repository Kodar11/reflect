import { ChevronDown } from 'lucide-react';
import { behaviorSummary, idleThresholdOptions } from './focusView';

export interface FocusBehaviorProps {
  preferences: FocusPreferencesDto;
  open: boolean;
  onToggle: () => void;
  /** Persist one or more changed settings. */
  onChange: (patch: Partial<FocusPreferencesDto>) => void;
}

/**
 * The settings that used to live on a separate Preferences tab: how Focus
 * behaves when you are away, what it tells you, and its shortcuts. Collapsed
 * to one line by default — nothing here is needed to start a session, and
 * none of it reaches a session that is already running.
 */
export function FocusBehavior({ preferences, open, onToggle, onChange }: FocusBehaviorProps) {
  return (
    <section className="focus-behavior" data-open={open}>
      <button type="button" className="focus-disclosure" aria-expanded={open} aria-controls="focus-behavior-panel" onClick={onToggle}>
        <span style={{ minWidth: 0 }}>
          <span className="focus-disclosure-title">Focus behavior</span>
          <span className="focus-disclosure-sub">{behaviorSummary(preferences)}</span>
        </span>
        <ChevronDown size={16} className="focus-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div id="focus-behavior-panel" className="focus-behavior-panel">
          <p className="focus-hint">Customize how Focus behaves. These settings apply to future sessions.</p>

          <div className="focus-behavior-group" role="group" aria-label="When you are away">
            <div className="focus-label">When you are away</div>
            <Toggle label="Pause the timer when I'm away" checked={preferences.idleAutoPause} onChange={(v) => onChange({ idleAutoPause: v })} />
            {preferences.idleAutoPause && (
              <>
                <div className="focus-prefs-row">
                  <label htmlFor="focus-idle-threshold">Away after</label>
                  <select
                    id="focus-idle-threshold"
                    className="focus-input"
                    value={preferences.idleThresholdSeconds}
                    onChange={(e) => onChange({ idleThresholdSeconds: Number(e.target.value) })}
                  >
                    {idleThresholdOptions(preferences.idleThresholdSeconds).map((t) => (
                      <option key={t.seconds} value={t.seconds}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <Toggle label="Resume when I'm back" checked={preferences.idleAutoResume} onChange={(v) => onChange({ idleAutoResume: v })} />
              </>
            )}
            <p className="focus-hint">Pausing stops the timer, not the session: blocking remains active while paused.</p>
          </div>

          <div className="focus-behavior-group" role="group" aria-label="Notifications">
            <div className="focus-label">Notify me when</div>
            <Toggle label="Focus starts" checked={preferences.notifyStart} onChange={(v) => onChange({ notifyStart: v })} />
            <Toggle label="Focus pauses or resumes because I was away" checked={preferences.notifyIdle} onChange={(v) => onChange({ notifyIdle: v })} />
            <Toggle label="Focus is complete" checked={preferences.notifyComplete} onChange={(v) => onChange({ notifyComplete: v })} />
            <Toggle label="A site or app is blocked" checked={preferences.notifyBlocked} onChange={(v) => onChange({ notifyBlocked: v })} />
          </div>

          <div className="focus-behavior-group" role="group" aria-label="Keyboard shortcuts">
            <div className="focus-label">Shortcuts</div>
            <div className="focus-prefs-row">
              <span>Open Focus</span>
              <span className="kbd">Ctrl+Shift+F</span>
            </div>
            <div className="focus-prefs-row">
              <span>Pause or resume, on this page</span>
              <span className="kbd">Space</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="focus-prefs-row" style={{ cursor: 'pointer' }}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16, accentColor: 'var(--accent)', flex: 'none' }}
      />
    </label>
  );
}
