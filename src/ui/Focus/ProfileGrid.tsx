import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { UseFocusResult } from './useFocus';
import { DURATION_PRESETS, MAX_DURATION_MINUTES, blockingCounts, formatDurationLabel, profileSummary } from './focusView';
import { BlockingEditor } from './BlockingEditor';
import { useDialog } from './useDialog';

const EMPTY_BLOCKING = { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 };

/** A new preset with sensible defaults; the user refines it in the editor. */
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

interface PresetListProps {
  focus: UseFocusResult;
  /** Make this the preset Focus opens with, and go there. */
  onUse: (profileId: string) => void;
}

/** Presets as compact cards: what it is, how long, what it blocks. */
export function PresetList({ focus, onUse }: PresetListProps) {
  const { profiles, preferences, saveProfile } = focus;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editing = profiles.find((p) => p.id === editingId) ?? null;

  const create = async () => {
    const preset = newPreset();
    setError(null);
    try {
      await saveProfile(preset, []);
      setEditingId(preset.id);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 className="focus-prefs-title">Presets</h2>
        <button type="button" className="focus-btn" data-fit="content" data-size="sm" onClick={() => void create()}>
          <Plus size={14} /> New preset
        </button>
      </div>
      {error && <div className="focus-note" data-tone="error">{error}</div>}
      {profiles.length === 0 ? (
        <div className="focus-hint">No presets yet. A preset remembers a duration and what to block.</div>
      ) : (
        <div className="focus-preset-cards">
          {profiles.map((profile) => {
            const isDefault = (preferences.defaultProfileId ?? profiles.find((p) => p.isDefault)?.id) === profile.id;
            return (
              <div key={profile.id} className="focus-preset-card">
                <div style={{ minWidth: 0 }}>
                  <div className="focus-preset-name" title={profile.name}>
                    {profile.name}
                    {isDefault && <span className="focus-tag" style={{ marginLeft: 8 }}>Default</span>}
                  </div>
                  <div className="focus-preset-sub">{profileSummary(profile)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  <button type="button" className="focus-btn" data-fit="content" data-size="sm" onClick={() => onUse(profile.id)}>
                    Use
                  </button>
                  <button type="button" className="focus-btn" data-fit="content" data-size="sm" onClick={() => setEditingId(profile.id)}>
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && <PresetEditor focus={focus} profile={editing} onClose={() => setEditingId(null)} />}
    </>
  );
}

interface PresetEditorProps {
  focus: UseFocusResult;
  profile: FocusProfileDto;
  onClose: () => void;
}

/**
 * Edit one preset: name → duration → what it blocks. Every change applies
 * immediately, so there is nothing to save and nothing to lose. Changes
 * affect the next Focus session, never one that is running.
 */
export function PresetEditor({ focus, profile, onClose }: PresetEditorProps) {
  const { profiles, saveProfile, deleteProfile } = focus;
  const [name, setName] = useState(profile.name);
  const [custom, setCustom] = useState(String(profile.defaultDurationMinutes ?? 25));
  const [customOpen, setCustomOpen] = useState(
    profile.mode === 'countdown' && !(DURATION_PRESETS as readonly number[]).includes(profile.defaultDurationMinutes ?? 25),
  );
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useDialog(panelRef, close);

  useEffect(() => setName(profile.name), [profile.name]);

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

  const presetDuration = profile.mode === 'countdown' && !customOpen ? profile.defaultDurationMinutes : null;

  return (
    <div
      className="focus-drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className="focus-drawer" role="dialog" aria-modal="true" aria-label={`Edit preset ${profile.name}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            className="focus-input focus-title-input"
            value={name}
            maxLength={60}
            aria-label="Preset name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <button type="button" className="focus-icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {error && <div className="focus-note" data-tone="error">{error}</div>}

        <section>
          <div className="focus-label">Duration</div>
          <div className="focus-chips">
            {DURATION_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className="focus-chip"
                aria-pressed={presetDuration === m}
                onClick={() => {
                  setCustomOpen(false);
                  patch({ mode: 'countdown', defaultDurationMinutes: m });
                }}
              >
                {formatDurationLabel(m)}
              </button>
            ))}
            <button type="button" className="focus-chip" aria-pressed={profile.mode === 'countdown' && customOpen} onClick={() => setCustomOpen(true)}>
              Custom
            </button>
            <button
              type="button"
              className="focus-chip"
              aria-pressed={profile.mode === 'stopwatch'}
              onClick={() => {
                setCustomOpen(false);
                patch({ mode: 'stopwatch', defaultDurationMinutes: null });
              }}
            >
              No limit
            </button>
          </div>
          {customOpen && profile.mode !== 'stopwatch' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <input
                className="focus-input"
                data-size="sm"
                style={{ width: 96 }}
                type="number"
                min={1}
                max={MAX_DURATION_MINUTES}
                aria-label="Duration in minutes"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onBlur={commitCustom}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
              <span className="focus-hint">minutes</span>
            </div>
          )}
        </section>

        <section>
          <div className="focus-section-title">Blocking</div>
          <BlockingEditor focus={focus} profile={profile} />
        </section>

        <div className="focus-actions" style={{ marginTop: 'auto', paddingTop: 8 }}>
          {profiles.length > 1 && (
            <button type="button" className="focus-btn" data-variant="quiet" data-fit="content" onClick={remove}>
              Delete preset
            </button>
          )}
          <button type="button" className="focus-btn" data-variant="primary" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="focus-hint">{blockingCounts(profile)} · changes apply to your next Focus session.</div>
      </div>
    </div>
  );
}
