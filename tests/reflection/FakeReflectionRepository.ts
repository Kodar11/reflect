import {
  referenceReach,
  type IReflectionRepository,
  type InsightHistoryRow,
  type NewReflectionReport,
  type ReflectionCommit,
  type ReflectionFeedbackRecord,
} from '../../src/database/ReflectionRepository';
import type {
  ActivityAnnotation,
  DayFactRow,
  DayFacts,
  PriorityEvent,
  PriorityEventType,
  ReflectionErrorCategory,
  ReflectionFeedbackType,
  ReflectionPeriod,
  ReflectionPeriodType,
  ReflectionPriority,
  ReflectionPriorityStatus,
  ReflectionReport,
  ReflectionReportStatus,
} from '../../src/reflection/ReflectionModels';
import { intervalsFromEvents, type PrioritySyncPlan } from '../../src/reflection/ReflectionPriorities';

/**
 * In-memory stand-in for `ReflectionRepository` with the same semantics:
 * at most one current report per period, all-or-nothing commits, pruning of
 * superseded failures. Lets the service be tested without native SQLite.
 */
export class FakeReflectionRepository implements IReflectionRepository {
  reports: ReflectionReport[] = [];
  feedback = new Map<string, { type: ReflectionFeedbackType; createdAt: string }>();
  priorities: ReflectionPriority[] = [];
  annotations = new Map<string, ActivityAnnotation & { updatedAt: string }>();
  priorityEvents: PriorityEvent[] = [];
  /** The day ledger: day key → facts. */
  dayFacts = new Map<string, DayFacts>();
  /** Set to make the next commit throw (persistence failure). */
  failNextCommit = false;

  private blank(report: NewReflectionReport, status: ReflectionReportStatus): ReflectionReport {
    return {
      id: report.id,
      period: report.period,
      coveredUntil: report.coveredUntil,
      status,
      trigger: report.trigger,
      headline: null,
      narrative: null,
      carryForward: null,
      coach: null,
      insights: [],
      inputSchemaVersion: report.inputSchemaVersion,
      outputSchemaVersion: report.outputSchemaVersion,
      promptVersion: report.promptVersion,
      model: report.model,
      attemptCount: 0,
      dataSnapshot: null,
      metricsSnapshot: null,
      error: null,
      errorCategory: null,
      staleReason: null,
      staleAt: null,
      needsVerification: false,
      generatedAt: null,
      createdAt: report.nowIso,
      updatedAt: report.nowIso,
    };
  }

  private ofPeriod(type: ReflectionPeriodType, key: string): ReflectionReport[] {
    return this.reports.filter((r) => r.period.type === type && r.period.key === key);
  }

  private withFeedback(report: ReflectionReport): ReflectionReport {
    return structuredClone({
      ...report,
      insights: report.insights.map((i) => ({ ...i, feedback: this.feedback.get(i.id)?.type ?? null })),
    });
  }

  createGenerating(report: NewReflectionReport): void {
    this.reports.push(this.blank(report, 'generating'));
  }

  recordAttempt(reportId: string, attemptCount: number, nowIso: string): void {
    const r = this.reports.find((x) => x.id === reportId);
    if (r) Object.assign(r, { attemptCount, updatedAt: nowIso });
  }

  commitReport(commit: ReflectionCommit): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('disk full');
    }
    const target = this.reports.find((r) => r.id === commit.reportId && r.status === 'generating');
    if (!target) throw new Error(`Reflection report ${commit.reportId} is not being generated`);
    // All or nothing, like the SQLite transaction: a failure in the writes
    // that travel with the report leaves everything as it was.
    commit.alongside?.();
    for (const r of this.ofPeriod(commit.period.type, commit.period.key)) {
      if (r.id !== commit.reportId && (r.status === 'fresh' || r.status === 'stale')) r.status = 'superseded';
    }
    Object.assign(target, {
      status: 'fresh',
      headline: commit.headline,
      narrative: commit.narrative,
      carryForward: commit.carryForward,
      coach: commit.coach,
      coveredUntil: commit.coveredUntil,
      model: commit.model,
      attemptCount: commit.attemptCount,
      dataSnapshot: commit.dataSnapshot,
      metricsSnapshot: commit.metricsSnapshot,
      insights: commit.insights.map((i) => ({ ...i, feedback: null })),
      generatedAt: commit.nowIso,
      updatedAt: commit.nowIso,
      needsVerification: false,
    });
    this.reports = this.reports.filter(
      (r) =>
        !(
          r.period.type === commit.period.type &&
          r.period.key === commit.period.key &&
          (r.status === 'failed' || r.status === 'insufficient_data')
        ),
    );
  }

  failReport(reportId: string, category: ReflectionErrorCategory, error: string, nowIso: string): void {
    const r = this.reports.find((x) => x.id === reportId && x.status === 'generating');
    if (r) Object.assign(r, { status: 'failed', errorCategory: category, error, updatedAt: nowIso });
  }

  recordInsufficient(report: NewReflectionReport): void {
    this.reports = this.reports.filter(
      (r) => !(r.period.type === report.period.type && r.period.key === report.period.key && r.status === 'insufficient_data'),
    );
    this.reports.push(this.blank(report, 'insufficient_data'));
  }

  failInterruptedReports(nowIso: string): number {
    const running = this.reports.filter((r) => r.status === 'generating');
    for (const r of running) {
      Object.assign(r, { status: 'failed', errorCategory: 'internal', error: 'Interrupted before completion', updatedAt: nowIso });
    }
    return running.length;
  }

  getCurrentReport(type: ReflectionPeriodType, key: string): ReflectionReport | null {
    const r = this.ofPeriod(type, key).find((x) => x.status === 'fresh' || x.status === 'stale');
    return r ? this.withFeedback(r) : null;
  }

  getLatestAttempt(type: ReflectionPeriodType, key: string): ReflectionReport | null {
    const list = this.ofPeriod(type, key);
    if (list.length === 0) return null;
    // Insertion order breaks ties, like rowid.
    const latest = list.reduce((best, r) => (r.createdAt >= best.createdAt ? r : best));
    return this.withFeedback(latest);
  }

  getReportById(id: string): ReflectionReport | null {
    const r = this.reports.find((x) => x.id === id);
    return r ? this.withFeedback(r) : null;
  }

  countFailedReports(type: ReflectionPeriodType, key: string, categories: ReflectionErrorCategory[]): number {
    return this.ofPeriod(type, key).filter(
      (r) => r.status === 'failed' && r.errorCategory !== null && categories.includes(r.errorCategory),
    ).length;
  }

  markStale(reportId: string, reason: string, nowIso: string): boolean {
    const r = this.reports.find((x) => x.id === reportId && x.status === 'fresh');
    if (!r) return false;
    Object.assign(r, { status: 'stale', staleReason: reason, staleAt: nowIso, needsVerification: false });
    return true;
  }

  flagForVerification(range: { start: string; end: string } | null, _nowIso: string): number {
    let count = 0;
    for (const r of this.reports) {
      if (r.status !== 'fresh' || r.needsVerification) continue;
      if (range && !(r.period.start < referenceReach(range.end)[r.period.type] && r.period.end > range.start)) continue;
      r.needsVerification = true;
      count++;
    }
    return count;
  }

  clearVerification(reportId: string): void {
    const r = this.reports.find((x) => x.id === reportId);
    if (r) r.needsVerification = false;
  }

  listCurrentReports(type: ReflectionPeriodType | null, limit: number, beforeStart?: string): ReflectionReport[] {
    return this.reports
      .filter((r) => r.status === 'fresh' || r.status === 'stale')
      .filter((r) => type === null || r.period.type === type)
      .filter((r) => beforeStart === undefined || r.period.start < beforeStart)
      .sort((a, b) => (a.period.start < b.period.start ? 1 : a.period.start > b.period.start ? -1 : 0))
      .slice(0, limit)
      .map((r) => this.withFeedback(r));
  }

  listReportedPeriods(): ReflectionPeriod[] {
    return this.listCurrentReports(null, Number.MAX_SAFE_INTEGER).map((r) => r.period);
  }

  listInsightHistory(type: ReflectionPeriodType, beforeStart: string, reportLimit: number): InsightHistoryRow[] {
    return this.listCurrentReports(type, reportLimit, beforeStart).flatMap((r) =>
      r.insights.map((i) => ({
        period: r.period,
        reportId: r.id,
        insightId: i.id,
        type: i.type,
        title: i.title,
        identityKey: i.identityKey ?? i.claimSignature,
        subjectKey: i.subjectKey ?? null,
        thread: i.thread ?? null,
        priorityId: i.priorityId ?? null,
        continuity: i.continuity ?? 'new',
        magnitude: i.magnitude ?? null,
        feedback: i.feedback,
      })),
    );
  }

  setFeedback(insightId: string, feedback: ReflectionFeedbackType | null, _id: string, nowIso: string): boolean {
    if (!this.reports.some((r) => r.insights.some((i) => i.id === insightId))) return false;
    if (feedback === null) this.feedback.delete(insightId);
    else this.feedback.set(insightId, { type: feedback, createdAt: nowIso });
    return true;
  }

  listFeedback(sinceIso: string): ReflectionFeedbackRecord[] {
    const out: ReflectionFeedbackRecord[] = [];
    for (const [insightId, f] of this.feedback) {
      if (f.createdAt < sinceIso) continue;
      const report = this.reports.find((r) => r.insights.some((i) => i.id === insightId));
      const insight = report?.insights.find((i) => i.id === insightId);
      if (report && insight) {
        out.push({
          insightId,
          insightType: insight.type,
          feedbackType: f.type,
          createdAt: f.createdAt,
          identityKey: insight.identityKey ?? insight.claimSignature,
          subjectKey: insight.subjectKey ?? null,
          title: insight.title,
          reportId: report.id,
          periodType: report.period.type,
          periodKey: report.period.key,
        });
      }
    }
    return out;
  }

  listPriorities(): ReflectionPriority[] {
    return structuredClone(this.priorities).map((p) => {
      const history = this.priorityEvents.filter((e) => e.priorityId === p.id).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const intervals = intervalsFromEvents(history);
      return intervals.length > 0 ? { ...p, intervals, history } : p;
    });
  }

  private event(priorityId: string, type: PriorityEventType, at: string, text: string, previousText: string | null = null): void {
    this.priorityEvents.push({ priorityId, at, type, text, previousText });
  }

  applyPrioritySync(plan: PrioritySyncPlan, ids: string[], nowIso: string): void {
    for (const p of this.priorities) {
      if (plan.archiveIds.includes(p.id) && p.status !== 'archived') {
        p.status = 'archived';
        p.activeUntil = p.activeUntil ?? nowIso;
        this.event(p.id, 'archived', nowIso, p.text);
      }
      if (plan.confirmIds.includes(p.id)) p.lastConfirmedAt = plan.confirmedAt;
      const again = plan.reactivate.find((r) => r.id === p.id);
      if (again && p.status === 'archived') {
        Object.assign(p, { status: 'active', activeUntil: null, text: again.text, lastConfirmedAt: plan.confirmedAt });
        this.event(p.id, 'reactivated', nowIso, again.text);
      }
      const renamed = plan.rename.find((r) => r.id === p.id);
      if (renamed) {
        Object.assign(p, { text: renamed.text, normalizedKey: renamed.normalizedKey, lastConfirmedAt: plan.confirmedAt });
        this.event(p.id, 'renamed', nowIso, renamed.text, renamed.previousText);
      }
    }
    plan.insert.forEach((p, index) => {
      this.priorities.push({
        id: ids[index],
        text: p.text,
        normalizedKey: p.normalizedKey,
        status: 'active',
        activeFrom: p.activeFrom,
        activeUntil: null,
        lastConfirmedAt: p.lastConfirmedAt,
      });
      this.event(ids[index], 'stated', p.activeFrom, p.text);
    });
  }

  setPriorityStatus(id: string, status: ReflectionPriorityStatus, nowIso: string): ReflectionPriority | null {
    const p = this.priorities.find((x) => x.id === id);
    if (!p) return null;
    if (p.status !== status) {
      p.status = status;
      if (status === 'active') {
        p.activeUntil = null;
        p.lastConfirmedAt = nowIso;
      } else {
        p.activeUntil = p.activeUntil ?? nowIso;
      }
      this.event(id, status === 'active' ? 'reactivated' : (status as PriorityEventType), nowIso, p.text);
    }
    return this.listPriorities().find((x) => x.id === id) ?? null;
  }

  getAnnotations(signatures: string[]): ActivityAnnotation[] {
    return signatures
      .map((s) => this.annotations.get(s))
      .filter((a): a is ActivityAnnotation & { updatedAt: string } => a !== undefined)
      .map(({ updatedAt: _updatedAt, ...a }) => ({ ...structuredClone(a), source: a.source ?? 'model' }));
  }

  upsertAnnotations(annotations: ActivityAnnotation[], nowIso: string): string[] {
    const changed: string[] = [];
    for (const a of annotations) {
      const previous = this.annotations.get(a.signature);
      // USER > MODEL, like the SQL upsert.
      if (previous?.source === 'user' && (a.source ?? 'model') !== 'user') continue;
      if (!previous || previous.thread !== a.thread || previous.priorityId !== a.priorityId || (previous.source ?? 'model') !== (a.source ?? 'model')) {
        changed.push(a.signature);
      }
      this.annotations.set(a.signature, { ...structuredClone(a), source: a.source ?? 'model', updatedAt: nowIso });
    }
    for (const [key, day] of this.dayFacts) {
      if (day.rows.some((r) => r.kind === 'signature' && changed.includes(r.key))) this.dayFacts.delete(key);
    }
    return changed;
  }

  getDayFacts(startIso: string, endIso: string): DayFactRow[] {
    return [...this.dayFacts.values()]
      .filter((d) => d.start >= startIso && d.start < endIso)
      .sort((a, b) => (a.start < b.start ? -1 : 1))
      .flatMap((d) => structuredClone(d.rows));
  }

  putDayFacts(day: DayFacts): void {
    this.dayFacts.set(day.key, structuredClone(day));
  }

  deleteDayFacts(range: { start: string; end: string } | null): number {
    let count = 0;
    for (const [key, day] of this.dayFacts) {
      if (range && !(day.start < range.end && day.end > range.start)) continue;
      this.dayFacts.delete(key);
      count++;
    }
    return count;
  }

  listThreadLabels(limit: number): string[] {
    const latest = new Map<string, string>();
    for (const a of this.annotations.values()) {
      if (a.thread && (latest.get(a.thread) ?? '') <= a.updatedAt) latest.set(a.thread, a.updatedAt);
    }
    return [...latest.entries()]
      .sort((x, y) => (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : x[0] < y[0] ? -1 : 1))
      .slice(0, limit)
      .map(([label]) => label);
  }
}
