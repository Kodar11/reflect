import { useState } from 'react';
import type { UseFocusResult } from './useFocus';
import { MAX_DURATION_MINUTES, blockingCounts, pickDefaultProfile } from './focusView';
import { PresetEditor, PresetList } from './ProfileGrid';

const IDLE_THRESHOLDS = [
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 180, label: '3 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 900, label: '15 minutes' },
];

interface FocusPreferencesProps {
  focus: UseFocusResult;
  /** Called after "Use" on a preset: go back to the Focus start screen. */
  onUsePreset: () => void;
}

/**
 * Persistent Focus configuration, most important first: the default preset
 * and what it blocks, then the presets, then the quieter settings. Not
 * reachable while a session is running.
 */
export function FocusPreferences({ focus, onUsePreset }: FocusPreferencesProps) {
  const { profiles, preferences, savePreferences, saveProfile } = focus;
  const defaultProfile = pickDefaultProfile(profiles, preferences.defaultProfileId);
  const update = (patch: Partial<FocusPreferencesDto>) => void savePreferences({ ...preferences, ...patch });
  const [editingBlocking, setEditingBlocking] = useState(false);

  const thresholds = IDLE_THRESHOLDS.some((t) => t.seconds === preferences.idleThresholdSeconds)
    ? IDLE_THRESHOLDS
    : [...IDLE_THRESHOLDS, { seconds: preferences.idleThresholdSeconds, label: `${preferences.idleThresholdSeconds} seconds` }];

  return (
    <div className="focus-prefs">
      <section className="focus-prefs-section">
        <h2 className="focus-prefs-title">Default</h2>
        <div className="focus-prefs-row">
          <label htmlFor="focus-default-profile">Default preset</label>
          <select
            id="focus-default-profile"
            className="focus-input"
            value={defaultProfile?.id ?? ''}
            onChange={(e) => update({ defaultProfileId: e.target.value || null })}
            disabled={profiles.length === 0}
          >
            {profiles.length === 0 && <option value="">No presets</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="focus-prefs-row" aria-disabled={!defaultProfile || defaultProfile.mode !== 'countdown'}>
          <label htmlFor="focus-default-duration">Default duration</label>
          {defaultProfile && defaultProfile.mode === 'countdown' ? (
            <DurationField
              key={`${defaultProfile.id}:${defaultProfile.defaultDurationMinutes}`}
              id="focus-default-duration"
              minutes={defaultProfile.defaultDurationMinutes ?? 25}
              onCommit={(minutes) => void saveProfile({ ...defaultProfile, defaultDurationMinutes: minutes }, null).catch(() => {})}
            />
          ) : (
            <span className="focus-hint">{defaultProfile ? 'No time limit' : '—'}</span>
          )}
        </div>
        {defaultProfile && (
          <div className="focus-prefs-row">
            <div>
              <div>Blocking</div>
              <div className="focus-hint">{blockingCounts(defaultProfile)}</div>
            </div>
            <button type="button" className="focus-btn" data-fit="content" data-size="sm" onClick={() => setEditingBlocking(true)}>
              Manage blocked websites &amp; apps
            </button>
          </div>
        )}
      </section>

      <section className="focus-prefs-section">
        <PresetList
          focus={focus}
          onUse={(id) => {
            update({ defaultProfileId: id });
            onUsePreset();
          }}
        />
      </section>

      <section className="focus-prefs-section">
        <h2 className="focus-prefs-title">Idle</h2>
        <Toggle label="Pause the timer when I'm away" checked={preferences.idleAutoPause} onChange={(v) => update({ idleAutoPause: v })} />
        <div className="focus-prefs-row" aria-disabled={!preferences.idleAutoPause}>
          <label htmlFor="focus-idle-threshold">Away after</label>
          <select
            id="focus-idle-threshold"
            className="focus-input"
            value={preferences.idleThresholdSeconds}
            disabled={!preferences.idleAutoPause}
            onChange={(e) => update({ idleThresholdSeconds: Number(e.target.value) })}
          >
            {thresholds.map((t) => (
              <option key={t.seconds} value={t.seconds}>{t.label}</option>
            ))}
          </select>
        </div>
        <Toggle
          label="Resume when I'm back"
          checked={preferences.idleAutoResume}
          disabled={!preferences.idleAutoPause}
          onChange={(v) => update({ idleAutoResume: v })}
        />
        <p className="focus-hint">Blocking remains active while the timer is paused.</p>
      </section>

      <section className="focus-prefs-section">
        <h2 className="focus-prefs-title">Notifications</h2>
        <Toggle label="Focus started" checked={preferences.notifyStart} onChange={(v) => update({ notifyStart: v })} />
        <Toggle label="Paused or resumed when idle" checked={preferences.notifyIdle} onChange={(v) => update({ notifyIdle: v })} />
        <Toggle label="Focus complete" checked={preferences.notifyComplete} onChange={(v) => update({ notifyComplete: v })} />
        <Toggle label="A site or app was blocked" checked={preferences.notifyBlocked} onChange={(v) => update({ notifyBlocked: v })} />
      </section>

      <p className="focus-hint">
        <span className="kbd">Ctrl+Shift+F</span> opens Focus. On the Focus page, <span className="kbd">Space</span> pauses or resumes.
      </p>

      {editingBlocking && defaultProfile && <PresetEditor focus={focus} profile={defaultProfile} onClose={() => setEditingBlocking(false)} />}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="focus-prefs-row" aria-disabled={disabled} style={{ cursor: disabled ? 'default' : 'pointer' }}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16, accentColor: 'var(--accent)', flex: 'none' }}
      />
    </label>
  );
}

/** Commits on blur / Enter so a half-typed number is never saved. */
function DurationField({ id, minutes, onCommit }: { id: string; minutes: number; onCommit: (minutes: number) => void }) {
  const [value, setValue] = useState(String(minutes));
  const commit = () => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > MAX_DURATION_MINUTES) {
      setValue(String(minutes));
      return;
    }
    if (n !== minutes) onCommit(n);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
      <input
        id={id}
        className="focus-input"
        data-size="sm"
        style={{ width: 96 }}
        type="number"
        min={1}
        max={MAX_DURATION_MINUTES}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="focus-hint">minutes</span>
    </div>
  );
}
