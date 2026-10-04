import type { WatcherName } from '../../../src/models/Event';
import { PRESET_ROLES, type UserProfileInput } from '../../../src/profile/UserProfile';
import { getDomain } from '../../../src/tracker/browserUrl';
import type { UrlMode } from './config';
import type { DatasetPersona, RawEventInput, ReflectDayInput } from './dataset';
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
