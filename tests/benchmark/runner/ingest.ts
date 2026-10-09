import type { WatcherName } from '../../../src/models/Event';
import { PRESET_ROLES, type UserProfileInput } from '../../../src/profile/UserProfile';
import { getDomain } from '../../../src/tracker/browserUrl';
import type { UrlMode } from './config';
import type { DatasetPersona, DatasetProfileUpdate, RawEventInput, ReflectDayInput } from './dataset';
import type { BenchmarkRuntime } from './runtime';

/**
 * The only door through which dataset content enters Reflect.
 *
 * It accepts `ReflectInput` types and nothing else: there is no parameter
 * through which ground truth could arrive. What it writes is what Reflect's
 * own tracker would have written for the same observation — the mapping below
 * is format only (which watcher name, UTC timestamps, host-only URL), never
 * meaning.
 */

/** Reflect's window watcher is the one that records foreground-window events. */
export const PRODUCTION_WATCHER: WatcherName = 'window';

export interface IngestionMapping {
  watcher: { from: string[]; to: WatcherName };
  timestamps: 'UTC ISO-8601 (Date#toISOString), as the heartbeat engine writes them';
  url: UrlMode;
  payload: 'not stored (null in the dataset)';
}

export interface StoredEventRef {
  datasetId: number;
  /** Row id assigned by Reflect's `events` table. */
  eventId: number;
  startedAt: string;
  endedAt: string;
}

/** Insert one day's raw events through the production `EventRepository`. */
export function ingestDay(runtime: Pick<BenchmarkRuntime, 'events' | 'db'>, day: ReflectDayInput, urlMode: UrlMode): StoredEventRef[] {
  return runtime.db.transaction(() => day.rawEvents.map((event) => insertEvent(runtime, event, urlMode)));
}

function insertEvent(runtime: Pick<BenchmarkRuntime, 'events'>, event: RawEventInput, urlMode: UrlMode): StoredEventRef {
  const startedAt = new Date(event.startedAt).toISOString();
  const endedAt = new Date(event.endedAt).toISOString();
  const eventId = runtime.events.insert({
    watcher: PRODUCTION_WATCHER,
    startedAt,
    endedAt,
    app: event.app,
    browser: event.browser,
    title: event.title,
    url: storedUrl(event.url, urlMode),
    payload: null,
  });
  return { datasetId: event.datasetId, eventId, startedAt, endedAt };
}

/** The tracker keeps only the host of a browser tab (`pollActiveWin` → `getDomain`). */
export function storedUrl(url: string | null, mode: UrlMode): string | null {
  if (url === null) return null;
  return mode === 'domain' ? getDomain(url) : url;
}

/**
 * The onboarding answers this persona would have given.
 *
 * Onboarding offers role chips (`PRESET_ROLES`) and a free-text description;
 * the persona's `type` selects the chips and its one-line `role` is the
 * description. `current_work` and `priorities` map one to one. Nothing about
 * any particular day is included.
 */
export function profileFromPersona(persona: DatasetPersona): UserProfileInput {
  const typeWords = persona.type.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const roles = PRESET_ROLES.filter((role) => typeWords.includes(role.toLowerCase()));
  return {
    roles: [...roles],
    description: persona.role,
    currentWork: [...persona.current_work],
    priorities: [...persona.priorities],
    interests: [],
    additionalContext: null,
  };
}

/**
 * Replay what the user changed in their profile, through the calls the app's
 * own profile form and priority list make: the profile is saved (and the
 * priorities reconciled, as a save does in the app), or one priority is marked
 * completed / paused / active. The simulated clock is already at the moment of
 * the change, so the priority's history records it at the right time — and
 * nothing about it exists in Reflect's database before then.
 *
 * Returns one line per change for the run log. Throws when Reflect does not
 * hold what the dataset says it should: the files were validated, so that is a
 * harness fault, never something to paper over.
 */
export function replayProfileUpdates(runtime: Pick<BenchmarkRuntime, 'userProfileRepo' | 'reflectionService'>, updates: readonly DatasetProfileUpdate[]): string[] {
  const done: string[] = [];
  const saveProfile = (patch: { priorities?: string[]; currentWork?: string[] }, what: string) => {
    const saved = runtime.userProfileRepo.updateProfile(patch);
    for (const [field, wanted] of Object.entries(patch) as ['priorities' | 'currentWork', string[]][]) {
      const stored = saved[field];
      if (stored.length !== wanted.length || stored.some((text, i) => text !== wanted[i])) {
        throw new Error(`Profile update "${what}" does not fit Reflect's profile limits unchanged.\n  wanted: ${JSON.stringify(wanted)}\n  stored: ${JSON.stringify(stored)}`);
      }
    }
    runtime.reflectionService.notifyDataChanged({ kind: 'profile' });
  };
  for (const update of updates) {
    const stated = runtime.userProfileRepo.getProfile().priorities;
    const text = update.priority ?? '';
    if (update.op === 'set_current_work') {
      saveProfile({ currentWork: [...(update.current_work ?? [])] }, 'set_current_work');
      done.push('current work replaced');
    } else if (update.op === 'add') {
      saveProfile({ priorities: [...stated, text] }, `add ${text}`);
      done.push(`added "${text}"`);
    } else if (update.op === 'remove') {
      saveProfile({ priorities: stated.filter((p) => p !== text) }, `remove ${text}`);
      done.push(`removed "${text}"`);
    } else if (update.op === 'rename') {
      saveProfile({ priorities: stated.map((p) => (p === text ? (update.to ?? '') : p)) }, `rename ${text}`);
      done.push(`reworded "${text}" as "${update.to}"`);
    } else {
      const priority = runtime.reflectionService.syncPriorities().find((p) => p.text === text && p.status !== 'archived');
      if (!priority) throw new Error(`Profile update "${update.op} ${text}": Reflect holds no such priority`);
      const status = update.op === 'complete' ? 'completed' : update.op === 'pause' ? 'paused' : 'active';
      runtime.reflectionService.setPriorityStatus(priority.id, status);
      const after = runtime.reflectionService.syncPriorities().find((p) => p.id === priority.id);
      if (after?.status !== status) throw new Error(`Profile update "${update.op} ${text}": the priority is ${after?.status ?? 'missing'}, not ${status}`);
      done.push(`${update.op === 'complete' ? 'completed' : update.op === 'pause' ? 'paused' : 'resumed'} "${text}"`);
    }
  }
  return done;
}

/**
 * Complete onboarding as the persona. Fails loudly if Reflect's own input
 * limits would silently shorten or drop anything the persona states.
 */
export function initializeProfile(runtime: Pick<BenchmarkRuntime, 'userProfileRepo' | 'reflectionService'>, persona: DatasetPersona): UserProfileInput {
  const wanted = profileFromPersona(persona);
  const saved = runtime.userProfileRepo.saveProfile(wanted, 'completed');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  if (
    saved.description !== wanted.description ||
    !same(saved.roles, wanted.roles) ||
    !same(saved.currentWork, wanted.currentWork) ||
    !same(saved.priorities, wanted.priorities)
  ) {
    throw new Error(
      `The persona does not fit Reflect's profile limits unchanged.\n  wanted: ${JSON.stringify(wanted)}\n  stored: ${JSON.stringify(saved)}`,
    );
  }
  // What saving the profile triggers in the app (profile change → priorities reconciled).
  runtime.reflectionService.notifyDataChanged({ kind: 'profile' });
  return wanted;
}
