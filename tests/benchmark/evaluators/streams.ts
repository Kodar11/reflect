import type { CoachAction } from '../../../src/coach/CoachModels';
import type { CapturedDay } from '../runner/capture';
import type { DatasetWorkStream, EvaluationOnlyDay } from '../runner/dataset';
import { normalizeText } from './text';

/**
 * Work streams: how the evaluator knows WHAT a recommendation is aimed at
 * without knowing any persona's vocabulary.
 *
 * The answer key names each body of work by a key (`persona_key.json`), labels
 * every ground-truth activity with the stream it belongs to, and states each
 * expected move against a stream. An action is then placed on a stream by,
 * in this order:
 *
 *   wording   it names the work — one of the stream's aliases, as whole words,
 *             in its title, task or description. What the user is told to do
 *             is the strongest statement of what the action is about.
 *   evidence  the activities it cites: the tracked events behind them belong,
 *             in the answer key, to ground-truth activities of that stream.
 *             "Finish the remaining script section" is about the video whose
 *             script was being written, whatever the action calls it.
 *   priority  the stated priority it is linked to, when that priority serves
 *             work streams of its own.
 *
 * The first of these that says anything decides. Nothing here compares an
 * action's sentence with the answer key's sentence.
 */

export interface StreamContext {
  streams: Record<string, DatasetWorkStream>;
  /** Stream of the ground-truth activity that owns each dataset event. */
  streamOfEvent: Map<number, string>;
  /** Dataset events (id → ms) behind each block of the day, by block id. */
  eventsOfBlock: Map<string, { id: number; ms: number }[]>;
}

/** A share of the cited evidence below this is incidental (a short message inside a long block of something else). */
const EVIDENCE_SHARE = 0.4;

/** No registry: every stream question is answered "unknown", and callers fall back to what they did before. */
export const NO_STREAMS: StreamContext = { streams: {}, streamOfEvent: new Map(), eventsOfBlock: new Map() };

export function hasStreams(ctx: StreamContext | undefined): ctx is StreamContext {
  return ctx !== undefined && Object.keys(ctx.streams).length > 0;
}

export function buildStreamContext(streams: Record<string, DatasetWorkStream>, captured: CapturedDay, answer: EvaluationOnlyDay): StreamContext {
  const streamOfEvent = new Map<number, string>();
  for (const activity of answer.groundTruth.activities) {
    const stream = streamOfActivity(activity, streams);
    if (stream) for (const id of activity.event_ids) streamOfEvent.set(id, stream);
  }
  const datasetIdOf = new Map(captured.events.map((e) => [e.eventId, e.datasetId]));
  const msOf = new Map(answer.events.map((e) => [e.datasetId, e.endMs - e.startMs]));
  const eventsOfBlock = new Map<string, { id: number; ms: number }[]>();
  for (const block of [...captured.deterministicSessions, ...captured.timeline]) {
    eventsOfBlock.set(
      block.id,
      block.eventIds.map((id) => datasetIdOf.get(id)).filter((id): id is number => id !== undefined).map((id) => ({ id, ms: msOf.get(id) ?? 0 })),
    );
  }
  return { streams, streamOfEvent, eventsOfBlock };
}

/** The stream of a ground-truth activity: its `stream`, or — in files written before streams — an `area` that is a stream key. */
export function streamOfActivity(activity: { stream?: string | null; area: string | null }, streams: Record<string, DatasetWorkStream>): string | null {
  if (activity.stream !== undefined) return activity.stream !== null && activity.stream in streams ? activity.stream : null;
  return activity.area !== null && activity.area in streams ? activity.area : null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Streams whose aliases `text` uses, best first; only the streams tied for the most alias hits are returned. */
export function streamsNamedIn(text: string, streams: Record<string, DatasetWorkStream>): string[] {
  const haystack = normalizeText(text);
  let best = 0;
  const hits = new Map<string, number>();
  for (const [key, stream] of Object.entries(streams)) {
    let count = 0;
    for (const alias of stream.aliases) {
      // Whole words, and a plural or possessive of the last one ("clients", "video's").
      const found = haystack.match(new RegExp(`(?<![a-z0-9])${escape(alias)}(?:s|'s)?(?![a-z0-9])`, 'g'));
      if (found) count += found.length;
    }
    if (count > 0) hits.set(key, count);
    best = Math.max(best, count);
  }
  return [...hits].filter(([, count]) => count === best).map(([key]) => key);
}

/** Streams the cited activities belong to, by tracked time; those holding a real share of it. */
export function streamsOfEvidence(blockIds: readonly string[], ctx: StreamContext): string[] {
  const ms = new Map<string, number>();
  let total = 0;
  for (const blockId of blockIds) {
    for (const event of ctx.eventsOfBlock.get(blockId) ?? []) {
      total += event.ms;
      const stream = ctx.streamOfEvent.get(event.id);
      if (stream) ms.set(stream, (ms.get(stream) ?? 0) + event.ms);
    }
  }
  if (total === 0) return [];
  return [...ms].filter(([, value]) => value / total >= EVIDENCE_SHARE).sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/** Streams a stated priority serves. */
export function streamsOfPriority(priorityText: string, streams: Record<string, DatasetWorkStream>): string[] {
  return Object.entries(streams).filter(([, stream]) => stream.priorities.includes(priorityText)).map(([key]) => key);
}

export interface ActionAim {
  streams: string[];
  /** Which reading placed it; `none` when nothing did. */
  by: 'wording' | 'evidence' | 'priority' | 'none';
}

/** What an action is aimed at. */
export function aimOfAction(action: CoachAction, priorities: { id: string; text: string }[], ctx: StreamContext): ActionAim {
  const named = streamsNamedIn([action.title, action.focusTask, action.description].filter(Boolean).join('\n'), ctx.streams);
  if (named.length > 0) return { streams: named, by: 'wording' };
  const cited = streamsOfEvidence(action.sourceActivityIds, ctx);
  if (cited.length > 0) return { streams: cited, by: 'evidence' };
  const priority = action.priorityId ? priorities.find((p) => p.id === action.priorityId) : undefined;
  const served = priority ? streamsOfPriority(priority.text, ctx.streams) : [];
  if (served.length > 0) return { streams: served, by: 'priority' };
  // Last, the thread and the reasoning: weaker wording, but still the action's own.
  const loose = streamsNamedIn([action.thread, action.rationale].filter(Boolean).join('\n'), ctx.streams);
  return loose.length > 0 ? { streams: loose, by: 'wording' } : { streams: [], by: 'none' };
}
