import { useEffect, useState, type ReactNode } from 'react';
import { formatPauseEnd, formatTrackedDuration } from '../../background/statusFormat';
import { MAX_DAY_START_MINUTES } from '../../coach/CoachModels';
import { useBackgroundSettings, useBackgroundStatus } from '../hooks/useBackground';
import { minutesToTimeInput, timeInputToMinutes } from '../Reflection/coachView';

/**
 * The background controls: tracking, start with Windows, the floating widget
 * and notifications. One component, used by Settings (with the pause choices
 * and the reflection schedule) and by onboarding (the four switches only).
 *
 * It decides nothing. Every switch asks the main process, which owns the
 * setting and reports back what is now true.
 */

const PAUSE_CHOICES: { label: string; duration: PauseDurationDto }[] = [
  { label: '15 minutes', duration: '15m' },
  { label: '1 hour', duration: '1h' },
  { label: 'Until tomorrow', duration: 'tomorrow' },
];

interface BackgroundControlsProps {
  /** Settings shows the pause choices and the reflection schedule; onboarding only the switches. */
  variant: 'settings' | 'onboarding';
}

export function BackgroundControls({ variant }: BackgroundControlsProps) {
  const status = useBackgroundStatus();
  const { settings, update } = useBackgroundSettings(status?.widgetVisible);
  const [busy, setBusy] = useState(false);

  if (!status || !settings) return <div className="card" style={{ minHeight: 120 }} aria-busy="true" />;

  const paused = status.tracking === 'paused';
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

  const trackingDetail = paused
    ? status.pausedUntil
      ? `Paused until ${formatPauseEnd(status.pausedUntil)}. Nothing is being recorded.`
      : 'Off. Nothing is recorded until you turn it back on.'
    : variant === 'settings'
      ? `On — ${formatTrackedDuration(status.todayTrackedMs)} tracked today. Runs whether or not this window is open.`
      : 'Notes the app, window title and website in front of you.';

  const startupDetail = !settings.startupAvailable
    ? 'Starts quietly in the tray when you sign in. (Applies to the installed app, not this development build.)'
    : settings.startupDisabledBySystem
      ? 'Switched off in Windows itself (Task Manager → Startup apps). Turn it on there to start with Windows.'
      : 'Starts quietly in the tray when you sign in — no window opens.';

  return (
    <div className="card">
      <ControlRow
        title="Tracking"
        detail={trackingDetail}
        control={
          <Switch
            label="Tracking"
            checked={!paused}
            disabled={busy}
            onChange={(on) => run(() => (on ? window.background.resumeTracking() : window.background.pauseTracking('manual')))}
          />
        }
      >
        {variant === 'settings' && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            <span className="text-[12.5px] text-muted mr-1">{paused ? 'Pause instead for' : 'Pause for'}</span>
            {PAUSE_CHOICES.map((choice) => (
              <button
                key={choice.duration}
                type="button"
                className="btn btn-ghost bg-control"
                disabled={busy}
                onClick={() => run(() => window.background.pauseTracking(choice.duration))}
              >
                {choice.label}
              </button>
            ))}
            {paused && (
              <button type="button" className="btn btn-ghost bg-control" disabled={busy} onClick={() => run(() => window.background.resumeTracking())}>
                Resume now
              </button>
            )}
          </div>
        )}
      </ControlRow>

      <ControlRow
        title="Start with Windows"
        detail={startupDetail}
        control={
          <Switch label="Start with Windows" checked={settings.startWithWindows} onChange={(on) => void update({ startWithWindows: on })} />
        }
      />

      <ControlRow
        title="Floating widget"
        detail="A small pill on your desktop that shows Reflect is running. Hiding it does not pause tracking."
        control={<Switch label="Floating widget" checked={settings.widgetEnabled} onChange={(on) => void update({ widgetEnabled: on })} />}
      />

      <ControlRow
        title="Notifications"
        detail="When your reflection is ready, and for Focus. Reflect always tells you if Focus blocking stops working."
        control={
          <Switch label="Notifications" checked={settings.notificationsEnabled} onChange={(on) => void update({ notificationsEnabled: on })} />
        }
      />

      {variant === 'settings' && <ReflectionSchedule />}
    </div>
  );
}

/** When the day's reflection is written and when the user's day begins — the coach's own settings. */
function ReflectionSchedule() {
  const [settings, setSettings] = useState<CoachSettingsDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      window.coach
        .getSettings()
        .then((s) => {
          if (!cancelled) setSettings(s);
        })
        .catch((e) => console.error('[background] failed to load the reflection schedule', e));
    void load();
    window.coach.onChanged(load);
    return () => {
      cancelled = true;
      window.coach.offChanged(load);
    };
  }, []);

  if (!settings) return null;
  const save = (patch: Partial<CoachSettingsDto>) =>
    window.coach.saveSettings(patch).then(setSettings).catch((e) => console.error('[background] failed to save the reflection schedule', e));

  return (
    <ControlRow
      title="Daily reflection"
      detail="Written in the background at this time — or the next time Reflect runs, if the computer was off."
      control={
        <div className="flex items-center gap-3 text-[12.5px] text-muted">
          <label className="flex items-center gap-2">
            <span>Write at</span>
            <input
              key={`r-${settings.reflectionMinutes}`}
              type="time"
              className="field text-[13px]"
              defaultValue={minutesToTimeInput(settings.reflectionMinutes)}
              onBlur={(e) => {
                const minutes = timeInputToMinutes(e.currentTarget.value);
                if (minutes !== null && minutes !== settings.reflectionMinutes) void save({ reflectionMinutes: minutes });
              }}
            />
          </label>
          <label className="flex items-center gap-2">
            <span>Day starts at</span>
            <input
              key={`d-${settings.dayStartMinutes}`}
              type="time"
              className="field text-[13px]"
              defaultValue={minutesToTimeInput(settings.dayStartMinutes)}
              max={minutesToTimeInput(MAX_DAY_START_MINUTES)}
              onBlur={(e) => {
                const minutes = timeInputToMinutes(e.currentTarget.value);
                if (minutes !== null && minutes <= MAX_DAY_START_MINUTES && minutes !== settings.dayStartMinutes) {
                  void save({ dayStartMinutes: minutes });
                }
              }}
            />
          </label>
        </div>
      }
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
