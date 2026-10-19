import { useEffect, useState, type ReactNode } from 'react';
import { formatPauseEnd, formatTrackedDuration } from '../../background/statusFormat';
import { MAX_DAY_START_MINUTES } from '../../coach/CoachModels';
import { useBackgroundSettings, useBackgroundStatus } from '../hooks/useBackground';
import { minutesToTimeInput, timeInputToMinutes } from '../Reflection/coachView';

/**
 * The background controls: tracking, start with Windows, the floating widget
 * and notifications. Onboarding shows them as four switches
 * (`BackgroundControls`); Settings splits them into the Tracking and Daily
 * Reflection sections (`TrackingSettings`, `DailyReflectionSettings`).
 *
 * None of them decides anything. Every control asks the main process, which
 * owns the setting and reports back what is now true.
 */

const PAUSE_CHOICES: { label: string; duration: PauseDurationDto }[] = [
  { label: '15 minutes', duration: '15m' },
  { label: '1 hour', duration: '1h' },
  { label: 'Until tomorrow', duration: 'tomorrow' },
];

function useRunner() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.error('[background] action failed', e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Onboarding: the four background switches. */
export function BackgroundControls(_props: { variant: 'onboarding' }) {
  const status = useBackgroundStatus();
  const { settings, update } = useBackgroundSettings(status?.widgetVisible);
  const { busy, run } = useRunner();

  if (!status || !settings) return <div className="card" style={{ minHeight: 120 }} aria-busy="true" />;
  const paused = status.tracking === 'paused';

  return (
    <div className="card">
      <ControlRow
        title="Tracking"
        detail={
          paused
            ? status.pausedUntil
              ? `Paused until ${formatPauseEnd(status.pausedUntil)}. Nothing is being recorded.`
              : 'Off. Nothing is recorded until you turn it back on.'
            : 'Notes the app, window title and website in front of you.'
        }
        control={
          <Switch
            label="Tracking"
            checked={!paused}
            disabled={busy}
            onChange={(on) => run(() => (on ? window.background.resumeTracking() : window.background.pauseTracking('manual')))}
          />
        }
      />
      <StartupRow settings={settings} update={update} />
      <WidgetRow settings={settings} update={update} />
      <NotificationsRow settings={settings} update={update} />
    </div>
  );
}

// ── Settings: Tracking ─────────────────────────────────────────────────────

export interface TrackingStatusViewProps {
  status: Pick<BackgroundStatusDto, 'tracking' | 'pausedUntil' | 'todayTrackedMs'>;
  busy: boolean;
  onPause: (duration: PauseDurationDto) => void;
  onResume: () => void;
}

/** Is Reflect recording right now, and the one action that changes it. */
export function TrackingStatusView({ status, busy, onPause, onResume }: TrackingStatusViewProps) {
  const paused = status.tracking === 'paused';
  return (
    <div className="bg-row">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="status-dot" data-state={paused ? 'paused' : 'running'} aria-hidden />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold" role="status">
              {paused ? (status.pausedUntil ? `Paused until ${formatPauseEnd(status.pausedUntil)}` : 'Paused') : 'Tracking is on'}
            </div>
            <p className="text-[13px] text-muted mt-0.5">
              {formatTrackedDuration(status.todayTrackedMs)} tracked today
              {paused ? ' · nothing is being recorded' : ' · runs in the background, even with this window closed'}
            </p>
          </div>
        </div>
        {paused ? (
          <button type="button" className="btn btn-primary shrink-0" disabled={busy} onClick={onResume}>
            Resume tracking
          </button>
        ) : (
          <button type="button" className="btn bg-control shrink-0" disabled={busy} onClick={() => onPause('manual')}>
            Pause tracking
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        <span className="text-[12.5px] text-muted mr-1">{paused ? 'Pause instead for' : 'Or pause for'}</span>
        {PAUSE_CHOICES.map((choice) => (
          <button key={choice.duration} type="button" className="btn btn-ghost bg-control" disabled={busy} onClick={() => onPause(choice.duration)}>
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TrackingSettings() {
  const status = useBackgroundStatus();
  const { settings, update } = useBackgroundSettings(status?.widgetVisible);
  const { busy, run } = useRunner();

  if (!status || !settings) return <div className="card" style={{ minHeight: 168 }} aria-busy="true" />;
  return (
    <div className="card">
      <TrackingStatusView
        status={status}
        busy={busy}
        onPause={(duration) => void run(() => window.background.pauseTracking(duration))}
        onResume={() => void run(() => window.background.resumeTracking())}
      />
      <StartupRow settings={settings} update={update} />
      <WidgetRow settings={settings} update={update} />
    </div>
  );
}

// ── Settings: Daily Reflection ─────────────────────────────────────────────

/** When the day's reflection is written, when the user's day begins, and the notifications that go with it. */
export function DailyReflectionSettings() {
  const { settings: app, update } = useBackgroundSettings();
  const [coach, setCoach] = useState<CoachSettingsDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      window.coach
        .getSettings()
        .then((s) => {
          if (!cancelled) setCoach(s);
        })
        .catch((e) => console.error('[background] failed to load the reflection schedule', e));
    void load();
    window.coach.onChanged(load);
    return () => {
      cancelled = true;
      window.coach.offChanged(load);
    };
  }, []);

  if (!coach || !app) return <div className="card" style={{ minHeight: 168 }} aria-busy="true" />;
  const save = (patch: Partial<CoachSettingsDto>) =>
    window.coach.saveSettings(patch).then(setCoach).catch((e) => console.error('[background] failed to save the reflection schedule', e));

  return <DailyReflectionView coach={coach} notificationsEnabled={app.notificationsEnabled} onSave={(p) => void save(p)} onNotifications={(on) => void update({ notificationsEnabled: on })} />;
}

export interface DailyReflectionViewProps {
  coach: CoachSettingsDto;
  notificationsEnabled: boolean;
  onSave: (patch: Partial<CoachSettingsDto>) => void;
  onNotifications: (on: boolean) => void;
}

export function DailyReflectionView({ coach, notificationsEnabled, onSave, onNotifications }: DailyReflectionViewProps) {
  return (
    <div className="card">
      <ControlRow
        title="Reflection time"
        detail="Reflect prepares your daily reflection at this time, or the next time it runs if your computer is off."
        control={
          <TimeField
            label="Reflection time"
            minutes={coach.reflectionMinutes}
            onCommit={(minutes) => minutes !== coach.reflectionMinutes && onSave({ reflectionMinutes: minutes })}
          />
        }
      />
      <ControlRow
        title="Day starts at"
        detail={`Activity before this time counts toward the previous day — useful if you work past midnight. Can be as late as ${MAX_DAY_START_MINUTES / 60} AM.`}
        control={
          <TimeField
            label="Day starts at"
            minutes={coach.dayStartMinutes}
            max={MAX_DAY_START_MINUTES}
            onCommit={(minutes) => minutes <= MAX_DAY_START_MINUTES && minutes !== coach.dayStartMinutes && onSave({ dayStartMinutes: minutes })}
          />
        }
      />
      <ControlRow
        title="Notifications"
        detail="Reflect's notifications, for your reflection and for Focus. Reflect always tells you if Focus blocking stops working."
        control={<Switch label="Notifications" checked={notificationsEnabled} onChange={onNotifications} />}
      />
      <ControlRow
        title="When the reflection is ready"
        detail={notificationsEnabled ? 'A notification when your daily reflection has been written.' : 'Turn on notifications to use this.'}
        control={
          <Switch
            label="Notify when the reflection is ready"
            checked={notificationsEnabled && coach.notifyDailyReflection}
            disabled={!notificationsEnabled}
            onChange={(on) => onSave({ notifyDailyReflection: on })}
          />
        }
      />
    </div>
  );
}

/** A time input that saves when it loses focus; it re-reads the saved value whenever it changes. */
function TimeField(props: { label: string; minutes: number; max?: number; onCommit: (minutes: number) => void }) {
  return (
    <input
      key={props.minutes}
      type="time"
      aria-label={props.label}
      className="field text-[13px]"
      defaultValue={minutesToTimeInput(props.minutes)}
      max={props.max === undefined ? undefined : minutesToTimeInput(props.max)}
      onBlur={(e) => {
        const minutes = timeInputToMinutes(e.currentTarget.value);
        if (minutes !== null) props.onCommit(minutes);
      }}
    />
  );
}

// ── Shared rows ────────────────────────────────────────────────────────────

type SettingsProps = { settings: BackgroundSettingsDto; update: (patch: BackgroundSettingsPatchDto) => Promise<void> };

function StartupRow({ settings, update }: SettingsProps) {
  const detail = !settings.startupAvailable
    ? 'Starts quietly in the tray when you sign in. (Applies to the installed app, not this development build.)'
    : settings.startupDisabledBySystem
      ? 'Switched off in Windows itself (Task Manager → Startup apps). Turn it on there to start with Windows.'
      : 'Starts quietly in the tray when you sign in — no window opens.';
  return (
    <ControlRow
      title="Start with Windows"
      detail={detail}
      control={<Switch label="Start with Windows" checked={settings.startWithWindows} onChange={(on) => void update({ startWithWindows: on })} />}
    />
  );
}

function WidgetRow({ settings, update }: SettingsProps) {
  return (
    <ControlRow
      title="Floating widget"
      detail="A small pill on your desktop that shows Reflect is running. Hiding it does not pause tracking."
      control={<Switch label="Floating widget" checked={settings.widgetEnabled} onChange={(on) => void update({ widgetEnabled: on })} />}
    />
  );
}

function NotificationsRow({ settings, update }: SettingsProps) {
  return (
    <ControlRow
      title="Notifications"
      detail="When your reflection is ready, and for Focus. Reflect always tells you if Focus blocking stops working."
      control={<Switch label="Notifications" checked={settings.notificationsEnabled} onChange={(on) => void update({ notificationsEnabled: on })} />}
    />
  );
}

function ControlRow(props: { title: string; detail: string; control: ReactNode; children?: ReactNode }) {
  return (
    <div className="bg-row">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{props.title}</div>
          <p className="text-[13px] text-muted mt-0.5">{props.detail}</p>
        </div>
        <div className="shrink-0">{props.control}</div>
      </div>
      {props.children}
    </div>
  );
}

function Switch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  );
}
