import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { UseFocusResult } from './useFocus';
import { DURATION_PRESETS, MAX_DURATION_MINUTES, formatDurationLabel } from './focusView';
import { BlockingEditor } from './BlockingEditor';

const EMPTY_BLOCKING = { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 };

/** A new preset with sensible defaults; the user refines it in the panel. */
export function newPreset(name = 'New preset'): FocusProfileDto {
  const now = new Date().toISOString();
  return {
    id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: null,
    isDefault: false,
    mode: 'countdown',
    defaultDurationMinutes: 25,
    blocksDistractions: false,
    soundCue: null,
    createdAt: now,
    updatedAt: now,
    rules: [],
    ruleIds: [],
    blocking: EMPTY_BLOCKING,
  };
}

interface PresetPanelProps {
  focus: UseFocusResult;
  profile: FocusProfileDto;
  /** Select the name for typing over — a preset that was just created. */
  renaming?: boolean;
  onClose: () => void;
}

/**
 * Edit one preset in place on the setup screen: name, default duration and
 * what it blocks. Every change applies immediately, so there is nothing to
 * save and nothing to lose. Changes affect the next Focus session, never one
 * that is running.
 */
export function PresetPanel({ focus, profile, renaming = false, onClose }: PresetPanelProps) {
  const { profiles, saveProfile, deleteProfile } = focus;
  const isChip = (DURATION_PRESETS as readonly number[]).includes(profile.defaultDurationMinutes ?? 25);
  const [name, setName] = useState(profile.name);
  const [custom, setCustom] = useState(String(profile.defaultDurationMinutes ?? 25));
  const [customOpen, setCustomOpen] = useState(profile.mode === 'countdown' && !isChip);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => {
    if (!renaming) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renaming, profile.id]);

  const patch = (changes: Partial<FocusProfileDto>) => {
    setError(null);
    saveProfile({ ...profile, ...changes }, null).catch((e) => setError((e as Error)?.message ?? String(e)));
  };

  const commitName = () => {
    const next = name.trim();
    if (!next) setName(profile.name);
    else if (next !== profile.name) patch({ name: next });
  };

  const commitCustom = () => {
    const n = Math.round(Number(custom));
    if (!Number.isFinite(n) || n < 1 || n > MAX_DURATION_MINUTES) {
      setCustom(String(profile.defaultDurationMinutes ?? 25));
      return;
    }
    if (n !== profile.defaultDurationMinutes || profile.mode !== 'countdown') patch({ mode: 'countdown', defaultDurationMinutes: n });
  };

  const remove = () => {
    if (!window.confirm(`Delete the preset "${profile.name}"?`)) return;
    deleteProfile(profile.id).then(onClose, (e) => setError((e as Error)?.message ?? String(e)));
  };

  const durationValue = profile.mode === 'stopwatch' ? 'none' : customOpen ? 'custom' : String(profile.defaultDurationMinutes ?? 25);
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };

  return (
    <div className="focus-preset-panel" role="region" aria-label={`Edit preset ${profile.name}`}>
      <div className="focus-preset-panel-head">
        <input
          ref={nameRef}
          className="focus-input"
          data-size="sm"
          value={name}
          maxLength={60}
          aria-label="Preset name"
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={blurOnEnter}
        />
        <button type="button" className="focus-btn" data-fit="content" data-size="sm" onClick={onClose}>
          Done
        </button>
      </div>

      {error && <div className="focus-note" data-tone="error" role="alert">{error}</div>}

      <div className="focus-prefs-row">
        <label htmlFor="focus-preset-duration">Default duration</label>
        <span className="focus-custom-duration">
          {durationValue === 'custom' && (
            <input
              className="focus-input"
              data-size="sm"
              type="text"
              inputMode="numeric"
              maxLength={5}
              aria-label="Default duration in minutes"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={commitCustom}
              onKeyDown={blurOnEnter}
            />
          )}
          <select
            id="focus-preset-duration"
            className="focus-input"
            value={durationValue}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'custom') {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              if (value === 'none') patch({ mode: 'stopwatch', defaultDurationMinutes: null });
              else patch({ mode: 'countdown', defaultDurationMinutes: Number(value) });
            }}
          >
            {DURATION_PRESETS.map((m) => (
              <option key={m} value={m}>{formatDurationLabel(m)}</option>
            ))}
            <option value="custom">Custom (minutes)</option>
            <option value="none">No limit</option>
          </select>
        </span>
      </div>

      <div>
        <div className="focus-panel-heading">Blocked during Focus</div>
        <BlockingEditor focus={focus} profile={profile} />
      </div>

      <div className="focus-preset-panel-foot">
        <span className="focus-hint">Saved as you go · applies from your next session.</span>
        {profiles.length > 1 && (
          <button type="button" className="focus-link" data-tone="danger" onClick={remove}>
            Delete preset
          </button>
        )}
      </div>
    </div>
  );
}
