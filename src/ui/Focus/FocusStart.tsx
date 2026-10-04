import { useEffect, useMemo, useState } from 'react';
import type { FocusBusy, UseFocusResult } from './useFocus';
import {
  DURATION_PRESETS,
  MAX_DURATION_MINUTES,
  MAX_TASK_LENGTH,
  blockingCounts,
  formatDurationLabel,
  isBlockingStartFailure,
  pickDefaultProfile,
  recentTasks,
  startProblem,
  type FocusMode,
} from './focusView';
import { PresetEditor, newPreset } from './ProfileGrid';

export interface FocusStartViewProps {
  profiles: FocusProfileDto[];
  profileId: string | null;
  task: string;
  mode: FocusMode;
  durationMinutes: number;
  /** True while the custom-duration field is shown. */
  customDuration: boolean;
  notes: string;
  notesOpen: boolean;
  suggestions: string[];
  busy: FocusBusy | null;
  error: string | null;
  blockingResidue: boolean;
  onTaskChange: (task: string) => void;
  onSelectDuration: (minutes: number) => void;
  onSelectCustom: () => void;
  onSelectNoLimit: () => void;
  onCustomDurationChange: (minutes: number) => void;
  onSelectProfile: (id: string) => void;
  /** Open the selected preset's blocking editor. */
  onEditBlocking: () => void;
  onCreatePreset: () => void;
  onToggleNotes: () => void;
  onNotesChange: (notes: string) => void;
  onSubmit: () => void;
  /** Offered only after blocking could not be turned on. */
  onStartWithoutBlocking: () => void;
  onClearResidue: () => void;
}

/**
 * The start screen: what, how long, which preset, start. The preset supplies
 * the duration and the blocking, so starting takes a task and one click.
 */
export function FocusStartView(props: FocusStartViewProps) {
  const { profiles, profileId, task, mode, durationMinutes, customDuration, notes, notesOpen, suggestions, busy, error, blockingResidue } = props;
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const starting = busy === 'starting';
  const problem = startProblem({ task, mode, durationMinutes, profileId });
  const presetSelected = mode === 'countdown' && !customDuration && (DURATION_PRESETS as readonly number[]).includes(durationMinutes);
  const blockingFailed = isBlockingStartFailure(error);

  if (profiles.length === 0) {
    return (
      <div className="focus-stage">
        <div className="focus-column" data-align="center">
          <div className="focus-heading">Create your first Focus preset</div>
          <div className="focus-dialog-body">A preset remembers how long you focus and what gets blocked, so starting takes one click.</div>
          <div className="focus-actions" style={{ maxWidth: 260 }}>
            <button type="button" className="focus-btn" data-variant="primary" data-size="lg" onClick={props.onCreatePreset}>
              Create preset
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="focus-stage">
      <form
        className="focus-column"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !starting) props.onSubmit();
        }}
      >
        {blockingResidue && (
          <div className="focus-note" data-tone="warn">
            Blocking from an earlier Focus session is still in place.{' '}
            <button type="button" className="focus-link" data-tone="accent" onClick={props.onClearResidue}>
              Remove it
            </button>
          </div>
        )}

        <div>
          <label className="focus-heading" htmlFor="focus-task" style={{ display: 'block', marginBottom: 12 }}>
            What are you focusing on?
          </label>
          <input
            id="focus-task"
            className="focus-input"
            autoFocus
            type="text"
            value={task}
            maxLength={MAX_TASK_LENGTH}
            placeholder="Finish authentication"
            onChange={(e) => props.onTaskChange(e.target.value)}
            disabled={starting}
          />
          {suggestions.length > 0 && !task.trim() && (
            <div className="focus-chips" style={{ marginTop: 10 }}>
              {suggestions.map((s) => (
                <button key={s} type="button" className="focus-chip" data-quiet="true" title={s} onClick={() => props.onTaskChange(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="focus-label">Duration</div>
          <div className="focus-chips">
            {DURATION_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className="focus-chip"
                aria-pressed={presetSelected && durationMinutes === m}
                onClick={() => props.onSelectDuration(m)}
                disabled={starting}
              >
                {formatDurationLabel(m)}
              </button>
            ))}
            <button type="button" className="focus-chip" aria-pressed={mode === 'countdown' && !presetSelected} onClick={props.onSelectCustom} disabled={starting}>
              Custom
            </button>
            <button type="button" className="focus-chip" aria-pressed={mode === 'stopwatch'} onClick={props.onSelectNoLimit} disabled={starting}>
              No limit
            </button>
          </div>
          {mode === 'countdown' && !presetSelected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <input
                className="focus-input"
                data-size="sm"
                style={{ width: 96 }}
                type="number"
                min={1}
                max={MAX_DURATION_MINUTES}
                step={1}
                aria-label="Duration in minutes"
                value={Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : ''}
                onChange={(e) => props.onCustomDurationChange(Math.round(Number(e.target.value)))}
                disabled={starting}
              />
              <span className="focus-hint">minutes</span>
            </div>
          )}
          {mode === 'stopwatch' && <div className="focus-hint" style={{ marginTop: 8 }}>Runs until you end it.</div>}
        </div>

        {profile && (
          <div>
            <div className="focus-label">Preset</div>
            {profiles.length > 1 && (
              <div className="focus-chips" role="radiogroup" aria-label="Preset" style={{ marginBottom: 10 }}>
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === profile.id}
                    aria-pressed={p.id === profile.id}
                    className="focus-chip"
                    data-truncate="true"
                    title={p.name}
                    onClick={() => props.onSelectProfile(p.id)}
                    disabled={starting}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="focus-preset" onClick={props.onEditBlocking} disabled={starting} title="See or change what this preset blocks">
              <div style={{ minWidth: 0 }}>
                <div className="focus-preset-name" title={profile.name}>{profile.name}</div>
                <div className="focus-preset-sub">
                  <span className="focus-dot" data-tone={profile.blocking.enabled ? 'ok' : undefined} style={{ display: 'inline-block', marginRight: 7 }} />
                  {profile.blocking.enabled ? `Blocking: ${blockingCounts(profile)}` : 'Nothing is blocked'}
                </div>
              </div>
              <span className="focus-link" data-tone="accent" style={{ flex: 'none' }}>
                {profile.blocking.enabled ? 'What’s blocked' : 'Choose what to block'}
              </span>
            </button>
          </div>
        )}

        {notesOpen ? (
          <div>
            <label className="focus-label" htmlFor="focus-notes">Note (optional)</label>
            <textarea
              id="focus-notes"
              className="focus-input"
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => props.onNotesChange(e.target.value)}
              disabled={starting}
            />
          </div>
        ) : (
          <div>
            <button type="button" className="focus-link" onClick={props.onToggleNotes}>
              + Add note
            </button>
          </div>
        )}

        {error && (
          <div className="focus-note" data-tone="error" role="alert">
            {blockingFailed ? (
              <>
                <strong>Couldn’t turn on blocking.</strong> {error.replace(/\s*Focus was not started\.$/, '')}
                <div className="focus-note-actions">
                  <button type="submit" className="focus-btn" data-fit="content" data-size="sm" disabled={Boolean(problem) || busy !== null}>
                    Try again
                  </button>
                  <button type="button" className="focus-btn" data-fit="content" data-size="sm" disabled={Boolean(problem) || busy !== null} onClick={props.onStartWithoutBlocking}>
                    Start without blocking
                  </button>
                </div>
              </>
            ) : (
              error
            )}
          </div>
        )}

        <div>
          <div className="focus-actions">
            <button type="submit" className="focus-btn" data-variant="primary" data-size="lg" disabled={Boolean(problem) || busy !== null}>
              {starting ? 'Starting Focus…' : 'Start Focus'}
            </button>
          </div>
          {profile?.blocking.enabled && starting && (
            <div className="focus-hint" style={{ marginTop: 8, textAlign: 'center' }}>
              Turning on blocking — approve the Windows prompt if it appears.
            </div>
          )}
        </div>
      </form>
    </div>
  );
}

/** A session set up on behalf of a coach recommendation. */
export interface FocusPrefill {
  task: string;
  minutes: number | null;
  /** The coach action this session carries out. */
  actionId: string | null;
  /** Makes repeated requests distinct. */
  nonce: number;
}

interface FocusStartProps {
  focus: UseFocusResult;
  prefill?: FocusPrefill | null;
  onPrefillConsumed?: () => void;
}

/** Holds the draft and starts the session. */
export function FocusStart({ focus, prefill, onPrefillConsumed }: FocusStartProps) {
  const { profiles, preferences, busy, error, blockingResidue, start, clearBlockingResidue, clearError, getHistory, consumeIntent, intent, saveProfile } = focus;
  const defaultProfile = useMemo(() => pickDefaultProfile(profiles, preferences.defaultProfileId), [profiles, preferences.defaultProfileId]);

  const [profileId, setProfileId] = useState<string | null>(defaultProfile?.id ?? null);
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<FocusMode>(defaultProfile?.mode ?? 'countdown');
  const [durationMinutes, setDurationMinutes] = useState(defaultProfile?.defaultDurationMinutes ?? 25);
  const [customDuration, setCustomDuration] = useState(false);
  const [notes, setNotes] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [editingPreset, setEditingPreset] = useState<string | null>(null);

  const applyProfile = (profile: FocusProfileDto) => {
    setProfileId(profile.id);
    setMode(profile.mode);
    setCustomDuration(false);
    if (profile.defaultDurationMinutes) setDurationMinutes(profile.defaultDurationMinutes);
  };

  // Follow the default preset until the user has picked one that still exists.
  useEffect(() => {
    if (profiles.some((p) => p.id === profileId)) return;
    if (defaultProfile) applyProfile(defaultProfile);
    else setProfileId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, defaultProfile]);

  useEffect(() => {
    let cancelled = false;
    getHistory(15)
      .then((sessions) => {
        if (!cancelled) setSuggestions(recentTasks(sessions, 2));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [getHistory]);

  // A tray intent with nothing running just means "open Focus".
  useEffect(() => {
    if (intent) consumeIntent();
  }, [intent, consumeIntent]);

  // Opened from a coach recommendation: what and how long are already decided.
  useEffect(() => {
    if (!prefill) return;
    setTask(prefill.task.slice(0, MAX_TASK_LENGTH));
    if (prefill.minutes) {
      setMode('countdown');
      setDurationMinutes(Math.min(MAX_DURATION_MINUTES, prefill.minutes));
      setCustomDuration(!(DURATION_PRESETS as readonly number[]).includes(prefill.minutes));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const begin = async (withoutBlocking: boolean) => {
    if (!profileId) return;
    const started = await start({
      profileId,
      task: task.trim(),
      notes: notes.trim() || null,
      mode,
      plannedDurationMinutes: mode === 'countdown' ? durationMinutes : null,
      withoutBlocking,
    });
    // The session that just started is the execution of that recommendation;
    // the main process links them so its outcome becomes the evidence.
    if (started && prefill?.actionId) {
      window.coach.linkFocus(prefill.actionId).catch((e) => console.error('[FocusStart] could not link the coach action', e));
      onPrefillConsumed?.();
    }
  };

  const editing = profiles.find((p) => p.id === editingPreset) ?? null;

  return (
    <>
      <FocusStartView
        profiles={profiles}
        profileId={profileId}
        task={task}
        mode={mode}
        durationMinutes={durationMinutes}
        customDuration={customDuration}
        notes={notes}
        notesOpen={notesOpen}
        suggestions={suggestions}
        busy={busy}
        error={error}
        blockingResidue={blockingResidue}
        onTaskChange={(value) => {
          setTask(value);
          if (error) clearError();
        }}
        onSelectDuration={(minutes) => {
          setMode('countdown');
          setCustomDuration(false);
          setDurationMinutes(minutes);
        }}
        onSelectCustom={() => {
          setMode('countdown');
          setCustomDuration(true);
        }}
        onSelectNoLimit={() => {
          setMode('stopwatch');
          setCustomDuration(false);
        }}
        onCustomDurationChange={setDurationMinutes}
        onSelectProfile={(id) => {
          const next = profiles.find((p) => p.id === id);
          if (next) applyProfile(next);
          if (error) clearError();
        }}
        onEditBlocking={() => setEditingPreset(profileId)}
        onCreatePreset={() => {
          const preset = newPreset('Deep Work');
          saveProfile(preset, []).then(() => setEditingPreset(preset.id), () => {});
        }}
        onToggleNotes={() => setNotesOpen(true)}
        onNotesChange={setNotes}
        onSubmit={() => void begin(false)}
        onStartWithoutBlocking={() => void begin(true)}
        onClearResidue={() => void clearBlockingResidue()}
      />
      {editing && <PresetEditor focus={focus} profile={editing} onClose={() => setEditingPreset(null)} />}
    </>
  );
}
