import type { WebContents } from 'electron';
import {
  REFLECTION_FEEDBACK_TYPES,
  REFLECTION_PERIOD_TYPES,
  REFLECTION_PRIORITY_STATUSES,
  type ReflectionFeedbackType,
  type ReflectionPeriodType,
  type ReflectionPriorityStatus,
} from './ReflectionModels.js';
import type { ReflectionService } from './ReflectionService.js';

/**
 * Renderer bridge for the Reflection tab. Follows the existing registrar
 * pattern: thin frame-validated handlers returning plain JSON.
 *
 * The main process owns the authoritative reflection state. The renderer asks
 * for a period's view, may request a refresh, and reports feedback — it never
 * touches SQLite, never calls Gemini, and no prompt content or API key
 * crosses this boundary.
 */

interface PeriodRequest {
  type?: unknown;
  /** Any instant inside the period; defaults to now. */
  anchor?: unknown;
}

function periodType(value: unknown, channel: string): ReflectionPeriodType {
  if (typeof value !== 'string' || !(REFLECTION_PERIOD_TYPES as readonly string[]).includes(value)) {
    throw new Error(`${channel} requires a valid period type`);
  }
  return value as ReflectionPeriodType;
}

const anchorOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A stable evidence reference from the renderer: raw event ids, the recorded block id, the recorded window. */
function evidenceRef(value: unknown, channel: string): { eventIds?: number[]; activityId?: string; period?: { start: string; end: string } } {
  const v = value as { eventIds?: unknown; activityId?: unknown; period?: { start?: unknown; end?: unknown } | null } | null | undefined;
  if (!v || typeof v !== 'object') throw new Error(`${channel} requires an evidence reference`);
  const eventIds = Array.isArray(v.eventIds) ? v.eventIds.filter((id): id is number => Number.isInteger(id)).slice(0, 200) : [];
  const period = v.period && typeof v.period.start === 'string' && typeof v.period.end === 'string' ? { start: v.period.start, end: v.period.end } : undefined;
  if (eventIds.length === 0 && !period) throw new Error(`${channel} requires event ids or a time window`);
  return { ...(eventIds.length > 0 ? { eventIds } : {}), ...(typeof v.activityId === 'string' && v.activityId ? { activityId: v.activityId } : {}), ...(period ? { period } : {}) };
}

export function registerReflectionIpc(
  service: ReflectionService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  const notifyChanged = () => {
    for (const wc of webContentsForPush()) wc.send('reflection:changed', null);
  };

  ipcMainHandle('reflection:getReport', (p?: PeriodRequest) =>
    service.getView(periodType(p?.type, 'reflection:getReport'), anchorOf(p?.anchor)),
  );

  /** With a period type: every period of that type since tracking began, with what was observed in it. */
  ipcMainHandle('reflection:getAvailablePeriods', (p?: { type?: unknown }) =>
    service.listAvailablePeriods(p?.type === undefined || p?.type === null ? null : periodType(p.type, 'reflection:getAvailablePeriods')),
  );

  /** Where a piece of evidence is on the Timeline now (its block may have been regrouped since). */
  ipcMainHandle('reflection:resolveEvidence', (p?: unknown) => service.resolveEvidence(evidenceRef(p, 'reflection:resolveEvidence')));

  /** The activities behind an insight, as they are linked now — what a correction would change. */
  ipcMainHandle('reflection:getInsightBasis', (p?: { reportId?: unknown; insightId?: unknown }) => {
    if (!p || typeof p.reportId !== 'string' || typeof p.insightId !== 'string') throw new Error('reflection:getInsightBasis requires reportId and insightId');
    return service.getInsightBasis(p.reportId, p.insightId);
  });

  /** "That was not work on this priority" / "this belongs to another project". */
  ipcMainHandle('reflection:correctLink', async (p?: { evidence?: unknown; priorityId?: unknown; thread?: unknown }) => {
    const evidence = evidenceRef(p?.evidence, 'reflection:correctLink');
    const optional = (value: unknown, name: string): string | null | undefined => {
      if (value === undefined || value === null) return value;
      if (typeof value !== 'string') throw new Error(`reflection:correctLink received an invalid ${name}`);
      return value;
    };
    const ok = await service.correctActivityLink({ evidence, priorityId: optional(p?.priorityId, 'priorityId'), thread: optional(p?.thread, 'thread') });
    if (ok) notifyChanged();
    return { ok };
  });

  /** Which day the tab should open on: `null` = today, else the latest day with a reflection. */
  ipcMainHandle('reflection:getLanding', () => ({ anchor: service.landingAnchor() }));

  /** Manual "Refresh reflection" — throttled by the service. */
  ipcMainHandle('reflection:generate', async (p?: PeriodRequest) => {
    const period = service.resolvePeriod(periodType(p?.type, 'reflection:generate'), anchorOf(p?.anchor));
    const result = await service.generate(period, { trigger: 'manual' });
    if (result.status === 'succeeded') notifyChanged();
    return result;
  });

  ipcMainHandle('reflection:submitFeedback', (p?: { insightId?: unknown; feedback?: unknown }) => {
    if (!p || typeof p.insightId !== 'string' || !p.insightId) {
      throw new Error('reflection:submitFeedback requires insightId');
    }
    const feedback = p.feedback ?? null;
    if (feedback !== null && !(REFLECTION_FEEDBACK_TYPES as readonly unknown[]).includes(feedback)) {
      throw new Error('reflection:submitFeedback received an unknown feedback type');
    }
    return { ok: service.submitFeedback(p.insightId, feedback as ReflectionFeedbackType | null) };
  });

  ipcMainHandle('reflection:getPriorities', () => service.getPriorities());

  ipcMainHandle('reflection:setPriorityStatus', (p?: { id?: unknown; status?: unknown }) => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error('reflection:setPriorityStatus requires id');
    if (!(REFLECTION_PRIORITY_STATUSES as readonly unknown[]).includes(p.status) || p.status === 'archived') {
      throw new Error('reflection:setPriorityStatus received an unknown status');
    }
    const priorities = service.setPriorityStatus(p.id, p.status as ReflectionPriorityStatus);
    notifyChanged();
    return priorities;
  });

  return {
    notifyReflectionChanged: notifyChanged,
    /** Bring the renderer to the Reflection tab (the end-of-day notification). */
    requestOpen() {
      for (const wc of webContentsForPush()) wc.send('reflection:open', null);
    },
  };
}
