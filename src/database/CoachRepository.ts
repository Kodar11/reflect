import type { Database } from './Database.js';
import {
  DEFAULT_COACH_SETTINGS,
  normalizeCoachSettings,
  type CoachAction,
  type CoachActionEvent,
  type CoachActionStatus,
  type CoachMemory,
  type CoachMessage,
  type CoachMessageMeta,
  type CoachObservation,
  type CoachSettings,
} from '../coach/CoachModels.js';
import type { ReflectionEvidence } from '../reflection/ReflectionModels.js';

/**
 * Storage seam for the Coach. The service depends on this interface; tests
 * substitute an in-memory fake.
 *
 * An action is stored whole and updated whole: its lifecycle is decided by the
 * pure state machine, never by SQL. Every change is also appended to
 * `coach_action_events`, so how an action got to its state stays traceable.
 */
export interface ICoachRepository {
  /** Run `fn` atomically (nests inside an outer transaction). */
  transaction<T>(fn: () => T): T;

  // Actions
  insertAction(action: CoachAction): void;
  updateAction(action: CoachAction): void;
  getAction(id: string): CoachAction | null;
  /** Actions created at or after `sinceIso`, newest first. */
  listActions(sinceIso: string): CoachAction[];
  listActionsByReport(reportId: string): CoachAction[];
  /** Remove an action and its audit trail for good (the event it was made from was permanently deleted). */
  deleteAction(id: string): void;
  insertActionEvent(event: CoachActionEvent): void;
  listActionEvents(actionId: string): CoachActionEvent[];

  // Memory
  insertMemory(memory: CoachMemory): void;
  updateMemory(memory: CoachMemory): void;
  getMemory(id: string): CoachMemory | null;
  /** Every memory that was not removed, newest first. */
  listMemories(): CoachMemory[];

  // Conversation
  insertMessage(message: CoachMessage): void;
  /** The latest `limit` messages, oldest first. */
  listMessages(limit: number): CoachMessage[];
  /** Keep only the latest `keep` messages. */
  pruneMessages(keep: number): void;

  // Settings
  getSettings(): CoachSettings;
  saveSettings(settings: CoachSettings, nowIso: string): void;
}

interface ActionRow {
  id: string;
  source: string;
  report_id: string | null;
  origin_day_key: string;
  parent_action_id: string | null;
  title: string;
  description: string | null;
  rationale: string;
  action_type: string;
  daypart: string;
  target_start: string | null;
  target_end: string | null;
  focus_minutes: number | null;
  focus_task: string | null;
  priority_id: string | null;
  thread: string | null;
  strategy_key: string;
  target_key: string | null;
  evidence_json: string;
  source_metric_keys_json: string;
  source_activity_ids_json: string;
  confidence: number;
  status: string;
  execution: string | null;
  execution_source: string | null;
  outcome: string | null;
  reason_code: string | null;
  note: string | null;
  observation_json: string | null;
  linked_focus_session_id: string | null;
  snoozed_until: string | null;
  snooze_count: number;
  user_edited: number;
  created_at: string;
  accepted_at: string | null;
  rejected_at: string | null;
  executed_at: string | null;
  outcome_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const ACTION_COLUMNS = [
  'id', 'source', 'report_id', 'origin_day_key', 'parent_action_id', 'title', 'description', 'rationale', 'action_type',
  'daypart', 'target_start', 'target_end', 'focus_minutes', 'focus_task', 'priority_id', 'thread', 'strategy_key',
  'target_key', 'evidence_json', 'source_metric_keys_json', 'source_activity_ids_json', 'confidence', 'status',
  'execution', 'execution_source', 'outcome', 'reason_code', 'note', 'observation_json', 'linked_focus_session_id',
  'snoozed_until', 'snooze_count', 'user_edited', 'created_at', 'accepted_at', 'rejected_at', 'executed_at',
  'outcome_at', 'closed_at', 'updated_at',
] as const;

function actionParams(a: CoachAction): Record<(typeof ACTION_COLUMNS)[number], string | number | null> {
  return {
    id: a.id,
    source: a.source,
    report_id: a.reportId,
    origin_day_key: a.originDayKey,
    parent_action_id: a.parentActionId,
    title: a.title,
    description: a.description,
    rationale: a.rationale,
    action_type: a.actionType,
    daypart: a.daypart,
    target_start: a.targetStart,
    target_end: a.targetEnd,
    focus_minutes: a.focusMinutes,
    focus_task: a.focusTask,
    priority_id: a.priorityId,
    thread: a.thread,
    strategy_key: a.strategyKey,
    target_key: a.targetKey,
    evidence_json: JSON.stringify(a.evidence),
    source_metric_keys_json: JSON.stringify(a.sourceMetricKeys),
    source_activity_ids_json: JSON.stringify(a.sourceActivityIds),
    confidence: a.confidence,
    status: a.status,
    execution: a.execution,
    execution_source: a.executionSource,
    outcome: a.outcome,
    reason_code: a.reasonCode,
    note: a.note,
    observation_json: a.observation ? JSON.stringify(a.observation) : null,
    linked_focus_session_id: a.linkedFocusSessionId,
    snoozed_until: a.snoozedUntil,
    snooze_count: a.snoozeCount,
    user_edited: a.userEdited ? 1 : 0,
    created_at: a.createdAt,
    accepted_at: a.acceptedAt,
    rejected_at: a.rejectedAt,
    executed_at: a.executedAt,
    outcome_at: a.outcomeAt,
    closed_at: a.closedAt,
    updated_at: a.updatedAt,
  };
}

function rowToAction(r: ActionRow): CoachAction {
  return {
    id: r.id,
    source: r.source as CoachAction['source'],
    reportId: r.report_id,
    originDayKey: r.origin_day_key,
    parentActionId: r.parent_action_id,
    title: r.title,
    description: r.description,
    rationale: r.rationale,
    actionType: r.action_type as CoachAction['actionType'],
    daypart: r.daypart as CoachAction['daypart'],
    targetStart: r.target_start,
    targetEnd: r.target_end,
    focusMinutes: r.focus_minutes,
    focusTask: r.focus_task,
    priorityId: r.priority_id,
    thread: r.thread,
    strategyKey: r.strategy_key,
    targetKey: r.target_key,
    evidence: parseJson<ReflectionEvidence[]>(r.evidence_json, []),
    sourceMetricKeys: parseJson<string[]>(r.source_metric_keys_json, []),
    sourceActivityIds: parseJson<string[]>(r.source_activity_ids_json, []),
    confidence: r.confidence,
    status: r.status as CoachActionStatus,
    execution: r.execution as CoachAction['execution'],
    executionSource: r.execution_source as CoachAction['executionSource'],
    outcome: r.outcome as CoachAction['outcome'],
    reasonCode: r.reason_code as CoachAction['reasonCode'],
    note: r.note,
    observation: parseJson<CoachObservation | null>(r.observation_json, null),
    linkedFocusSessionId: r.linked_focus_session_id,
    snoozedUntil: r.snoozed_until,
    snoozeCount: r.snooze_count,
    userEdited: r.user_edited === 1,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    rejectedAt: r.rejected_at,
    executedAt: r.executed_at,
    outcomeAt: r.outcome_at,
    closedAt: r.closed_at,
    updatedAt: r.updated_at,
  };
}

interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  normalized_key: string;
  status: string;
  source: string;
  source_ref: string | null;
  target_key: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMemory(r: MemoryRow): CoachMemory {
  return {
    id: r.id,
    kind: r.kind as CoachMemory['kind'],
    text: r.text,
    normalizedKey: r.normalized_key,
    status: r.status as CoachMemory['status'],
    source: r.source as CoachMemory['source'],
    sourceRef: r.source_ref,
    targetKey: r.target_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class CoachRepository implements ICoachRepository {
  private readonly insertActionStmt;
  private readonly updateActionStmt;
  private readonly actionByIdStmt;
  private readonly listActionsStmt;
  private readonly actionsByReportStmt;
  private readonly insertEventStmt;
  private readonly listEventsStmt;

  private readonly insertMemoryStmt;
  private readonly updateMemoryStmt;
  private readonly memoryByIdStmt;
  private readonly listMemoriesStmt;

  private readonly insertMessageStmt;
  private readonly listMessagesStmt;
  private readonly pruneMessagesStmt;

  private readonly getSettingsStmt;
  private readonly saveSettingsStmt;

  constructor(private readonly db: Database) {
    this.insertActionStmt = db.prepare(
      `INSERT INTO coach_actions (${ACTION_COLUMNS.join(', ')}) VALUES (${ACTION_COLUMNS.map((c) => `@${c}`).join(', ')})`,
    );
    this.updateActionStmt = db.prepare(
      `UPDATE coach_actions SET ${ACTION_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`,
    );
    this.actionByIdStmt = db.prepare(`SELECT * FROM coach_actions WHERE id = ?`);
    this.listActionsStmt = db.prepare(`SELECT * FROM coach_actions WHERE created_at >= ? ORDER BY created_at DESC, rowid DESC`);
    this.actionsByReportStmt = db.prepare(`SELECT * FROM coach_actions WHERE report_id = ? ORDER BY created_at ASC, rowid ASC`);
    this.insertEventStmt = db.prepare(
      `INSERT INTO coach_action_events (id, action_id, type, from_status, to_status, detail_json, created_at)
       VALUES (@id, @action_id, @type, @from_status, @to_status, @detail_json, @created_at)`,
    );
    this.listEventsStmt = db.prepare(`SELECT * FROM coach_action_events WHERE action_id = ? ORDER BY created_at ASC, rowid ASC`);

    this.insertMemoryStmt = db.prepare(
      `INSERT INTO coach_memory (id, kind, text, normalized_key, status, source, source_ref, target_key, created_at, updated_at)
       VALUES (@id, @kind, @text, @normalized_key, @status, @source, @source_ref, @target_key, @created_at, @updated_at)`,
    );
    this.updateMemoryStmt = db.prepare(
      `UPDATE coach_memory SET kind = @kind, text = @text, normalized_key = @normalized_key, status = @status,
         target_key = @target_key, updated_at = @updated_at
       WHERE id = @id`,
    );
    this.memoryByIdStmt = db.prepare(`SELECT * FROM coach_memory WHERE id = ?`);
    this.listMemoriesStmt = db.prepare(`SELECT * FROM coach_memory WHERE status != 'removed' ORDER BY created_at DESC, rowid DESC`);

    this.insertMessageStmt = db.prepare(
      `INSERT INTO coach_messages (id, role, text, meta_json, created_at) VALUES (@id, @role, @text, @meta_json, @created_at)`,
    );
    this.listMessagesStmt = db.prepare(
      `SELECT * FROM (SELECT *, rowid AS rid FROM coach_messages ORDER BY created_at DESC, rowid DESC LIMIT ?)
       ORDER BY created_at ASC, rid ASC`,
    );
    this.pruneMessagesStmt = db.prepare(
      `DELETE FROM coach_messages
       WHERE id NOT IN (SELECT id FROM coach_messages ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    );

    this.getSettingsStmt = db.prepare(`SELECT data FROM coach_settings WHERE id = 1`);
    this.saveSettingsStmt = db.prepare(
      `INSERT INTO coach_settings (id, data, updated_at) VALUES (1, @data, @now)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // --- Actions ---

  insertAction(action: CoachAction): void {
    this.insertActionStmt.run(actionParams(action));
  }

  deleteAction(id: string): void {
    // Its coach_action_events go with it (ON DELETE CASCADE).
    this.db.prepare(`DELETE FROM coach_actions WHERE id = ?`).run(id);
  }

  updateAction(action: CoachAction): void {
    this.updateActionStmt.run(actionParams(action));
  }

  getAction(id: string): CoachAction | null {
    const row = this.actionByIdStmt.get(id) as ActionRow | undefined;
    return row ? rowToAction(row) : null;
  }

  listActions(sinceIso: string): CoachAction[] {
    return (this.listActionsStmt.all(sinceIso) as ActionRow[]).map(rowToAction);
  }

  listActionsByReport(reportId: string): CoachAction[] {
    return (this.actionsByReportStmt.all(reportId) as ActionRow[]).map(rowToAction);
  }

  insertActionEvent(event: CoachActionEvent): void {
    this.insertEventStmt.run({
      id: event.id,
      action_id: event.actionId,
      type: event.type,
      from_status: event.fromStatus,
      to_status: event.toStatus,
      detail_json: event.detail ? JSON.stringify(event.detail) : null,
      created_at: event.createdAt,
    });
  }

  listActionEvents(actionId: string): CoachActionEvent[] {
    const rows = this.listEventsStmt.all(actionId) as {
      id: string;
      action_id: string;
      type: string;
      from_status: string | null;
      to_status: string;
      detail_json: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      actionId: r.action_id,
      type: r.type,
      fromStatus: r.from_status as CoachActionStatus | null,
      toStatus: r.to_status as CoachActionStatus,
      detail: parseJson<Record<string, unknown> | null>(r.detail_json, null),
      createdAt: r.created_at,
    }));
  }

  // --- Memory ---

  insertMemory(memory: CoachMemory): void {
    this.insertMemoryStmt.run({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      normalized_key: memory.normalizedKey,
      status: memory.status,
      source: memory.source,
      source_ref: memory.sourceRef,
      target_key: memory.targetKey,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
    });
  }

  updateMemory(memory: CoachMemory): void {
    this.updateMemoryStmt.run({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      normalized_key: memory.normalizedKey,
      status: memory.status,
      target_key: memory.targetKey,
      updated_at: memory.updatedAt,
    });
  }

  getMemory(id: string): CoachMemory | null {
    const row = this.memoryByIdStmt.get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  listMemories(): CoachMemory[] {
    return (this.listMemoriesStmt.all() as MemoryRow[]).map(rowToMemory);
  }

  // --- Conversation ---

  insertMessage(message: CoachMessage): void {
    this.insertMessageStmt.run({
      id: message.id,
      role: message.role,
      text: message.text,
      meta_json: message.meta ? JSON.stringify(message.meta) : null,
      created_at: message.createdAt,
    });
  }

  listMessages(limit: number): CoachMessage[] {
    const rows = this.listMessagesStmt.all(limit) as { id: string; role: string; text: string; meta_json: string | null; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role as CoachMessage['role'],
      text: r.text,
      meta: parseJson<CoachMessageMeta | null>(r.meta_json, null),
      createdAt: r.created_at,
    }));
  }

  pruneMessages(keep: number): void {
    this.pruneMessagesStmt.run(keep);
  }

  // --- Settings ---

  getSettings(): CoachSettings {
    const row = this.getSettingsStmt.get() as { data: string } | undefined;
    return row ? normalizeCoachSettings(parseJson<unknown>(row.data, null)) : { ...DEFAULT_COACH_SETTINGS };
  }

  saveSettings(settings: CoachSettings, nowIso: string): void {
    this.saveSettingsStmt.run({ data: JSON.stringify(settings), now: nowIso });
  }
}
