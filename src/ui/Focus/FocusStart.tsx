import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { FocusBusy, UseFocusResult } from './useFocus';
import {
  DURATION_PRESETS,
  MAX_DURATION_MINUTES,
  MAX_TASK_LENGTH,
  blockingSetupView,
  customDurationProblem,
  formatDurationLabel,
  isBlockingStartFailure,
  parseCustomMinutes,
  pickDefaultProfile,
  presetBlockingLine,
  recentTasks,
  startProblem,
  type FocusMode,
} from './focusView';
import { FocusBehavior } from './FocusBehavior';
import { PresetPanel, newPreset } from './ProfileGrid';

export interface FocusStartViewProps {
  profiles: FocusProfileDto[];
  profileId: string | null;
  /** The preset Focus opens with. */
  defaultProfileId: string | null;
  task: string;
  mode: FocusMode;
  durationMinutes: number;
  /** True while the custom-duration field is shown. */
  customDuration: boolean;
  /** What is typed in the custom-duration field. */
  customText: string;
  notes: string;
  notesOpen: boolean;
  suggestions: string[];
  busy: FocusBusy | null;
  error: string | null;
  blockingResidue: boolean;
  /** Why the leftover blocking could not be removed automatically, when known. */
  blockingResidueDetail?: string | null;
  presetMenuOpen: boolean;
  presetMenuRef?: RefObject<HTMLDivElement>;
  /** False when this one session should run without the preset's blocking. */
  sessionBlocking: boolean;
  presetPanelOpen: boolean;
  /**
   * The selected preset's editor — name, default duration, what it blocks —
   * shown on the page while `presetPanelOpen`: beside the column when there
   * is room, under the preset when there is not.
   */
  presetPanel?: ReactNode;
  preferences: FocusPreferencesDto;
  behaviorOpen: boolean;
  onTaskChange: (task: string) => void;
  onSelectDuration: (minutes: number) => void;
  onSelectCustom: () => void;
  onSelectNoLimit: () => void;
  onCustomTextChange: (text: string) => void;
  onTogglePresetMenu: () => void;
  onSelectProfile: (id: string) => void;
  /** Open or close the selected preset's editor. */
  onTogglePresetPanel: () => void;
  onCreatePreset: () => void;
  /** Make the selected preset the one Focus opens with. */
  onMakeDefault: () => void;
  onToggleSessionBlocking: (on: boolean) => void;
  onToggleNotes: () => void;
  onNotesChange: (notes: string) => void;
  onToggleBehavior: () => void;
  onPreferenceChange: (patch: Partial<FocusPreferencesDto>) => void;
  onSubmit: () => void;
  /** Offered only after blocking could not be turned on. */
  onStartWithoutBlocking: () => void;
  onClearResidue: () => void;
}

/**
 * The task, the custom duration and Start belong to this form by id rather
 * than by nesting: the blocking editor shown inline has forms of its own,
 * and a form inside a form would submit the wrong one.
 */
const SETUP_FORM = 'focus-setup-form';

/** Arrow keys walk the options of the open preset menu. */
function onPresetMenuKey(e: KeyboardEvent<HTMLDivElement>) {
  const options = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  if (options.length === 0) return;
  const at = options.indexOf(document.activeElement as HTMLElement);
  const go = (index: number) => {
    e.preventDefault();
    options[(index + options.length) % options.length].focus();
  };
  if (e.key === 'ArrowDown') go(at + 1);
  else if (e.key === 'ArrowUp') go(at - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(options.length - 1);
}

/**
 * Focus setup, on one screen: what, how long, which preset and what it
 * blocks, then Start. Everything below Start is optional — a session takes a
 * task and one click. Shown only while no session is running.
 */
export function FocusStartView(props: FocusStartViewProps) {
  const { profiles, profileId, task, mode, durationMinutes, customDuration, customText, notes, notesOpen, suggestions, busy, error, blockingResidue } = props;
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const starting = busy === 'starting';
  const problem = startProblem({ task, mode, durationMinutes, profileId });
  const presetSelected = mode === 'countdown' && !customDuration && (DURATION_PRESETS as readonly number[]).includes(durationMinutes);
  const customShown = mode === 'countdown' && !presetSelected;
  const customProblem = customShown ? customDurationProblem(customText) : null;
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

  const blocking = profile ? blockingSetupView(profile, props.sessionBlocking) : null;
  const willBlock = Boolean(profile?.blocking.enabled && props.sessionBlocking);
  const isDefault = profile !== null && profile.id === props.defaultProfileId;

  return (
    <div className="focus-stage" data-layout="setup">
      <div className="focus-column" data-wide="true" data-editing={props.presetPanelOpen}>
        <form
          id={SETUP_FORM}
          hidden
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem && !starting) props.onSubmit();
          }}
        />
        {blockingResidue && (
          <div className="focus-note" data-tone="warn" role="status">
            Blocking from an earlier Focus session may still be active.{' '}
            <button type="button" className="focus-link" data-tone="accent" onClick={props.onClearResidue}>
              Remove it
            </button>
            {props.blockingResidueDetail && <div className="focus-hint" style={{ marginTop: 4 }}>{props.blockingResidueDetail}</div>}
          </div>
        )}

        <div>
          <label className="focus-heading" htmlFor="focus-task" style={{ display: 'block', marginBottom: 10 }}>
            What are you focusing on?
          </label>
          <input
            id="focus-task"
            form={SETUP_FORM}
            className="focus-input"
            data-size="lg"
            autoFocus
            type="text"
            value={task}
            maxLength={MAX_TASK_LENGTH}
            placeholder="Finish authentication"
            onChange={(e) => props.onTaskChange(e.target.value)}
            disabled={starting}
          />
          {suggestions.length > 0 && !task.trim() && (
            <div className="focus-chips" style={{ marginTop: 8 }}>
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
            <button type="button" className="focus-chip" aria-pressed={customShown} onClick={props.onSelectCustom} disabled={starting}>
              Custom
            </button>
            <button type="button" className="focus-chip" aria-pressed={mode === 'stopwatch'} onClick={props.onSelectNoLimit} disabled={starting}>
              No limit
            </button>
            {customShown && (
              <span className="focus-custom-duration">
                <input
                  className="focus-input"
                  data-size="sm"
                  form={SETUP_FORM}
                  type="text"
                  inputMode="numeric"
                  autoFocus={customDuration}
                  aria-label="Duration in minutes"
                  aria-invalid={customProblem !== null}
                  aria-describedby={customProblem ? 'focus-custom-problem' : undefined}
                  placeholder="50"
                  maxLength={5}
                  value={customText}
                  onChange={(e) => props.onCustomTextChange(e.target.value)}
                  disabled={starting}
                />
                <span className="focus-hint">minutes</span>
              </span>
            )}
          </div>
          {customProblem && <div id="focus-custom-problem" className="focus-field-problem" role="alert">{customProblem}</div>}
          {mode === 'stopwatch' && <div className="focus-hint" style={{ marginTop: 8 }}>Runs until you end it.</div>}
        </div>

        {profile && blocking && (
          <div className="focus-group">
            <div className="focus-group-row" ref={props.presetMenuRef} style={{ position: 'relative' }}>
              <div className="focus-label-row">
                <div className="focus-label" id="focus-preset-label">Preset</div>
                <span className="focus-label-actions">
                  {!isDefault && (
                    <button type="button" className="focus-link" onClick={props.onMakeDefault} disabled={starting} title="Open Focus with this preset from now on">
                      Set as default
                    </button>
                  )}
                  <button
                    type="button"
                    className="focus-link"
                    aria-expanded={props.presetPanelOpen}
                    aria-controls="focus-preset-panel"
                    onClick={props.onTogglePresetPanel}
                    disabled={starting}
                    title="Rename it, change its default duration or what it blocks"
                  >
                    {props.presetPanelOpen ? 'Done editing' : 'Edit preset'}
                  </button>
                </span>
              </div>
              <button
                type="button"
                className="focus-preset"
                aria-haspopup="listbox"
                aria-expanded={props.presetMenuOpen}
                aria-labelledby="focus-preset-label"
                onClick={props.onTogglePresetMenu}
                disabled={starting}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="focus-preset-name" title={profile.name}>
                    {profile.name}
                    {isDefault && <span className="focus-tag" style={{ marginLeft: 8 }}>Default</span>}
                  </div>
                  <div className="focus-preset-sub">{presetBlockingLine(profile)}</div>
                </div>
                <ChevronDown size={16} className="focus-chevron" aria-hidden="true" />
              </button>
              {props.presetMenuOpen && (
                <div className="focus-preset-list" role="listbox" aria-labelledby="focus-preset-label" onKeyDown={onPresetMenuKey}>
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      aria-selected={p.id === profile.id}
                      className="focus-preset-option"
                      onClick={() => props.onSelectProfile(p.id)}
                    >
                      <div className="focus-preset-name" title={p.name}>
                        {p.name}
                        {p.id === props.defaultProfileId && <span className="focus-tag" style={{ marginLeft: 8 }}>Default</span>}
                      </div>
                      {p.description && <div className="focus-preset-sub">{p.description}</div>}
                      <div className="focus-preset-sub">{presetBlockingLine(p)}</div>
                    </button>
                  ))}
                  <button type="button" className="focus-preset-option" data-action="true" onClick={props.onCreatePreset}>
                    <Plus size={14} aria-hidden="true" /> New preset
                  </button>
                </div>
              )}
            </div>

            <div className="focus-group-row">
              <div className="focus-blocking-row">
                <div style={{ minWidth: 0 }}>
                  <div className="focus-blocking-title">
                    <span className="focus-dot" data-tone={blocking.tone === 'ok' ? 'ok' : undefined} />
                    {blocking.title}
                  </div>
                  <div className="focus-preset-sub">{blocking.detail || 'This preset does not block any site or app yet.'}</div>
                </div>
                {blocking.canToggle && (
                  <label className="focus-inline-toggle" title="Applies to this session only; the preset is not changed">
                    <input
                      type="checkbox"
                      checked={props.sessionBlocking}
                      onChange={(e) => props.onToggleSessionBlocking(e.target.checked)}
                      disabled={starting}
                    />
                    <span>Block this session</span>
                  </label>
                )}
              </div>
              {!props.presetPanelOpen && (
                <button
                  type="button"
                  className="focus-link"
                  data-tone="accent"
                  aria-expanded={false}
                  aria-controls="focus-preset-panel"
                  onClick={props.onTogglePresetPanel}
                  disabled={starting}
                >
                  {blocking.canToggle ? 'Manage blocked sites and apps' : 'Choose what to block'}
                </button>
              )}
            </div>

            {props.presetPanelOpen && <div id="focus-preset-panel" className="focus-preset-panel-slot">{props.presetPanel}</div>}
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
                  <button type="submit" form={SETUP_FORM} className="focus-btn" data-fit="content" data-size="sm" disabled={Boolean(problem) || busy !== null}>
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
            <button
              type="submit"
              form={SETUP_FORM}
              className="focus-btn"
              data-variant="primary"
              data-size="lg"
              disabled={Boolean(problem) || busy !== null}
              aria-describedby={problem ? 'focus-start-hint' : undefined}
            >
              {starting ? 'Starting Focus…' : 'Start Focus'}
            </button>
          </div>
          {problem && !starting && (
            <div id="focus-start-hint" className="focus-hint" style={{ marginTop: 8, textAlign: 'center' }}>
              {problem}
            </div>
          )}
          {willBlock && starting && (
            <div className="focus-hint" style={{ marginTop: 8, textAlign: 'center' }}>
              Turning on blocking — approve the Windows prompt if it appears.
            </div>
          )}
        </div>

        <FocusBehavior
          preferences={props.preferences}
          open={props.behaviorOpen}
          onToggle={props.onToggleBehavior}
          onChange={props.onPreferenceChange}
        />
      </div>
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

const isDurationChip = (minutes: number) => (DURATION_PRESETS as readonly number[]).includes(minutes);

/** Whether "Focus behavior" was left open, for as long as the window lives. */
let behaviorOpenMemo = false;

/** Holds the draft and starts the session. */
export function FocusStart({ focus, prefill, onPrefillConsumed }: FocusStartProps) {
  const { profiles, preferences, busy, error, blockingResidue, blockingResidueDetail, start, clearBlockingResidue, clearError, getHistory, consumeIntent, intent, saveProfile, savePreferences } = focus;
  const defaultProfile = useMemo(() => pickDefaultProfile(profiles, preferences.defaultProfileId), [profiles, preferences.defaultProfileId]);

  const [profileId, setProfileId] = useState<string | null>(defaultProfile?.id ?? null);
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<FocusMode>(defaultProfile?.mode ?? 'countdown');
  const initialMinutes = defaultProfile?.defaultDurationMinutes ?? 25;
  const [durationMinutes, setDurationMinutes] = useState(initialMinutes);
  // A preset whose default is not one of the chips opens in the custom field.
  const [customDuration, setCustomDuration] = useState(!isDurationChip(initialMinutes));
  const [customText, setCustomText] = useState(isDurationChip(initialMinutes) ? '' : String(initialMinutes));
  const [notes, setNotes] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  /** The preset that was just created: its panel opens with the name ready to type over. */
  const [renamingPreset, setRenamingPreset] = useState<string | null>(null);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [sessionBlocking, setSessionBlocking] = useState(true);
  const [presetPanelOpen, setPresetPanelOpen] = useState(false);
  const [behaviorOpen, setBehaviorOpen] = useState(behaviorOpenMemo);
  const presetMenuRef = useRef<HTMLDivElement>(null);

  /** Take a duration as the session's; one that is not a chip shows in the custom field. */
  const applyDuration = (minutes: number) => {
    setMode('countdown');
    setDurationMinutes(minutes);
    setCustomDuration(!isDurationChip(minutes));
    setCustomText(isDurationChip(minutes) ? '' : String(minutes));
  };

  const applyProfile = (profile: FocusProfileDto) => {
    setProfileId(profile.id);
    setSessionBlocking(true);
    if (profile.mode === 'countdown' && profile.defaultDurationMinutes) applyDuration(profile.defaultDurationMinutes);
    else {
      setMode(profile.mode);
      setCustomDuration(false);
    }
  };

  // A preset whose default duration was just edited hands it to the draft, the
  // same as picking that preset again would.
  const selectedDefault = profiles.find((p) => p.id === profileId);
  const defaultKey = selectedDefault ? selectedDefault.id + ':' + selectedDefault.mode + ':' + selectedDefault.defaultDurationMinutes : '';
  const lastDefaultKey = useRef(defaultKey);
  useEffect(() => {
    if (lastDefaultKey.current === defaultKey) return;
    const [previousId] = lastDefaultKey.current.split(':');
    lastDefaultKey.current = defaultKey;
    if (!selectedDefault || previousId !== selectedDefault.id) return;
    if (selectedDefault.mode === 'countdown' && selectedDefault.defaultDurationMinutes) applyDuration(selectedDefault.defaultDurationMinutes);
    else {
      setMode(selectedDefault.mode);
      setCustomDuration(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultKey]);

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
    if (prefill.minutes) applyDuration(Math.min(MAX_DURATION_MINUTES, prefill.minutes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  // The preset menu closes on Escape or a click anywhere else, and opens with
  // the current preset focused so the arrow keys start from it.
  useEffect(() => {
    if (!presetMenuOpen) return;
    const root = presetMenuRef.current;
    root?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
    const onPointer = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) setPresetMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPresetMenuOpen(false);
      root?.querySelector<HTMLElement>('[aria-haspopup="listbox"]')?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [presetMenuOpen]);

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

  const selected = profiles.find((p) => p.id === profileId) ?? null;

  return (
    <>
      <FocusStartView
        profiles={profiles}
        profileId={profileId}
        defaultProfileId={defaultProfile?.id ?? null}
        task={task}
        mode={mode}
        durationMinutes={durationMinutes}
        customDuration={customDuration}
        customText={customText}
        notes={notes}
        notesOpen={notesOpen}
        suggestions={suggestions}
        busy={busy}
        error={error}
        blockingResidue={blockingResidue}
        blockingResidueDetail={blockingResidueDetail}
        presetMenuOpen={presetMenuOpen}
        presetMenuRef={presetMenuRef}
        sessionBlocking={sessionBlocking}
        presetPanelOpen={presetPanelOpen && selected !== null}
        presetPanel={
          presetPanelOpen && selected ? (
            <PresetPanel
              key={selected.id}
              focus={focus}
              profile={selected}
              renaming={renamingPreset === selected.id}
              onClose={() => {
                setPresetPanelOpen(false);
                setRenamingPreset(null);
              }}
            />
          ) : null
        }
        preferences={preferences}
        behaviorOpen={behaviorOpen}
        onTaskChange={(value) => {
          setTask(value);
          if (error) clearError();
        }}
        onSelectDuration={applyDuration}
        onSelectCustom={() => {
          // Nothing is assumed: the field starts empty and Start waits for a number.
          setMode('countdown');
          setCustomDuration(true);
          setCustomText('');
          setDurationMinutes(NaN);
        }}
        onSelectNoLimit={() => {
          setMode('stopwatch');
          setCustomDuration(false);
        }}
        onCustomTextChange={(text) => {
          setCustomDuration(true);
          setCustomText(text);
          setDurationMinutes(parseCustomMinutes(text));
        }}
        onTogglePresetMenu={() => setPresetMenuOpen((open) => !open)}
        onSelectProfile={(id) => {
          const next = profiles.find((p) => p.id === id);
          if (next) applyProfile(next);
          setPresetMenuOpen(false);
          if (error) clearError();
        }}
        onTogglePresetPanel={() => {
          setPresetPanelOpen((open) => !open);
          setRenamingPreset(null);
        }}
        onCreatePreset={() => {
          const preset = newPreset(profiles.length === 0 ? 'Deep Work' : undefined);
          setPresetMenuOpen(false);
          saveProfile(preset, []).then(() => {
            applyProfile(preset);
            setRenamingPreset(preset.id);
            setPresetPanelOpen(true);
          }, () => {});
        }}
        onMakeDefault={() => {
          if (profileId) void savePreferences({ ...preferences, defaultProfileId: profileId });
        }}
        onToggleSessionBlocking={setSessionBlocking}
        onToggleNotes={() => setNotesOpen(true)}
        onNotesChange={setNotes}
        onToggleBehavior={() => {
          behaviorOpenMemo = !behaviorOpen;
          setBehaviorOpen(behaviorOpenMemo);
        }}
        onPreferenceChange={(patch) => void savePreferences({ ...preferences, ...patch })}
        onSubmit={() => void begin(!sessionBlocking)}
        onStartWithoutBlocking={() => void begin(true)}
        onClearResidue={() => void clearBlockingResidue()}
      />
    </>
  );
}
