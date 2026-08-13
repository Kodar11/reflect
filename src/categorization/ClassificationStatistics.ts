import type { Classification, SessionLike } from './Classification.js';

/**
 * Pure aggregation of classification results for future Insights queries.
 *
 * Not rendered in this stage but available so the data model can support:
 *   - "How much deep work did I do today?"
 *   - "How much time did I spend learning?"
 *   - "What percentage of work was deep?"
 *
 * No React / SQLite / Electron / Date.now / Math.random.
 */

export interface DimensionBreakdown {
  byArea: Record<string, number>;
  byIntent: Record<string, number>;
  byquality: Record<string, number>;
  byContext: Record<string, number>;
  bySource: Record<string, number>;
  totalMs: number;
  classifiedMs: number;
  unclassifiedMs: number;
}

export function aggregateByDimension(
  classifications: Map<string, Classification>,
  sessions: SessionLike[],
): DimensionBreakdown {
  const breakdown: DimensionBreakdown = {
    byArea: {},
    byIntent: {},
    byquality: {},
    byContext: {},
    bySource: {},
    totalMs: 0,
    classifiedMs: 0,
    unclassifiedMs: 0,
  };

  for (const session of sessions) {
    const cls = classifications.get(session.id);
    if (!cls) continue;

    const duration = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
    const activeMs = Math.max(0, duration);
    breakdown.totalMs += activeMs;

    breakdown.bySource[cls.source] = (breakdown.bySource[cls.source] ?? 0) + activeMs;

    if (cls.source === 'unclassified') {
      breakdown.unclassifiedMs += activeMs;
      continue;
    }
    breakdown.classifiedMs += activeMs;

    if (cls.area) {
      breakdown.byArea[cls.area.name] = (breakdown.byArea[cls.area.name] ?? 0) + activeMs;
    }
    if (cls.intent) {
      breakdown.byIntent[cls.intent.name] = (breakdown.byIntent[cls.intent.name] ?? 0) + activeMs;
    }
    if (cls.quality) {
      breakdown.byquality[cls.quality.name] = (breakdown.byquality[cls.quality.name] ?? 0) + activeMs;
    }
    if (cls.context) {
      breakdown.byContext[cls.context.name] = (breakdown.byContext[cls.context.name] ?? 0) + activeMs;
    }
  }

  return breakdown;
}
