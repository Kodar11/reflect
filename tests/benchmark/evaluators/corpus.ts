import type { CoachAction } from '../../../src/coach/CoachModels';
import type { ReflectionReport } from '../../../src/reflection/ReflectionModels';
import type { CapturedDay } from '../runner/capture';
import { streamOfPriority, streamOfText } from './text';

/** The text Reflect actually showed the user, gathered by where it appeared. */

const join = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n');

/** Headline, narrative and insights of a report. */
export function reflectionText(report: ReflectionReport | null): string {
  if (!report) return '';
  return join([
    report.headline,
    report.narrative,
    ...report.insights.flatMap((i) => [i.title, i.observation, i.interpretation, i.relevance, i.suggestedAction]),
    report.carryForward?.text,
  ]);
}

export function actionText(action: CoachAction): string {
  return join([action.title, action.description, action.rationale, action.focusTask]);
}

/** Everything the Coach said with a report: actions, follow-ups, uncertainty, question, memory. */
export function coachText(captured: CapturedDay): string {
  const block = captured.reflection.report?.coach ?? null;
  return join([
    ...captured.coach.actions.map(actionText),
    ...(block?.followups.flatMap((f) => [f.note, f.learned]) ?? []),
    ...(block?.uncertainty ?? []),
    block?.noActionReason,
    block?.question?.text,
    ...captured.coach.memoriesAdded.map((m) => m.text),
  ]);
}

/** Where Reflect said it was unsure: the Coach's uncertainty notes and each AI activity's own. */
export function uncertaintyText(captured: CapturedDay): string {
  return join([
    ...(captured.reflection.report?.coach?.uncertainty ?? []),
    ...captured.timeline.flatMap((b) => b.uncertainty),
    ...(captured.reflection.report?.dataSnapshot?.notes ?? []),
  ]);
}

/**
 * The dataset work stream ("Own SaaS" / "Freelance") an action is aimed at:
 * through the stated priority it is linked to when there is one, otherwise by
 * the words of its thread and title.
 */
export function streamOfAction(action: CoachAction, priorities: { id: string; text: string }[]): 'Own SaaS' | 'Freelance' | null {
  const priority = action.priorityId ? priorities.find((p) => p.id === action.priorityId) : null;
  if (priority) {
    const stream = streamOfPriority(priority.text);
    if (stream) return stream;
  }
  return streamOfText(join([action.thread, action.title, action.focusTask])) ?? streamOfText(actionText(action));
}
