import type { FocusPreferences, FocusProfile, FocusSession } from './FocusModels.js';
import type { FocusNotice } from './FocusService.js';

export interface FocusNotification {
  title: string;
  body: string;
}

/**
 * Decides which Focus events become OS notifications and what they say.
 *
 * Notifications are facts, never commentary: no productivity remarks, no
 * encouragement, and nothing that offers a way around blocking. Each kind
 * can be switched off in preferences — except the loss of blocking, which is
 * always reported because the UI must never silently stop enforcing.
 */
export class FocusNotifier {
  /** Blocked targets already announced for the current session. */
  private announced = new Set<string>();
  private announcedSessionId: string | null = null;

  constructor(
    private readonly getPreferences: () => FocusPreferences,
    private readonly show: (notification: FocusNotification) => void,
  ) {}

  onNotice(notice: FocusNotice): void {
    const notification = this.forNotice(notice);
    if (notification) this.show(notification);
  }

  onSummary(session: FocusSession, _profile: FocusProfile): void {
    this.announced.clear();
    this.announcedSessionId = null;
    // Only a fulfilled commitment is announced. Ending early is something the
    // user just did deliberately; it needs no notification.
    if (session.endReason !== 'completed' || !this.getPreferences().notifyComplete) return;
    this.show({ title: 'Focus complete', body: session.task });
  }

  private forNotice(notice: FocusNotice): FocusNotification | null {
    const prefs = this.getPreferences();
    switch (notice.kind) {
      case 'started': {
        if (!prefs.notifyStart) return null;
        const minutes = notice.session.plannedDurationMinutes;
        return { title: 'Focus started', body: minutes ? `${notice.session.task} · ${minutes} min` : notice.session.task };
      }
      case 'idle-paused':
        if (!prefs.notifyIdle) return null;
        return { title: 'Focus paused', body: 'No activity detected. Blocking stays on.' };
      case 'idle-resumed':
        if (!prefs.notifyIdle) return null;
        return { title: 'Focus resumed', body: notice.session.task };
      case 'blocked': {
        if (!prefs.notifyBlocked) return null;
        if (this.announcedSessionId !== notice.session.id) {
          this.announcedSessionId = notice.session.id;
          this.announced.clear();
        }
        // Once per target per session — repeated attempts stay silent.
        const key = `${notice.type}:${notice.target}`;
        if (this.announced.has(key)) return null;
        this.announced.add(key);
        return { title: `${displayTarget(notice.target)} is blocked during Focus`, body: notice.session.task };
      }
      case 'blocking-lost':
        return { title: 'Focus blocking stopped', body: notice.message };
      case 'blocking-restored':
        return null;
    }
  }
}

/** "discord.exe" → "Discord", "www.youtube.com" → "youtube.com". */
export function displayTarget(target: string): string {
  if (target.endsWith('.exe')) {
    const name = target.slice(0, -4);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return target.replace(/^www\./, '');
}
