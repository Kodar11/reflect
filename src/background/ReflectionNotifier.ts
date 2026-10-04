import type { GenerateResult, ReflectionPeriod } from '../reflection/ReflectionModels.js';
import { periodContaining, shiftPeriod } from '../reflection/ReflectionPeriods.js';
import type { NotificationRequest } from './Notifier.js';

/**
 * The one proactive nudge: a day's reflection is ready.
 *
 * Runs in the main process behind the reflection scheduler, so it works with
 * no window open — including for a reflection that was missed (the machine
 * was off at the reflection time) and written at the next start.
 *
 * At most one notification per day is ever sent. The claim is persisted
 * before anything is shown, so a scheduler retry, a regenerated report or a
 * restart cannot produce a second one.
 */

/** A recovered reflection older than this is written quietly. */
const MAX_AGE_DAYS = 7;

export interface ReflectionNotice {
  period: ReflectionPeriod;
  /** Ledger key: one per day, however often its report is rewritten. */
  key: string;
  title: string;
  body: string;
}

/**
 * Which of a cycle's results is worth a notification: the most recent day
 * that got a reflection. A backlog of several days is still one notification.
 */
export function chooseReflectionNotice(results: GenerateResult[], now: Date, pendingQuestions = 0): ReflectionNotice | null {
  const days = results
    .filter((r): r is Extract<GenerateResult, { status: 'succeeded' }> => r.status === 'succeeded' && r.period.type === 'day')
    .map((r) => r.period)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const period = days[0];
  if (!period) return null;
  if (now.getTime() - Date.parse(period.end) > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;

  return {
    period,
    key: `reflection-ready:${period.key}`,
    title: 'Your reflection is ready',
    body: pendingQuestions > 0 ? 'Reflect also has a question about something you planned.' : bodyFor(period, now),
  };
}

function bodyFor(period: ReflectionPeriod, now: Date): string {
  const today = periodContaining('day', now);
  if (period.key === today.key) return 'A short briefing on today, and what might be worth doing next.';
  if (period.key === shiftPeriod(today, -1).key) return 'A few things stood out about yesterday.';
  const weekday = new Date(period.start).toLocaleDateString(undefined, { weekday: 'long' });
  return `A few things stood out about ${weekday}.`;
}

export interface ReflectionNotifierDeps {
  ledger: { claim(key: string, kind: string, nowIso: string): boolean };
  /** The user's "tell me when the reflection is ready" preference. */
  wantsNotification: () => boolean;
  /** The user is already looking at Reflect — the page updates by itself. */
  isUserLooking: () => boolean;
  /** Open questions from the coach, mentioned in the body. */
  pendingQuestions: () => number;
  notify: (request: NotificationRequest) => boolean;
  /** A reflection the user has not seen exists (drives the widget and tray hint). */
  onPending: (notice: ReflectionNotice) => void;
  /** Open Reflect on this reflection. */
  open: (notice: ReflectionNotice) => void;
  now?: () => Date;
  logger?: { info(m: string): void; error(m: string): void };
}

export class ReflectionNotifier {
  constructor(private readonly deps: ReflectionNotifierDeps) {}

  /** Called after every scheduler cycle that wrote at least one reflection. Never throws. */
  onGenerated(results: GenerateResult[]): void {
    try {
      const now = this.deps.now?.() ?? new Date();
      const notice = chooseReflectionNotice(results, now, this.safeCount());
      if (!notice) return;

      // Claim first: whatever happens next, this day is not announced again.
      if (!this.deps.ledger.claim(notice.key, 'reflection-ready', now.toISOString())) return;
      if (this.deps.isUserLooking()) return;

      this.deps.onPending(notice);
      if (!this.deps.wantsNotification()) return;
      const shown = this.deps.notify({ title: notice.title, body: notice.body, onClick: () => this.deps.open(notice) });
      if (shown) this.deps.logger?.info(`[REFLECTION] Notified: reflection for ${notice.period.key} is ready.`);
    } catch (err) {
      this.deps.logger?.error(`[REFLECTION] Notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private safeCount(): number {
    try {
      return this.deps.pendingQuestions();
    } catch {
      return 0;
    }
  }
}
