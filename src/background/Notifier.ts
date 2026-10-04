/**
 * Shows OS notifications on behalf of the background runtime.
 *
 * Works with every window closed. Two rules:
 *   - the user's notification switch is honoured here, in one place — only a
 *     `critical` notice (blocking stopped working) is shown regardless;
 *   - a notification that cannot be shown is logged and dropped. It never
 *     throws into the caller, so a broken notification never stops tracking,
 *     Focus or a scheduler.
 */

export interface NotificationRequest {
  title: string;
  body: string;
  /** Shown even when notifications are switched off. */
  critical?: boolean;
  onClick?: () => void;
}

/** The slice of Electron's `Notification` this needs. */
export interface NotificationHandle {
  show(): void;
  on(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): unknown;
}

export interface NotifierDeps {
  isEnabled: () => boolean;
  isSupported: () => boolean;
  create: (options: { title: string; body: string; silent: boolean }) => NotificationHandle;
  logger?: { warn(m: string): void; error(m: string): void };
}

/** How many shown notifications are kept referenced so their click still arrives. */
const MAX_LIVE = 16;

export class Notifier {
  /**
   * A notification that is garbage-collected loses its click handler, so the
   * recent ones are held until they are clicked, closed or pushed out.
   */
  private readonly live: NotificationHandle[] = [];

  constructor(private readonly deps: NotifierDeps) {}

  /** Returns whether the notification was handed to the OS. */
  show(request: NotificationRequest): boolean {
    try {
      if (!request.critical && !this.deps.isEnabled()) return false;
      if (!this.deps.isSupported()) return false;
      const notification = this.deps.create({ title: request.title, body: request.body, silent: true });
      const release = () => {
        const i = this.live.indexOf(notification);
        if (i !== -1) this.live.splice(i, 1);
      };
      notification.on('click', () => {
        release();
        try {
          request.onClick?.();
        } catch (err) {
          this.deps.logger?.error(`[NOTIFY] Click handler failed: ${messageOf(err)}`);
        }
      });
      notification.on('close', release);
      notification.on('failed', (_event, error) => {
        release();
        this.deps.logger?.warn(`[NOTIFY] "${request.title}" failed: ${String(error ?? 'unknown error')}`);
      });
      this.live.push(notification);
      if (this.live.length > MAX_LIVE) this.live.shift();
      notification.show();
      return true;
    } catch (err) {
      this.deps.logger?.error(`[NOTIFY] Could not show "${request.title}": ${messageOf(err)}`);
      return false;
    }
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
