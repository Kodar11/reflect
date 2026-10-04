import type { ICoachRepository } from '../../src/database/CoachRepository';
import {
  DEFAULT_COACH_SETTINGS,
  type CoachAction,
  type CoachActionEvent,
  type CoachMemory,
  type CoachMessage,
  type CoachSettings,
} from '../../src/coach/CoachModels';

/**
 * In-memory stand-in for `CoachRepository` with the same semantics, including
 * all-or-nothing transactions (a throw restores every table). Lets the Coach
 * be tested without native SQLite.
 */
export class FakeCoachRepository implements ICoachRepository {
  actions: CoachAction[] = [];
  events: CoachActionEvent[] = [];
  memories: CoachMemory[] = [];
  messages: CoachMessage[] = [];
  settings: CoachSettings = { ...DEFAULT_COACH_SETTINGS };
  /** Set to make the next action insert throw (persistence failure). */
  failNextInsert = false;
  private depth = 0;

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    const snapshot = structuredClone({ actions: this.actions, events: this.events, memories: this.memories, messages: this.messages });
    this.depth++;
    try {
      return fn();
    } catch (err) {
      Object.assign(this, snapshot);
      throw err;
    } finally {
      this.depth--;
    }
  }

  insertAction(action: CoachAction): void {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('disk full');
    }
    this.actions.push(structuredClone(action));
  }

  updateAction(action: CoachAction): void {
    const index = this.actions.findIndex((a) => a.id === action.id);
    if (index >= 0) this.actions[index] = structuredClone(action);
  }

  getAction(id: string): CoachAction | null {
    const action = this.actions.find((a) => a.id === id);
    return action ? structuredClone(action) : null;
  }

  listActions(sinceIso: string): CoachAction[] {
    // Newest first; insertion order breaks ties, like rowid.
    return this.actions
      .map((action, index) => ({ action, index }))
      .filter((x) => x.action.createdAt >= sinceIso)
      .sort((a, b) => (a.action.createdAt < b.action.createdAt ? 1 : a.action.createdAt > b.action.createdAt ? -1 : b.index - a.index))
      .map((x) => structuredClone(x.action));
  }

  listActionsByReport(reportId: string): CoachAction[] {
    return this.actions.filter((a) => a.reportId === reportId).map((a) => structuredClone(a));
  }

  insertActionEvent(event: CoachActionEvent): void {
    this.events.push(structuredClone(event));
  }

  listActionEvents(actionId: string): CoachActionEvent[] {
    return this.events.filter((e) => e.actionId === actionId).map((e) => structuredClone(e));
  }

  insertMemory(memory: CoachMemory): void {
    this.memories.push(structuredClone(memory));
  }

  updateMemory(memory: CoachMemory): void {
    const index = this.memories.findIndex((m) => m.id === memory.id);
    if (index >= 0) this.memories[index] = structuredClone(memory);
  }

  getMemory(id: string): CoachMemory | null {
    const memory = this.memories.find((m) => m.id === id);
    return memory ? structuredClone(memory) : null;
  }

  listMemories(): CoachMemory[] {
    return this.memories
      .map((memory, index) => ({ memory, index }))
      .filter((x) => x.memory.status !== 'removed')
      .sort((a, b) => (a.memory.createdAt < b.memory.createdAt ? 1 : a.memory.createdAt > b.memory.createdAt ? -1 : b.index - a.index))
      .map((x) => structuredClone(x.memory));
  }

  insertMessage(message: CoachMessage): void {
    this.messages.push(structuredClone(message));
  }

  listMessages(limit: number): CoachMessage[] {
    return this.messages.slice(-limit).map((m) => structuredClone(m));
  }

  pruneMessages(keep: number): void {
    this.messages = this.messages.slice(-keep);
  }

  getSettings(): CoachSettings {
    return { ...this.settings };
  }

  saveSettings(settings: CoachSettings): void {
    this.settings = { ...settings };
  }
}
