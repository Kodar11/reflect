import { z } from 'zod';
import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import type { IGeminiClient } from '../intelligence/GeminiClient.js';
import { activitySignature } from './ReflectionActivities.js';
import type {
  ActivityAnnotation,
  ReflectionActivity,
  ReflectionLogger,
  ReflectionPriority,
  TaxonomyNames,
} from './ReflectionModels.js';
import { priorityActiveAt } from './ReflectionPriorities.js';

/**
 * Thread + priority linking.
 *
 * An AI activity says WHAT was done ("Implement the login flow"); Reflection
 * also needs to know which body of work it belongs to ("Project X") and
 * whether it served something the user said matters. That is a judgment about
 * meaning, so Gemini makes it — once per distinct activity signature, cached
 * in `reflection_activity_annotations`. Every number built on top of it is
 * still computed deterministically.
 *
 * Best-effort by design: if this step is unavailable, Reflection falls back
 * to the activity's Context and a conservative keyword match.
 */

export const ANNOTATION_PROMPT_VERSION = 'reflect-threads-v1';

const MAX_ITEMS_PER_CALL = 120;
const MIN_SIGNATURE_MINUTES = 5;
const MAX_KNOWN_THREADS = 40;
const MAX_THREAD_LENGTH = 40;

export interface AnnotationItem {
  ref: string;
  signature: string;
  title: string;
  summary: string | null;
  context: string | null;
  minutes: number;
}

/**
 * The activity signatures that still need a decision: never annotated, or
 * annotated before one of the now-applicable priorities existed. Largest
 * first, capped. Deterministic sessions carry no interpreted title and are
 * left to the Context / keyword fallback.
 */
export function selectAnnotationItems(
  activities: ReflectionActivity[],
  existing: Map<string, ActivityAnnotation>,
  priorities: ReflectionPriority[],
  taxonomy: TaxonomyNames,
): AnnotationItem[] {
  const groups = new Map<string, { item: Omit<AnnotationItem, 'ref'>; priorityIds: Set<string> }>();
  for (const a of activities) {
    if (a.source === 'deterministic') continue;
    const signature = activitySignature(a);
    let group = groups.get(signature);
    if (!group) {
      group = {
        item: {
          signature,
          title: a.title,
          summary: a.summary,
          context: a.contextId ? taxonomy.contexts[a.contextId] ?? null : null,
          minutes: 0,
        },
        priorityIds: new Set(),
      };
      groups.set(signature, group);
    }
    group.item.minutes += a.durationMinutes;
    if (!group.item.summary && a.summary) group.item.summary = a.summary;
    for (const p of priorities) if (priorityActiveAt(p, a.startedAt)) group.priorityIds.add(p.id);
  }

  const pending = [...groups.values()].filter(({ item, priorityIds }) => {
    if (item.minutes < MIN_SIGNATURE_MINUTES) return false;
    const annotation = existing.get(item.signature);
    if (!annotation) return true;
    return [...priorityIds].some((id) => !annotation.checkedPriorityIds.includes(id));
  });

  return pending
    .sort((a, b) => b.item.minutes - a.item.minutes || (a.item.signature < b.item.signature ? -1 : 1))
    .slice(0, MAX_ITEMS_PER_CALL)
    .map(({ item }, index) => ({ ...item, ref: `i${index + 1}`, minutes: Math.round(item.minutes) }));
}

const SYSTEM_INSTRUCTION = `ROLE
You label a user's activities for Reflect, a personal activity reflection system.
Each ITEM is an activity Reflect already identified. You decide two things about it. You do not judge the user.

THREAD
thread = the project, subject or theme the activity belongs to: a short, stable name of 1–4 words, such as "Reflect", "Game Theory" or "Job applications".
- Reuse a name from KNOWN THREADS whenever the activity belongs to that same body of work. Different activities on the same project must get exactly the same thread.
- Prefer the specific project or subject named in the title over a generic category.
- Never use an application or website name as a thread.
- Use null when the activity has no identifiable project, subject or theme (general browsing, miscellaneous or mixed activity).

PRIORITY
priorityId = the id of the stated priority this activity directly serves, or null.
- Link only when the activity is plainly work toward that priority. Being in the same broad field is not enough.
- At most one priority per activity. When unsure, use null. A wrong link invents progress; a missing link does not.
- Leisure and unrelated activity get null.

OUTPUT
Respond with JSON matching the response schema: one entry per ITEM, using its ref.`;

export function buildAnnotationPrompt(
  items: AnnotationItem[],
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[],
  knownThreads: string[],
): string {
  const lines = (list: unknown[]) => list.map((entry) => JSON.stringify(entry)).join('\n');
  return [
    priorities.length > 0
      ? `STATED PRIORITIES (what the user said matters right now)\n${lines(priorities.map((p) => ({ id: p.id, text: p.text })))}`
      : 'STATED PRIORITIES\nNone. Use null for every priorityId.',
    knownThreads.length > 0 ? `KNOWN THREADS (reuse these names)\n${lines(knownThreads)}` : 'KNOWN THREADS\nNone yet.',
    `ITEMS (${items.length})\n${lines(
      items.map((i) => ({ ref: i.ref, title: i.title, summary: i.summary, context: i.context, minutes: i.minutes })),
    )}`,
  ].join('\n\n');
}

export function buildAnnotationSchema(priorityIds: string[]): unknown {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            thread: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            priorityId:
              priorityIds.length > 0 ? { anyOf: [{ type: 'string', enum: priorityIds }, { type: 'null' }] } : { type: 'null' },
          },
          required: ['ref', 'thread', 'priorityId'],
        },
      },
    },
    required: ['items'],
  };
}

const outputSchema = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      thread: z.string().nullish(),
      priorityId: z.string().nullish(),
    }),
  ),
});

/**
 * Lenient on purpose: a single odd entry is dropped (that signature is simply
 * asked again next time) rather than discarding every other decision.
 */
export function validateAnnotationOutput(
  raw: unknown,
  items: AnnotationItem[],
  priorityIds: string[],
): Map<string, { thread: string | null; priorityId: string | null }> {
  const result = new Map<string, { thread: string | null; priorityId: string | null }>();
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) return result;
  const refs = new Set(items.map((i) => i.ref));
  const allowed = new Set(priorityIds);
  for (const entry of parsed.data.items) {
    if (!refs.has(entry.ref) || result.has(entry.ref)) continue;
    const thread = (entry.thread ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_LENGTH).trim();
    const priorityId = entry.priorityId && allowed.has(entry.priorityId) ? entry.priorityId : null;
    result.set(entry.ref, { thread: thread && thread.toLowerCase() !== 'null' ? thread : null, priorityId });
  }
  return result;
}

export interface ReflectionAnnotatorDeps {
  gemini: IGeminiClient;
  repo: Pick<IReflectionRepository, 'getAnnotations' | 'upsertAnnotations' | 'listThreadLabels'>;
  logger?: ReflectionLogger;
  now?: () => Date;
}

export class ReflectionAnnotator {
  private readonly now: () => Date;

  constructor(private readonly deps: ReflectionAnnotatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Annotate whatever in `activities` still lacks a decision. Returns how many
   * signatures were newly decided. Never throws.
   */
  async annotate(activities: ReflectionActivity[], priorities: ReflectionPriority[], taxonomy: TaxonomyNames): Promise<number> {
    const { gemini, repo, logger } = this.deps;
    try {
      if (!gemini.isConfigured() || activities.length === 0) return 0;

      const signatures = [...new Set(activities.map(activitySignature))];
      const existing = new Map(repo.getAnnotations(signatures).map((a) => [a.signature, a]));
      const items = selectAnnotationItems(activities, existing, priorities, taxonomy);
      if (items.length === 0) return 0;

      const priorityIds = priorities.map((p) => p.id);
      const response = await gemini.generateJson({
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt: buildAnnotationPrompt(items, priorities, repo.listThreadLabels(MAX_KNOWN_THREADS)),
        responseJsonSchema: buildAnnotationSchema(priorityIds),
      });

      let raw: unknown;
      try {
        raw = JSON.parse(response.text);
      } catch {
        logger?.warn('[REFLECTION] Thread linking returned malformed JSON; using fallbacks.');
        return 0;
      }
      const decisions = validateAnnotationOutput(raw, items, priorityIds);

      const annotations: ActivityAnnotation[] = [];
      for (const item of items) {
        const decision = decisions.get(item.ref);
        if (!decision) continue;
        const previous = existing.get(item.signature);
        annotations.push({
          signature: item.signature,
          thread: decision.thread,
          priorityId: decision.priorityId,
          checkedPriorityIds: [...new Set([...(previous?.checkedPriorityIds ?? []), ...priorityIds])],
        });
      }
      repo.upsertAnnotations(annotations, this.now().toISOString());
      logger?.info(`[REFLECTION] Linked ${annotations.length} activity signature(s) to threads / priorities.`);
      return annotations.length;
    } catch (err) {
      logger?.warn(`[REFLECTION] Thread linking unavailable; using fallbacks: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }
}
