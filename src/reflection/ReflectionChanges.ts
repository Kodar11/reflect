import type { IEventRepository } from '../database/EventRepository.js';

/**
 * Which renderer mutations can change what a past reflection was written
 * from, and how much of history each one touches.
 *
 * Timeline edits and manual classifications name the events they affect, so
 * only reflections overlapping those events need another look. Rule, Context
 * and undo/redo changes can re-classify any day, so everything is re-checked.
 */

/** Channels after which reflections must be re-verified. */
export const TIMELINE_CHANGE_CHANNELS: readonly string[] = [
  'timeline:apply',
  'timeline:undo',
  'timeline:redo',
  'activities:save',
  'activities:delete',
  'rules:save',
  'rules:delete',
  'categorization:saveOverride',
  'categorization:deleteOverride',
  'categorization:saveEventClassification',
  'categorization:deleteEventClassification',
  'categorization:rememberEventAsRule',
  'learnedRules:confirmCandidate',
];

export const PROFILE_CHANGE_CHANNELS: readonly string[] = ['userProfile:save', 'userProfile:update'];

/** Changes that add or remove a rule / Context re-classify all of history. */
const GLOBAL_CHANNELS = new Set([
  'timeline:undo',
  'timeline:redo',
  'activities:save',
  'activities:delete',
  'rules:save',
  'rules:delete',
  'categorization:deleteOverride',
  'categorization:rememberEventAsRule',
  'learnedRules:confirmCandidate',
]);

const TIME_KEYS = new Set(['startedAt', 'endedAt', 'newStartedAt', 'newEndedAt']);

function collect(value: unknown, key: string, ids: Set<number>, times: number[], depth: number): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (/event/i.test(key) && Number.isInteger(value)) ids.add(value);
    return;
  }
  if (typeof value === 'string') {
    if (TIME_KEYS.has(key)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) times.push(t);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, ids, times, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) collect(v, k, ids, times, depth + 1);
  }
}

/**
 * The stretch of history a mutation touched, or `null` when it cannot be
 * narrowed down (then every reflection is re-checked).
 */
export function affectedRange(
  channel: string,
  payload: unknown,
  events: Pick<IEventRepository, 'getByIds'>,
): { start: string; end: string } | null {
  if (GLOBAL_CHANNELS.has(channel)) return null;
  // "Remember this" turns a correction into a rule, which reaches all of history.
  if ((payload as { remember?: unknown } | null)?.remember === true) return null;

  const ids = new Set<number>();
  const times: number[] = [];
  collect(payload, '', ids, times, 0);
  if (ids.size > 0) {
    for (const event of events.getByIds([...ids])) {
      times.push(Date.parse(event.startedAt), Date.parse(event.endedAt));
    }
  }
  const known = times.filter((t) => !Number.isNaN(t));
  if (known.length === 0) return null;
  return { start: new Date(Math.min(...known)).toISOString(), end: new Date(Math.max(...known) + 1).toISOString() };
}
