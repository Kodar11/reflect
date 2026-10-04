import type {
  IReflectionRepository,
  NewReflectionReport,
  ReflectionCommit,
  ReflectionFeedbackRecord,
} from '../../src/database/ReflectionRepository';
import type {
  ActivityAnnotation,
  ReflectionErrorCategory,
  ReflectionFeedbackType,
  ReflectionPeriod,
  ReflectionPeriodType,
  ReflectionPriority,
  ReflectionPriorityStatus,
  ReflectionReport,
  ReflectionReportStatus,
} from '../../src/reflection/ReflectionModels';
import type { PrioritySyncPlan } from '../../src/reflection/ReflectionPriorities';

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
      if (range && !(r.period.start < range.end && r.period.end > range.start)) continue;
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
      const insight = this.reports.flatMap((r) => r.insights).find((i) => i.id === insightId);
      if (insight) out.push({ insightId, insightType: insight.type, feedbackType: f.type, createdAt: f.createdAt });
    }
    return out;
  }

  listPriorities(): ReflectionPriority[] {
    return structuredClone(this.priorities);
  }

  applyPrioritySync(plan: PrioritySyncPlan, ids: string[], nowIso: string): void {
    for (const p of this.priorities) {
      if (plan.archiveIds.includes(p.id) && p.status !== 'archived') {
        p.status = 'archived';
        p.activeUntil = p.activeUntil ?? nowIso;
      }
      if (plan.confirmIds.includes(p.id)) p.lastConfirmedAt = plan.confirmedAt;
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
    });
  }

  setPriorityStatus(id: string, status: ReflectionPriorityStatus, nowIso: string): ReflectionPriority | null {
    const p = this.priorities.find((x) => x.id === id);
    if (!p) return null;
    p.status = status;
    if (status === 'active') {
      p.activeUntil = null;
      p.lastConfirmedAt = nowIso;
    } else {
      p.activeUntil = p.activeUntil ?? nowIso;
    }
    return structuredClone(p);
  }

  getAnnotations(signatures: string[]): ActivityAnnotation[] {
    return signatures
      .map((s) => this.annotations.get(s))
      .filter((a): a is ActivityAnnotation & { updatedAt: string } => a !== undefined)
      .map(({ updatedAt: _updatedAt, ...a }) => structuredClone(a));
  }

  upsertAnnotations(annotations: ActivityAnnotation[], nowIso: string): void {
    for (const a of annotations) this.annotations.set(a.signature, { ...structuredClone(a), updatedAt: nowIso });
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
