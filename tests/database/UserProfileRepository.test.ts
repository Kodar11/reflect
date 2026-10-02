import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';

/**
 * Integration tests against real SQLite. Self-skips when the native binary is
 * built for Electron's ABI instead of Node's (see EventRepository.test.ts).
 */
const nativeOk = (() => {
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const repoSuite = nativeOk ? describe : describe.skip;

const answers = {
  roles: ['Student', 'Software Developer'],
  description: 'Final-year CS student.',
  currentWork: ['College studies', 'Reflect'],
  priorities: ['Finish my degree'],
  interests: ['Gaming'],
  additionalContext: 'My Game Theory project is a hobby.',
};

repoSuite('UserProfileRepository (integration, real SQLite)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let repo: UserProfileRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-profile-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database(dbPath);
    repo = new UserProfileRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty, not-started profile when nothing is stored', () => {
    const p = repo.getProfile();
    expect(p.onboardingStatus).toBe('not_started');
    expect(p.roles).toEqual([]);
    expect(p.description).toBeNull();
    expect(p.createdAt).toBeNull();
    expect(repo.getOnboardingStatus()).toBe('not_started');
  });

  it('creates and reads back a profile', () => {
    const saved = repo.saveProfile(answers, 'completed');
    expect(saved).toMatchObject({ ...answers, onboardingStatus: 'completed' });
    expect(saved.createdAt).not.toBeNull();
    expect(repo.getProfile()).toEqual(saved);
  });

  it('normalizes input on write', () => {
    const saved = repo.saveProfile({
      roles: ['  Student ', 'student', ''],
      description: '   ',
      currentWork: ['Reflect', 'reflect'],
      priorities: [],
      interests: [' Music '],
      additionalContext: null,
    });
    expect(saved.roles).toEqual(['Student']);
    expect(saved.description).toBeNull();
    expect(saved.currentWork).toEqual(['Reflect']);
    expect(saved.interests).toEqual(['Music']);
  });

  it('keeps the current status when save is called without one', () => {
    repo.updateProfile({ onboardingStatus: 'in_progress' });
    expect(repo.saveProfile(answers).onboardingStatus).toBe('in_progress');
  });

  it('updates individual fields without touching others', () => {
    repo.saveProfile(answers, 'in_progress');
    const updated = repo.updateProfile({ interests: ['Reading', 'Football'] });
    expect(updated.interests).toEqual(['Reading', 'Football']);
    expect(updated.roles).toEqual(answers.roles);
    expect(updated.additionalContext).toBe(answers.additionalContext);
    expect(updated.onboardingStatus).toBe('in_progress');
  });

  it('tracks every onboarding status', () => {
    for (const status of ['in_progress', 'completed', 'skipped', 'not_started'] as const) {
      repo.updateProfile({ onboardingStatus: status });
      expect(repo.getOnboardingStatus()).toBe(status);
    }
  });

  it('rejects an invalid status', () => {
    expect(() => repo.updateProfile({ onboardingStatus: 'bogus' as any })).toThrow(/Invalid onboarding status/);
  });

  it('persists across restart (re-opening the database)', () => {
    repo.saveProfile(answers, 'completed');
    db.close();

    db = new Database(dbPath);
    repo = new UserProfileRepository(db);
    expect(repo.getProfile()).toMatchObject({ ...answers, onboardingStatus: 'completed' });
  });

  it('persists the skipped state across restart', () => {
    repo.updateProfile({ onboardingStatus: 'skipped' });
    db.close();

    db = new Database(dbPath);
    repo = new UserProfileRepository(db);
    expect(repo.getOnboardingStatus()).toBe('skipped');
  });

  it('preserves createdAt and advances updatedAt on later writes', () => {
    let t = Date.parse('2026-01-01T00:00:00.000Z');
    repo = new UserProfileRepository(db, () => new Date(t));
    const first = repo.saveProfile(answers, 'in_progress');
    t += 60_000;
    const second = repo.updateProfile({ onboardingStatus: 'completed' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('clears the profile back to not started', () => {
    repo.saveProfile(answers, 'completed');
    repo.clearProfile();
    expect(repo.getProfile().onboardingStatus).toBe('not_started');
    expect(repo.getProfile().roles).toEqual([]);
  });

  it('leaves raw events untouched', () => {
    const events = new EventRepository(db);
    events.insert({
      watcher: 'window',
      startedAt: '2026-01-01T09:00:00.000Z',
      endedAt: '2026-01-01T09:05:00.000Z',
      app: 'VS Code',
      title: 'App.tsx',
    });
    const before = events.getAll();

    repo.saveProfile(answers, 'completed');
    repo.updateProfile({ interests: ['Music'] });
    repo.clearProfile();

    expect(events.getAll()).toEqual(before);
  });
});
