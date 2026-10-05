import type { PeriodDataset, ReflectionPeriod, ReportCoachBlock } from './ReflectionModels.js';
import type { CoachPromptParts } from './ReflectionPrompt.js';
import type { EvidenceToolkit } from './ReflectionValidator.js';

/**
 * The seam through which the Coach joins a day's reflection.
 *
 * Reflection stays useful on its own and knows nothing about actions, memory
 * or outcomes. When a coach is plugged in, a day's generation becomes ONE
 * request that produces both the reflection and the coaching — the hook
 * supplies its part of the prompt, checks its part of the response against
 * the same evidence, and hands back the writes that must be committed in the
 * same transaction as the report.
 */
export interface ReflectionCoachHook {
  /**
   * Open the coaching half of a day's generation, or return `null` when this
   * day should be reflected on without coaching (it closed too long ago for a
   * recommendation about "tomorrow" to mean anything).
   */
  beginDaily(input: DailyCoachInput): Promise<DailyCoachSession | null>;
}

export interface DailyCoachInput {
  period: ReflectionPeriod;
  coveredUntil: string;
  now: Date;
  /** The day's deterministic dataset (activities carry thread + priority). */
  dataset: PeriodDataset;
  /** The report this generation will replace, if the day already has one. */
  replacesReportId: string | null;
  /** Activity id → the alias ("a7") that activity carries in this day's prompt. */
  activityRefs?: Map<string, string>;
}

export interface CoachCheck<T = unknown> {
  /** Acceptable exactly as returned. */
  ok: boolean;
  /** What to tell the model on a retry. */
  errors: string[];
  /** The part that fully validated; always usable. */
  value: T;
}

export interface DailyCoachSession<T = unknown> {
  parts: CoachPromptParts;
  /** Validate the `coach` property of the response. Never throws. */
  validate(raw: unknown, evidence: EvidenceToolkit): CoachCheck<T>;
  /**
   * What an accepted coach block becomes: the part stored with the report,
   * and the writes (`apply`) to run inside the report's commit transaction.
   */
  plan(value: T, reportId: string, nowIso: string): { block: ReportCoachBlock; apply: () => void };
}
