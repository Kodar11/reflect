/**
 * Pure view logic for the Focus page. No React, no IPC — everything here is
 * derived from DTOs and a clock value, so it is unit-testable and the
 * components stay thin.
 */

export type FocusMode = 'stopwatch' | 'countdown';

export const DURATION_PRESETS = [25, 30, 45, 60, 90, 120] as const;
export const MAX_DURATION_MINUTES = 720;
export const MAX_TASK_LENGTH = 200;

export const PAUSE_REASONS = ['Quick break', 'Phone call', 'Meeting', 'Distraction', 'Other'] as const;
export const END_REASONS = ['Changed task', 'Meeting', 'Finished early', 'Needed to stop', 'Other'] as const;

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** "54 min", "1 min", "under 1 min". */
export function formatMinutes(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  return minutes < 1 ? 'under 1 min' : `${minutes} min`;
}

/** "60 minutes", "1 hour", "1 hr 30 min". */
export function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? '1 hr' : `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

export interface TimerView {
  clock: string;
  /** What the number means. */
  label: 'remaining' | 'elapsed';
  /** Raw value behind `clock`, in ms. */
  valueMs: number;
}

/**
 * What the big timer shows at `nowMs`. Derived from the session's persisted
 * timestamps — the renderer's interval only decides when to repaint, so the
 * display cannot drift from the service.
 *
 *   countdown → time left (stops while paused)
 *   stopwatch → active work time (stops while paused)
 */
export function timerView(dto: ActiveFocusSessionDto, nowMs: number): TimerView {
  if (dto.session.mode === 'countdown' && dto.session.plannedDurationMinutes !== null) {
    // Paused: frozen at planned − active work. Running: counts to the end,
    // which already accounts for every pause so far.
    const valueMs =
      dto.isRunning && dto.plannedEndsAt
        ? Math.max(0, new Date(dto.plannedEndsAt).getTime() - nowMs)
        : Math.max(0, dto.session.plannedDurationMinutes * 60_000 - dto.session.elapsedMs);
    // Round up so a fresh 60-minute session reads 60:00, and 0:00 only shows
    // once the commitment is really over.
    return { clock: formatClock(Math.ceil(valueMs / 1000) * 1000), label: 'remaining', valueMs };
  }
  const { session } = dto;
  const valueMs =
    dto.isRunning && session.startedAt
      ? Math.max(0, nowMs - new Date(session.startedAt).getTime() - session.totalPauseMs)
      : session.elapsedMs;
  return { clock: formatClock(valueMs), label: 'elapsed', valueMs };
}

export function stateLabel(dto: ActiveFocusSessionDto): string {
  if (dto.isRunning) return 'Focusing';
  return dto.pauseKind === 'idle' ? 'Paused — no activity' : 'Paused';
}

export interface BlockingView {
  text: string;
  tone: 'ok' | 'muted' | 'warn';
  detail: string | null;
  /** True when the user can ask for blocking to be restored. */
  canRestore: boolean;
}

/** The blocking line on the active screen. Never says "active" unless it is. */
export function blockingView(blocking: ActiveFocusSessionDto['blocking']): BlockingView {
  switch (blocking.status) {
    case 'active':
      return { text: 'Blocking active', tone: 'ok', detail: null, canRestore: false };
    case 'off':
      return { text: 'Blocking off', tone: 'muted', detail: null, canRestore: false };
    case 'recovering':
      return { text: 'Restoring blocking…', tone: 'warn', detail: null, canRestore: false };
    case 'unavailable':
      return { text: 'Blocking unavailable', tone: 'muted', detail: blocking.message, canRestore: false };
    case 'degraded':
    default:
      return { text: 'Blocking stopped', tone: 'warn', detail: blocking.message, canRestore: true };
  }
}

/** "Blocking: 5 rules" / "Blocking off". */
export function blockingSummary(profile: FocusProfileDto): string {
  if (!profile.blocking.enabled) return 'Blocking off';
  const n = profile.blocking.ruleCount;
  return `Blocking: ${n} rule${n === 1 ? '' : 's'}`;
}

/** "38 sites · 4 apps" — what the rules expand to; empty when nothing is blocked. */
export function blockingDetail(profile: FocusProfileDto): string {
  if (!profile.blocking.enabled) return '';
  const parts: string[] = [];
  const { siteCount, appCount } = profile.blocking;
  if (siteCount > 0) parts.push(`${siteCount} site${siteCount === 1 ? '' : 's'}`);
  if (appCount > 0) parts.push(`${appCount} app${appCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** "2 rules · 80 sites · 2 apps" — everything a preset blocks, in one line. */
export function blockingCounts(profile: FocusProfileDto): string {
  if (!profile.blocking.enabled) return 'Nothing is blocked';
  const n = profile.blocking.ruleCount;
  const detail = blockingDetail(profile);
  return `${n} rule${n === 1 ? '' : 's'}${detail ? ` · ${detail}` : ''}`;
}

/** True when a failed start was caused by blocking (and can be retried without it). */
export function isBlockingStartFailure(message: string | null): boolean {
  return !!message && /Focus was not started\.$/.test(message.trim());
}

export interface BlockingEditorModel {
  categories: Array<{ id: string; label: string; ruleId: string | null; on: boolean }>;
  websites: Array<{ rule: FocusRuleDto; on: boolean }>;
  apps: Array<{ rule: FocusRuleDto; on: boolean }>;
  allowed: Array<{ rule: FocusRuleDto; on: boolean }>;
  /** Suggestions not already switched on for this preset. */
  suggestedSites: string[];
  suggestedApps: Array<{ name: string; process: string }>;
}

/**
 * Everything the blocking editor shows for one preset. "On" means the block
 * is attached to this preset AND enabled — i.e. it will actually be enforced.
 */
export function blockingEditorModel(
  profile: FocusProfileDto,
  rules: FocusRuleDto[],
  options: FocusBlockingOptionsDto | null,
): BlockingEditorModel {
  const attached = new Set(profile.ruleIds);
  const isOn = (r: FocusRuleDto) => r.enabled && attached.has(r.id);
  const byLabel = (a: { rule: FocusRuleDto }, b: { rule: FocusRuleDto }) => a.rule.label.localeCompare(b.rule.label);
  const rows = (type: FocusRuleDto['type'], action: FocusRuleDto['action']) =>
    rules.filter((r) => r.type === type && r.action === action).map((rule) => ({ rule, on: isOn(rule) })).sort(byLabel);

  const categoryRules = rules.filter((r) => r.type === 'category' && r.action === 'block');
  const categories = (options?.categories ?? []).map((c) => {
    const rule = categoryRules.find((r) => r.label === c.label) ?? null;
    return { id: c.id, label: c.label, ruleId: rule?.id ?? null, on: rule ? isOn(rule) : false };
  });
  // A stored category the options do not list (older data) is still shown.
  for (const rule of categoryRules) {
    if (!categories.some((c) => c.ruleId === rule.id)) categories.push({ id: rule.target, label: rule.label, ruleId: rule.id, on: isOn(rule) });
  }

  const websites = rows('website', 'block');
  const apps = rows('app', 'block');
  const allowed = [...rows('website', 'allow'), ...rows('app', 'allow'), ...rows('category', 'allow')];
  const sitesOn = new Set(websites.filter((w) => w.on).map((w) => w.rule.label));
  const appsOn = new Set(apps.filter((a) => a.on).map((a) => a.rule.label.toLowerCase()));
  return {
    categories,
    websites,
    apps,
    allowed,
    suggestedSites: (options?.recentSites ?? []).filter((s) => !sitesOn.has(s)).slice(0, 5),
    suggestedApps: (options?.openApps ?? []).filter((a) => !appsOn.has(a.name.toLowerCase())).slice(0, 6),
  };
}

/** One-line description of a profile used as a preset. */
export function profileSummary(profile: FocusProfileDto): string {
  const time =
    profile.mode === 'countdown' && profile.defaultDurationMinutes
      ? formatDurationLabel(profile.defaultDurationMinutes)
      : 'No time limit';
  return `${time} · ${blockingSummary(profile)}`;
}

/** The profile a new session starts from: preference → flagged default → first. */
export function pickDefaultProfile(
  profiles: FocusProfileDto[],
  preferredId: string | null | undefined,
): FocusProfileDto | null {
  return profiles.find((p) => p.id === preferredId) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;
}

export interface StartDraft {
  task: string;
  mode: FocusMode;
  durationMinutes: number;
  profileId: string | null;
}

/** Why the draft cannot be started yet; null when it can. */
export function startProblem(draft: StartDraft): string | null {
  if (!draft.profileId) return 'Create a Focus profile first.';
  const task = draft.task.trim();
  if (!task) return 'Enter what you are focusing on.';
  if (task.length > MAX_TASK_LENGTH) return `Keep the task under ${MAX_TASK_LENGTH} characters.`;
  if (draft.mode === 'countdown') {
    const d = draft.durationMinutes;
    if (!Number.isInteger(d) || d < 1 || d > MAX_DURATION_MINUTES) {
      return `Choose a duration between 1 and ${MAX_DURATION_MINUTES} minutes.`;
    }
  }
  return null;
}

export interface SummaryView {
  title: string;
  task: string;
  lines: string[];
}

/**
 * The end-of-session summary: what was planned and what happened, stated as
 * facts. No scores and no judgement — the friction was before ending.
 */
export function summaryView(session: FocusSessionDto): SummaryView {
  const active = `${formatMinutes(session.elapsedMs)} active`;
  const plannedMs = session.plannedDurationMinutes !== null ? session.plannedDurationMinutes * 60_000 : null;

  if (session.endReason === 'completed' && plannedMs !== null) {
    return { title: 'Focus complete', task: session.task, lines: [`${formatMinutes(plannedMs)} planned`, active] };
  }
  if (session.endReason === 'finished' || session.endReason === 'completed') {
    return { title: 'Focus complete', task: session.task, lines: [active] };
  }

  const lines = [active];
  if (session.endReason === 'ended-early' && plannedMs !== null) {
    const remainingMs = plannedMs - session.elapsedMs;
    if (remainingMs >= 30_000) lines.push(`${formatMinutes(remainingMs)} remaining`);
  }
  return { title: 'Focus ended', task: session.task, lines };
}

export interface EndDialogCopy {
  title: string;
  body: string[];
  confirmLabel: string;
}

/** First step of the exit flow. */
export function endDialogCopy(challenge: EndFocusChallengeDto): EndDialogCopy {
  if (challenge.early && challenge.remainingMs !== null) {
    const minutes = Math.max(1, Math.ceil(challenge.remainingMs / 60_000));
    return {
      title: 'End Focus?',
      body: [`You still have ${minutes} minute${minutes === 1 ? '' : 's'} remaining.`, 'Your commitment is still active.'],
      confirmLabel: 'End Anyway',
    };
  }
  return {
    title: 'End Focus?',
    body: ['This finishes the session and turns blocking off.'],
    confirmLabel: 'End Focus',
  };
}

/** True when the typed text satisfies the challenge. */
export function phraseMatches(typed: string, challenge: EndFocusChallengeDto): boolean {
  return !challenge.requiresPhrase || typed.trim().toUpperCase() === challenge.phrase.toUpperCase();
}

/** Strip Electron's IPC wrapper so the user sees only the real message. */
export function cleanIpcError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^\w*Error:\s*/, '') || 'Something went wrong.';
}

/** Distinct recent tasks, most recent first, for one-click reuse. */
export function recentTasks(sessions: FocusSessionDto[], limit = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    const task = s.task.trim();
    const key = task.toLowerCase();
    if (!task || seen.has(key)) continue;
    seen.add(key);
    out.push(task);
    if (out.length >= limit) break;
  }
  return out;
}
