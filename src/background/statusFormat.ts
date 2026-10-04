import type { BackgroundStatus } from './BackgroundStatus.js';

/**
 * How the background status is put into words. The tray, the widget and
 * Settings all use these, so they always say the same thing. No dependencies:
 * the widget's small renderer bundle imports this file directly.
 */

/** "3h 18m", "42m", "0m". */
export function formatTrackedDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "38:24", "1:02:05". */
export function formatFocusClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "Tracking", "Tracking paused", "Tracking paused until 15:30". */
export function trackingLabel(status: Pick<BackgroundStatus, 'tracking' | 'pausedUntil'>, now: Date = new Date()): string {
  if (status.tracking === 'running') return 'Tracking';
  if (!status.pausedUntil) return 'Tracking paused';
  return `Tracking paused until ${formatPauseEnd(status.pausedUntil, now)}`;
}

/** A time today reads as a clock time; a later day gets its weekday. */
export function formatPauseEnd(untilIso: string, now: Date = new Date()): string {
  const until = new Date(untilIso);
  const clock = until.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay =
    until.getFullYear() === now.getFullYear() && until.getMonth() === now.getMonth() && until.getDate() === now.getDate();
  return sameDay ? clock : `${until.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}
