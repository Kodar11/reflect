import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import type { EventClassification } from '../../src/categorization/Classification';
import type { IFocusRepository } from '../../src/database/FocusRepository';

/**
 * Integration tests for event-level classification persistence.
 * Uses real better-sqlite3 and exercises Database, repositories, and service.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-event-class-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
  }
})();

const suite = nativeOk ? describe : describe.skip;

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-event-class-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

function makeFocusRepo(): IFocusRepository {
  return {
    getSessionsByRange: () => [],
    getProfiles: () => [],
  } as unknown as IFocusRepository;
}

suite('EventClassification persistence', () => {
  let dbPath: string;
  let db: Database;
  let eventRepo: EventRepository;
  let catRepo: CategorizationRepository;
  let activityRepo: ActivityRuleRepository;
  let service: CategorizationService;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new Database(dbPath);
    eventRepo = new EventRepository(db);
    catRepo = new CategorizationRepository(db);
    activityRepo = new ActivityRuleRepository(db);
    service = new CategorizationService(activityRepo, catRepo, makeFocusRepo());
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  function insertEvent(app = 'Brave Browser'): number {
    return eventRepo.insert({
      watcher: 'window',
      startedAt: '2026-01-01T09:00:00.000Z',
      endedAt: '2026-01-01T09:05:00.000Z',
      app,
      title: 'Test event',
    });
  }

  it('saves and retrieves a full event classification', () => {
    const eventId = insertEvent();

    const classification: EventClassification = {
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    };

    service.saveEventClassification(classification);
    const retrieved = service.getEventClassification(eventId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.eventId).toBe(eventId);
    expect(retrieved?.contextId).toBe('coding');
    expect(retrieved?.areaId).toBe('area_work');
    expect(retrieved?.intentId).toBe('intent_create');
    expect(retrieved?.qualityId).toBe('quality_focused');
    expect(retrieved?.source).toBe('user_override');
    expect(retrieved?.ruleId).toBeNull();
    expect(retrieved?.createdAt).toBeDefined();
    expect(retrieved?.updatedAt).toBeDefined();
  });

  it('updates an existing event classification and keeps exactly one row', () => {
    const eventId = insertEvent();

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    });

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_research',
      qualityId: 'quality_deep_work',
      source: 'user_override',
      ruleId: null,
    });

    const raw = new BetterSqliteDB(dbPath);
    const count = (raw.prepare('SELECT COUNT(*) as count FROM event_classifications WHERE event_id = ?').get(eventId) as { count: number }).count;
    expect(count).toBe(1);
    raw.close();

    const retrieved = service.getEventClassification(eventId);
    expect(retrieved?.intentId).toBe('intent_research');
    expect(retrieved?.qualityId).toBe('quality_deep_work');
  });

  it('supports null contextId and intentId', () => {
    const eventId = insertEvent();

    service.saveEventClassification({
      eventId,
      contextId: null,
      areaId: 'area_work',
      intentId: null,
      qualityId: 'quality_routine',
      source: 'user_override',
      ruleId: null,
    });

    const retrieved = service.getEventClassification(eventId);
    expect(retrieved?.contextId).toBeNull();
    expect(retrieved?.areaId).toBe('area_work');
    expect(retrieved?.intentId).toBeNull();
    expect(retrieved?.qualityId).toBe('quality_routine');
  });

  it('deletes an event classification', () => {
    const eventId = insertEvent();

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    });

    expect(service.getEventClassification(eventId)).not.toBeNull();

    service.deleteEventClassification(eventId);

    expect(service.getEventClassification(eventId)).toBeNull();
  });

  it('retrieves multiple event classifications in one call', () => {
    const id1 = insertEvent('A');
    const id2 = insertEvent('B');
    const id3 = insertEvent('C');

    service.saveEventClassification({
      eventId: id1,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    });
    service.saveEventClassification({
      eventId: id2,
      contextId: 'learning',
      areaId: 'area_personal',
      intentId: 'intent_learn',
      qualityId: 'quality_routine',
      source: 'user_override',
      ruleId: null,
    });
    service.saveEventClassification({
      eventId: id3,
      contextId: 'chatgpt',
      areaId: 'area_work',
      intentId: 'intent_research',
      qualityId: 'quality_deep_work',
      source: 'user_override',
      ruleId: null,
    });

    const results = service.getEventClassifications([id1, id2, id3]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.eventId).sort()).toEqual([id1, id2, id3].sort());
  });

  it('returns empty array when getting classifications for empty event id list', () => {
    expect(service.getEventClassifications([])).toEqual([]);
  });

  it('rejects an invalid dimension type', () => {
    const eventId = insertEvent();

    expect(() =>
      service.saveEventClassification({
        eventId,
        contextId: 'coding',
        areaId: 'intent_create', // wrong dimension
        intentId: 'intent_research',
        qualityId: 'quality_focused',
        source: 'user_override',
        ruleId: null,
      }),
    ).toThrow(/Invalid areaId/);
  });

  it('rejects an invalid context id', () => {
    const eventId = insertEvent();

    expect(() =>
      service.saveEventClassification({
        eventId,
        contextId: 'nonexistent_activity',
        areaId: 'area_work',
        intentId: 'intent_research',
        qualityId: 'quality_focused',
        source: 'user_override',
        ruleId: null,
      }),
    ).toThrow(/Invalid contextId/);
  });

  it('rejects an invalid source value', () => {
    const eventId = insertEvent();

    expect(() =>
      service.saveEventClassification({
        eventId,
        contextId: 'coding',
        areaId: 'area_work',
        intentId: 'intent_research',
        qualityId: 'quality_focused',
        source: 'bogus_source' as any,
        ruleId: null,
      }),
    ).toThrow(/Invalid event classification source/);
  });

  it('forces ruleId to null when source is user_override', () => {
    const eventId = insertEvent();

    activityRepo.saveRule({
      id: 'rule_test',
      activityId: 'coding',
      conditions: '[]',
      enabled: 1,
      priority: 0,
      areaId: null,
      intentId: null,
      qualityId: null,
    });

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_research',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: 'rule_test',
    });

    const retrieved = service.getEventClassification(eventId);
    expect(retrieved?.source).toBe('user_override');
    expect(retrieved?.ruleId).toBeNull();
  });

  it('allows a non-null ruleId when source is user_rule', () => {
    const eventId = insertEvent();

    activityRepo.saveRule({
      id: 'rule_test',
      activityId: 'coding',
      conditions: '[]',
      enabled: 1,
      priority: 0,
      areaId: null,
      intentId: null,
      qualityId: null,
    });

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_research',
      qualityId: 'quality_focused',
      source: 'user_rule',
      ruleId: 'rule_test',
    });

    const retrieved = service.getEventClassification(eventId);
    expect(retrieved?.source).toBe('user_rule');
    expect(retrieved?.ruleId).toBe('rule_test');
  });

  it('cascades deletion when the parent event is deleted', () => {
    const eventId = insertEvent();

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    });

    expect(service.getEventClassification(eventId)).not.toBeNull();

    const raw = new BetterSqliteDB(dbPath);
    raw.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    raw.close();

    expect(service.getEventClassification(eventId)).toBeNull();
  });

  it('keeps categorization_overrides independent from event_classifications', () => {
    const eventId = insertEvent();

    service.saveEventClassification({
      eventId,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'user_override',
      ruleId: null,
    });

    service.saveOverride(
      [eventId],
      { contextId: 'learning', areaId: 'area_personal', intentId: 'intent_learn', qualityId: 'quality_routine' },
      false,
    );

    const eventClass = service.getEventClassification(eventId);
    const overrides = service.listOverrides();

    expect(eventClass?.contextId).toBe('coding');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].contextId).toBe('learning');
  });
});
