import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_LIMITS } from '../../../src/profile/UserProfile';

/**
 * The benchmark dataset: schema, loader, validator, and the split between what
 * Reflect may see and what only the evaluator may see.
 *
 * Two objects leave this module and they never meet again until scoring:
 *
 *   ReflectInput    raw observable events + the persona a real user would have
 *                   typed into onboarding. The ONLY thing the runner hands to
 *                   production services.
 *   EvaluationOnly  ground truth, expected reflection, expected coach outcome.
 *                   Imported by `evaluators/` and by nothing under `runner/`
 *                   that touches a production service.
 *
 * The validator reports problems; it never repairs them.
 */

// ── Raw file schema (exactly what is on disk) ───────────────────────────────

export interface DatasetPersona {
  id: string;
  type: string;
  role: string;
  current_work: string[];
  priorities: string[];
}

/**
 * The persona as a day file states it. Day 1 is the profile Reflect is onboarded
 * with. A later day may restate `current_work` / `priorities` in its own words
 * or leave them out: that is the answer key's view of what the day was about —
 * evaluation context, never sent to Reflect.
 */
export interface DatasetDayPersona {
  id: string;
  type: string;
  role: string;
  current_work?: string[];
  priorities?: string[];
}

export interface DatasetRawEvent {
  id: number;
  watcher: string;
  started_at: string;
  ended_at: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  payload: unknown;
}

export interface DatasetGroundTruthActivity {
  id: string;
  started_at: string;
  ended_at: string;
  title: string;
  summary: string;
  /** Empty for time away from the screen that the key describes as an activity; such an activity is never scored. */
  event_ids: number[];
  context: string;
  area: string | null;
  intent: string;
  quality: string;
  importance: string;
  /** Key of the persona's work stream this activity belongs to (`persona_key.json`); null for none. Optional. */
  stream?: string | null;
  /** The key's original free-text labels, kept where canonical ones replaced them. Never read by the evaluator. */
  label_notes?: Record<string, string | null>;
}

/**
 * A change the user made to their own profile on this day — what a real user
 * does in Reflect's settings when a piece of work is finished or a new one
 * arrives. It is INPUT: the harness replays it through the production profile
 * and priority APIs at the simulated moment, and Reflect sees nothing of it
 * before that moment. It never says what the day's evidence shows.
 *
 *   add / remove       the priority enters or leaves the stated list
 *   complete / pause   the user marks it done or sets it aside; it stays in the record
 *   resume             a paused or completed priority is taken up again
 *   rename             the same priority, reworded (`to`)
 *   set_current_work   the "currently working on" list is replaced
 */
export const PROFILE_UPDATE_OPS = ['add', 'remove', 'complete', 'pause', 'resume', 'rename', 'set_current_work'] as const;
export interface DatasetProfileUpdate {
  /** `start`: before the day's first tracked event. `end`: in the evening, before the day is reflected on. */
  at: 'start' | 'end';
  op: (typeof PROFILE_UPDATE_OPS)[number];
  /** Text of the stated priority the change concerns (every op but `set_current_work`). */
  priority?: string;
  /** The new wording, for `rename`. */
  to?: string;
  current_work?: string[];
}

/**
 * A body of work (or of time) the persona's month contains — the answer key's
 * stable name for "what this is about". Activities, coach targets and the
 * priority a piece of work serves are all stated against these keys, so nothing
 * in the evaluator has to recognise a project by the words a particular
 * persona's files happen to use for it. Benchmark metadata only: no production
 * code ever sees a stream key.
 */
export interface DatasetWorkStream {
  title: string;
  kind: 'work' | 'leisure' | 'personal';
  /** Names by which the work shows up in titles and recommendations ("DBMS", "Northstar"). Lower-case, matched as whole words. */
  aliases: string[];
  /** Stated priorities (their text at any point of the month) that this work serves. */
  priorities: string[];
}

/** `persona_key.json`: the persona-level part of the answer key. Never sent to Reflect. */
export interface DatasetPersonaKey {
  work_streams: Record<string, DatasetWorkStream>;
}

export const PERSONA_KEY_FILE = 'persona_key.json';

export interface DatasetUnobservedPeriod {
  started_at: string;
  ended_at: string;
  reason: string;
}

export interface DatasetExpectedAction {
  title: string;
  action_type: string;
  reason: string;
  suggested_focus_minutes: number | null;
  target: string | null;
  /** The work stream the move is aimed at, by key. When present it — not the wording of `target` — is what an action is matched against. */
  target_stream?: string | null;
}

/**
 * Whether the day holds a next move worth recommending — the ground truth for
 * "should the Coach have said anything at all?".
 *
 *   strong    a useful next action clearly exists; staying silent is a miss
 *   moderate  an action may reasonably be offered; silence is equally fine
 *   none      nothing is worth recommending; any action is unnecessary
 */
export const OPPORTUNITY_STRENGTHS = ['strong', 'moderate', 'none'] as const;
export type OpportunityStrength = (typeof OPPORTUNITY_STRENGTHS)[number];

export interface DatasetActionOpportunity {
  /** True exactly when `strength` is "strong". */
  should_exist: boolean;
  strength: OpportunityStrength;
  reason: string;
  /** The stated priority (or work stream) the opportunity concerns, when it concerns one. */
  priority: string | null;
  /** The kind of action that would fit, in the answer key's own vocabulary. */
  type: string | null;
}

export const SCENARIO_DECISIONS = ['accepted', 'rejected', 'deferred', 'not_applicable'] as const;
export const SCENARIO_EXECUTIONS = ['done', 'partial', 'not_done', 'not_applicable'] as const;
export const SCENARIO_OUTCOMES = ['worked', 'partly_worked', 'did_not_work', 'not_applicable'] as const;

/**
 * What the simulated user does with the day's recommendation, and what then
 * happened. Three separate facts: deciding, doing, and whether it helped.
 * None of them says the recommendation was right or wrong.
 */
export interface DatasetExecutionScenario {
  user_decision: (typeof SCENARIO_DECISIONS)[number];
  execution: (typeof SCENARIO_EXECUTIONS)[number];
  outcome: (typeof SCENARIO_OUTCOMES)[number];
  /** Why, in words — evaluation metadata; never sent to Reflect. */
  reason: string;
  /** The reason the user would pick from Reflect's own list, when they give one. */
  reason_code?: string | null;
}

/**
 * A recommendation that was already on the user's Coach panel when the day
 * began, and what the user did with it — history, not an answer key. It lets a
 * scenario ask "given THIS history, what does the Coach do next?" without
 * depending on the Coach having happened to make that recommendation the day
 * before. The harness stores it through the Coach's own repository and plays
 * the user's part through the Coach's own service calls.
 */
export interface DatasetSeedAction {
  title: string;
  /** A Reflect `CoachActionType`. */
  action_type: string;
  daypart: string;
  focus_minutes: number | null;
  /** Text of the stated priority it was aimed at. */
  priority: string;
  user_decision: 'accepted' | 'rejected' | 'deferred';
  execution: (typeof SCENARIO_EXECUTIONS)[number];
  outcome: (typeof SCENARIO_OUTCOMES)[number];
  reason_code?: string | null;
}

/** How a priority fared: against a named priority, or as a plain statement. */
export type DatasetPriorityAlignment = { priority: string; assessment: string } | string;

export interface DatasetDayFile {
  persona: DatasetDayPersona;
  day: {
    day_number: number;
    date: string;
    day_type: string;
    circumstances: string[];
    laptop_usage: {
      first_seen: string;
      last_seen: string;
      approx_active_hours: number;
      longest_unobserved_gap_minutes: number;
    };
  };
  raw_events: DatasetRawEvent[];
  ground_truth: {
    activities: DatasetGroundTruthActivity[];
    unobserved_periods: DatasetUnobservedPeriod[];
  };
  expected_reflection: {
    period: string;
    key_observations: string[];
    priority_alignment: DatasetPriorityAlignment[];
    important_uncertainty: string[];
    possible_next_step: string;
  };
  expected_coach_outcome: {
    primary_action: DatasetExpectedAction | null;
    secondary_action: DatasetExpectedAction | null;
    things_not_to_do: string[];
    /** Optional. Absent: "strong" when a primary action is expected, otherwise "none". */
    action_opportunity?: DatasetActionOpportunity;
    /** Optional. Absent: the simulated user never answers. */
    execution_scenario?: DatasetExecutionScenario;
    /**
     * Optional. What the simulated user does with a recommendation aimed at each work stream — the same three facts
     * as `execution_scenario`, for whichever body of work the Coach actually pointed at. With it, a recommendation
     * aimed somewhere other than the expected move still gets the response that work really had the next day.
     */
    response_by_stream?: Record<string, DatasetExecutionScenario>;
    /** Optional. The key's actions as first written, kept where a day's expectation was restated as "say nothing". Never scored. */
    original_actions?: { primary_action: DatasetExpectedAction | null; secondary_action: DatasetExpectedAction | null };
    /** Optional. Other work streams a good recommendation could equally be aimed at today (full credit). */
    acceptable_streams?: string[];
    /** Optional. Work streams a recommendation must NOT be aimed at today: finished, handed off, or deliberately parked. */
    forbidden_streams?: string[];
  };
  /** Optional; evaluation-only when present. */
  evaluation_objectives?: unknown;
  /** Optional. Recommendations made the evening before this day, with the user's answer to each. */
  coach_history?: DatasetSeedAction[];
  /** Optional. Changes the user made to their profile on this day. Input, replayed at its simulated time. */
  profile_updates?: DatasetProfileUpdate[];
}

// ── The two halves ──────────────────────────────────────────────────────────

/** One observable event, exactly as tracked. Carries no label of any kind. */
export interface RawEventInput {
  /** The dataset's id for this event (the evaluator's key back to ground truth). */
  datasetId: number;
  watcher: string;
  startedAt: string;
  endedAt: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
}

export interface ReflectDayInput {
  dayNumber: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  rawEvents: RawEventInput[];
  /** What the user changed in their profile on this day, in file order. */
  profileUpdates: DatasetProfileUpdate[];
}

/** Everything Reflect is allowed to receive. */
export interface ReflectInput {
  persona: DatasetPersona;
  /** UTC offset every timestamp in the dataset carries, e.g. `+05:30`. */
  utcOffset: string;
  days: ReflectDayInput[];
}

/** The answer key for one day. Never passed to a production service. */
export interface EvaluationOnlyDay {
  dayNumber: number;
  date: string;
  utcOffset: string;
  dayType: string;
  circumstances: string[];
  /** The priorities this day's file states (day 1's where it states none) — the answer key's own view of the day. */
  statedPriorities: string[];
  /** The stated priorities as the profile replay leaves them at the end of this day: text → status. What Reflect was told. */
  profilePriorities: { text: string; status: 'active' | 'completed' | 'paused' }[];
  laptopUsage: DatasetDayFile['day']['laptop_usage'];
  /** The day's raw events as the dataset states them (for interval math). */
  events: { datasetId: number; startMs: number; endMs: number; app: string | null; title: string | null; url: string | null }[];
  groundTruth: DatasetDayFile['ground_truth'];
  expectedReflection: DatasetDayFile['expected_reflection'];
  expectedCoachOutcome: DatasetDayFile['expected_coach_outcome'];
  evaluationObjectives: unknown;
  /** Seeded history the simulated user plays out before this day's reflection. */
  coachHistory: DatasetSeedAction[];
}

export interface EvaluationOnly {
  /** Every priority any day's file states. */
  priorities: string[];
  /** The persona's work streams, by key. Empty when the persona has no `persona_key.json`. */
  streams: Record<string, DatasetWorkStream>;
  days: EvaluationOnlyDay[];
}

export interface LoadedDataset {
  dir: string;
  /** `sha256:<16 hex>` over the observable half only (persona + raw events). An answer-key edit leaves it unchanged. */
  inputVersion: string;
  /** `sha256:<16 hex>` over every file's name and bytes, in order. */
  version: string;
  files: { name: string; sha256: string }[];
  days: DatasetDayFile[];
  /** `persona_key.json`, when the persona has one. */
  personaKey: DatasetPersonaKey | null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warning';

export interface DatasetIssue {
  severity: IssueSeverity;
  code: string;
  file: string;
  /** JSON-ish path inside the file, e.g. `ground_truth.activities[5].ended_at`. */
  where: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: DatasetIssue[];
  errors: DatasetIssue[];
  warnings: DatasetIssue[];
  stats: { days: number; rawEvents: number; groundTruthActivities: number; firstDate: string | null; lastDate: string | null; utcOffset: string | null };
}

export class DatasetValidationError extends Error {
  constructor(public readonly result: ValidationResult) {
    super(
      `Benchmark dataset is invalid: ${result.errors.length} error(s).\n` +
        result.errors.map((e) => `  [${e.code}] ${e.file} ${e.where}: ${e.message}`).join('\n'),
    );
    this.name = 'DatasetValidationError';
  }
}

/** `reflect_day_NN.json`, or with the persona between: `reflect_student_day_NN.json`. */
export const DAY_FILE_PATTERN = /^reflect_(?:[a-z0-9]+_)*day_(\d{2})\.json$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const TOP_LEVEL_KEYS = ['persona', 'day', 'raw_events', 'ground_truth', 'expected_reflection', 'expected_coach_outcome'] as const;
const OPTIONAL_TOP_LEVEL_KEYS = ['evaluation_objectives', 'coach_history', 'profile_updates'];
const EVENT_KEYS = ['id', 'watcher', 'started_at', 'ended_at', 'app', 'browser', 'title', 'url', 'payload'];
const ACTIVITY_KEYS = ['id', 'started_at', 'ended_at', 'title', 'summary', 'event_ids', 'context', 'area', 'intent', 'quality', 'importance'];
const ACTION_KEYS = ['title', 'action_type', 'reason', 'suggested_focus_minutes', 'target'];

/** `+05:30` / `Z` suffix of an ISO timestamp. */
export function utcOffsetOf(iso: string): string {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  return m ? (m[1] === 'Z' ? '+00:00' : m[1]) : '';
}

/** `HH:MM` on `date` in the dataset's offset → epoch ms. */
export function clockToMs(date: string, hhmm: string, utcOffset: string): number {
  return Date.parse(`${date}T${hhmm}:00${utcOffset}`);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || isString(v);

// ── Profile replay (pure) ───────────────────────────────────────────────────

/** The stated profile at one moment of the simulated month. */
export interface ProfileState {
  /** In the order the user's list shows them. */
  priorities: { text: string; status: 'active' | 'completed' | 'paused' }[];
  currentWork: string[];
}

export function initialProfileState(persona: { current_work?: string[]; priorities?: string[] }): ProfileState {
  return { priorities: (persona.priorities ?? []).map((text) => ({ text, status: 'active' as const })), currentWork: [...(persona.current_work ?? [])] };
}

/**
 * Apply one profile change. Returns the new state, or a message saying why the
 * change is impossible (a priority that is not there, a list longer than the
 * profile takes, text longer than a field holds). Pure: the same rules the
 * validator checks the files with are the ones the harness replays with.
 */
export function applyProfileUpdate(state: ProfileState, update: DatasetProfileUpdate): { state: ProfileState } | { error: string } {
  const priorities = state.priorities.map((p) => ({ ...p }));
  const fits = (text: unknown): text is string => isString(text) && text.trim().length > 0 && text.length <= PROFILE_LIMITS.tagLength;
  const index = priorities.findIndex((p) => p.text === update.priority);
  const done = (next: ProfileState) => ({ state: next });

  if (update.op === 'set_current_work') {
    if (!isStringArray(update.current_work) || update.current_work.length > PROFILE_LIMITS.currentWork || !update.current_work.every(fits)) {
      return { error: `set_current_work needs current_work[] of at most ${PROFILE_LIMITS.currentWork} entries of at most ${PROFILE_LIMITS.tagLength} characters` };
    }
    return done({ priorities, currentWork: [...update.current_work] });
  }
  if (!fits(update.priority)) return { error: `"${update.op}" needs the priority's text (at most ${PROFILE_LIMITS.tagLength} characters)` };

  if (update.op === 'add') {
    if (index !== -1) return { error: `the priority "${update.priority}" is already stated` };
    if (priorities.length >= PROFILE_LIMITS.priorities) return { error: `the profile already holds ${PROFILE_LIMITS.priorities} priorities; remove one first` };
    priorities.push({ text: update.priority, status: 'active' });
    return done({ priorities, currentWork: state.currentWork });
  }
  if (index === -1) return { error: `the priority "${update.priority}" is not stated at this point` };
  const current = priorities[index];
  if (update.op === 'remove') priorities.splice(index, 1);
  else if (update.op === 'complete' || update.op === 'pause') {
    if (current.status !== 'active') return { error: `the priority "${update.priority}" is already ${current.status}` };
    current.status = update.op === 'complete' ? 'completed' : 'paused';
  } else if (update.op === 'resume') {
    if (current.status === 'active') return { error: `the priority "${update.priority}" is active; there is nothing to resume` };
    current.status = 'active';
  } else if (update.op === 'rename') {
    if (!fits(update.to)) return { error: `"rename" needs the new wording in "to" (at most ${PROFILE_LIMITS.tagLength} characters)` };
    if (priorities.some((p) => p.text === update.to)) return { error: `the priority "${update.to}" is already stated` };
    current.text = update.to;
  }
  return done({ priorities, currentWork: state.currentWork });
}

/** The profile at the end of each day (index = position in `days`), replaying every day's updates in order. Invalid updates are skipped. */
export function profileByDay(days: Pick<DatasetDayFile, 'persona' | 'profile_updates'>[]): ProfileState[] {
  let state = initialProfileState(days[0]?.persona ?? {});
  return days.map((day) => {
    for (const update of day.profile_updates ?? []) {
      const result = applyProfileUpdate(state, update);
      if ('state' in result) state = result.state;
    }
    return state;
  });
}

/** Read every day file. Throws only when the directory or a file is unreadable JSON-wise is reported by `validate`. */
export function readDatasetFiles(dir: string): { name: string; text: string }[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Benchmark dataset directory not found: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json') && name !== PERSONA_KEY_FILE)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * Validate the dataset as it is on disk. Pure with respect to the dataset:
 * nothing is rewritten, defaulted or skipped.
 */
export function validateDataset(dir: string, expectedDays: number): ValidationResult & { dataset: LoadedDataset | null } {
  const issues: DatasetIssue[] = [];
  const add = (severity: IssueSeverity, code: string, file: string, where: string, message: string) =>
    issues.push({ severity, code, file, where, message });

  const files = readDatasetFiles(dir);
  const parsed: { name: string; number: number; data: DatasetDayFile }[] = [];

  for (const file of files) {
    const match = DAY_FILE_PATTERN.exec(file.name);
    if (!match) {
      add('error', 'unexpected_file', file.name, '', `File name does not match reflect_day_NN.json or reflect_<persona>_day_NN.json`);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(file.text);
    } catch (err) {
      add('error', 'invalid_json', file.name, '', `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isObject(data)) {
      add('error', 'invalid_shape', file.name, '', 'Top level is not an object');
      continue;
    }
    parsed.push({ name: file.name, number: Number(match[1]), data: data as unknown as DatasetDayFile });
  }

  // Days are checked in day order, whatever the file names sort as.
  parsed.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  // ── Day set ──
  const numbers = parsed.map((p) => p.number);
  if (parsed.length !== expectedDays) {
    add('error', 'day_count', '(dataset)', '', `Expected exactly ${expectedDays} day files, found ${parsed.length}`);
  }
  for (let n = 1; n <= expectedDays; n++) {
    if (!numbers.includes(n)) add('error', 'missing_day', '(dataset)', '', `The day ${String(n).padStart(2, '0')} file is missing`);
  }
  // Two files for one day number: only a second naming style in the same directory can cause it.
  for (const p of parsed) {
    const twin = parsed.find((other) => other !== p && other.number === p.number && other.name < p.name);
    if (twin) add('error', 'duplicate_day_file', p.name, '', `Day ${p.number} already has the file ${twin.name}`);
  }

  const seenEventIds = new Map<number, string>();
  const seenDayNumbers = new Map<number, string>();
  const seenDates = new Map<string, string>();
  const offsets = new Set<string>();
  let identity: string | null = null;
  let previous: { name: string; date: string; lastEventId: number; lastEndMs: number } | null = null;
  let rawEvents = 0;
  let groundTruthActivities = 0;

  for (const { name, number, data } of parsed) {
    const err = (code: string, where: string, message: string) => add('error', code, name, where, message);
    const warn = (code: string, where: string, message: string) => add('warning', code, name, where, message);

    // ── Sections ──
    let sectionsOk = true;
    for (const key of TOP_LEVEL_KEYS) {
      if (!(key in data)) {
        err('missing_section', key, 'Required section is missing');
        sectionsOk = false;
      }
    }
    for (const key of Object.keys(data)) {
      if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key) && !OPTIONAL_TOP_LEVEL_KEYS.includes(key)) {
        warn('unknown_section', key, 'Unknown top-level section; it is ignored by the runner and the evaluator');
      }
    }
    if (!sectionsOk) continue;

    // ── Persona ──
    const persona = data.persona as unknown;
    const optionalList = (key: string) => !isObject(persona) || !(key in persona) || isStringArray(persona[key]);
    /** The priorities this very file states — what its priority alignment has to name. */
    let ownPriorities: string[] | null = null;
    if (!isObject(persona) || !isString(persona.id) || !isString(persona.type) || !isString(persona.role) || !optionalList('current_work') || !optionalList('priorities')) {
      err('persona_shape', 'persona', 'Expected { id, type, role, current_work[], priorities[] }');
    } else {
      if (isStringArray(persona.priorities)) ownPriorities = persona.priorities;
      const who = JSON.stringify([persona.id, persona.type, persona.role]);
      if (identity === null) {
        identity = who;
        // The first file is the profile Reflect is onboarded with: it has to be whole, and enterable.
        if (!isStringArray(persona.current_work) || !isStringArray(persona.priorities)) {
          err('persona_shape', 'persona', 'The first day must state current_work[] and priorities[]: it is the profile Reflect is onboarded with');
        } else {
          const tooLong = [...persona.current_work, ...persona.priorities].filter((text) => text.length > PROFILE_LIMITS.tagLength);
          if (tooLong.length > 0 || persona.current_work.length > PROFILE_LIMITS.currentWork || persona.priorities.length > PROFILE_LIMITS.priorities) {
            warn(
              'profile_over_limit',
              'persona',
              `Reflect's profile takes ${PROFILE_LIMITS.priorities} priorities and ${PROFILE_LIMITS.currentWork} work items of at most ${PROFILE_LIMITS.tagLength} characters; ` +
                `${tooLong.length} entr${tooLong.length === 1 ? 'y is' : 'ies are'} longer, so onboarding as this persona will be refused`,
            );
          }
        }
      } else if (who !== identity) {
        err('persona_changed', 'persona', 'id, type or role differs from day 1; a later day may restate only current_work and priorities');
      }
    }

    // ── Day ──
    const day = data.day;
    let date: string | null = null;
    if (!isObject(day)) {
      err('day_shape', 'day', 'Expected an object');
    } else {
      if (!Number.isInteger(day.day_number)) err('day_number', 'day.day_number', 'Expected an integer');
      else {
        if (day.day_number !== number) err('day_number_mismatch', 'day.day_number', `day_number ${day.day_number} does not match file number ${number}`);
        const earlier = seenDayNumbers.get(day.day_number);
        if (earlier) err('duplicate_day_number', 'day.day_number', `day_number ${day.day_number} already used by ${earlier}`);
        seenDayNumbers.set(day.day_number, name);
      }
      if (!isString(day.date) || !DATE.test(day.date) || Number.isNaN(Date.parse(`${day.date}T00:00:00Z`))) {
        err('day_date', 'day.date', `Expected YYYY-MM-DD, got ${JSON.stringify(day.date)}`);
      } else {
        date = day.date;
        const earlier = seenDates.get(date);
        if (earlier) err('duplicate_date', 'day.date', `Date ${date} already used by ${earlier}`);
        seenDates.set(date, name);
        if (previous) {
          if (date <= previous.date) err('date_order', 'day.date', `Date ${date} is not after ${previous.date} (${previous.name})`);
          else if (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`) !== 86_400_000) {
            warn('date_gap', 'day.date', `Date ${date} does not directly follow ${previous.date}`);
          }
        }
      }
      if (!isString(day.day_type)) err('day_type', 'day.day_type', 'Expected a string');
      if (!isStringArray(day.circumstances)) err('circumstances', 'day.circumstances', 'Expected string[]');
      const usage = day.laptop_usage;
      if (!isObject(usage) || !isString(usage.first_seen) || !isString(usage.last_seen)) {
        err('laptop_usage', 'day.laptop_usage', 'Expected { first_seen, last_seen, ... }');
      } else {
        for (const key of ['first_seen', 'last_seen'] as const) {
          if (!CLOCK.test(usage[key])) err('malformed_time', `day.laptop_usage.${key}`, `Expected HH:MM, got ${JSON.stringify(usage[key])}`);
        }
      }
    }

    // ── Raw events ──
    const events = data.raw_events;
    const dayEvents = new Map<number, DatasetRawEvent>();
    let firstEvent: DatasetRawEvent | null = null;
    let lastEvent: DatasetRawEvent | null = null;
    if (!Array.isArray(events) || events.length === 0) {
      err('raw_events', 'raw_events', 'Expected a non-empty array');
    } else {
      rawEvents += events.length;
      let prevStart = -Infinity;
      let prevEnd = -Infinity;
      let prevId = previous?.lastEventId ?? -Infinity;
      events.forEach((e, i) => {
        const where = `raw_events[${i}]`;
        if (!isObject(e)) return err('event_shape', where, 'Expected an object');
        for (const key of EVENT_KEYS) if (!(key in e)) err('event_field_missing', `${where}.${key}`, 'Required field is missing');
        for (const key of Object.keys(e)) if (!EVENT_KEYS.includes(key)) err('event_field_unknown', `${where}.${key}`, 'Unknown field on a raw event; raw events must carry observable data only');
        if (!Number.isInteger(e.id)) return err('event_id', `${where}.id`, 'Expected an integer id');
        const id = e.id as number;
        const owner = seenEventIds.get(id);
        if (owner) err('duplicate_event_id', `${where}.id`, `Event id ${id} already used in ${owner}`);
        seenEventIds.set(id, name);
        if (id <= prevId) err('event_id_order', `${where}.id`, `Event id ${id} does not increase (previous ${prevId}); ids must rise in insertion order`);
        prevId = id;
        if (!isString(e.watcher) || !e.watcher) err('event_watcher', `${where}.watcher`, 'Expected a non-empty string');
        for (const key of ['app', 'browser', 'title', 'url'] as const) {
          if (!nullableString(e[key])) err('event_field_type', `${where}.${key}`, 'Expected a string or null');
        }
        let ok = true;
        for (const key of ['started_at', 'ended_at'] as const) {
          const value = e[key];
          if (!isString(value) || !ISO_WITH_OFFSET.test(value) || Number.isNaN(Date.parse(value))) {
            err('malformed_time', `${where}.${key}`, `Expected an ISO-8601 timestamp with offset, got ${JSON.stringify(value)}`);
            ok = false;
          }
        }
        if (!ok) return;
        const event = e as unknown as DatasetRawEvent;
        const start = Date.parse(event.started_at);
        const end = Date.parse(event.ended_at);
        offsets.add(utcOffsetOf(event.started_at));
        offsets.add(utcOffsetOf(event.ended_at));
        if (start >= end) err('event_range', where, `started_at ${event.started_at} is not before ended_at ${event.ended_at}`);
        if (start < prevStart) err('event_order', where, `Event ${id} starts before the previous event (not chronological)`);
        if (start < prevEnd) err('event_overlap', where, `Event ${id} starts before the previous event ended`);
        if (previous && i === 0 && start < previous.lastEndMs) err('event_order_across_days', where, `Event ${id} starts before the last event of ${previous.name} ended`);
        if (date && (event.started_at.slice(0, 10) !== date || event.ended_at.slice(0, 10) !== date)) {
          err('event_off_date', where, `Event ${id} (${event.started_at} → ${event.ended_at}) is not on the day's date ${date}`);
        }
        prevStart = start;
        prevEnd = Math.max(prevEnd, end);
        dayEvents.set(id, event);
        firstEvent ??= event;
        lastEvent = event;
      });
    }

    // ── Ground truth ──
    const gt = data.ground_truth;
    if (!isObject(gt) || !Array.isArray(gt.activities) || !Array.isArray(gt.unobserved_periods)) {
      err('ground_truth_shape', 'ground_truth', 'Expected { activities[], unobserved_periods[] }');
    } else {
      groundTruthActivities += gt.activities.length;
      let observedActivities = 0;
      const activityIds = new Set<string>();
      const ownerOf = new Map<number, string>();
      gt.activities.forEach((a, i) => {
        const where = `ground_truth.activities[${i}]`;
        if (!isObject(a)) return err('activity_shape', where, 'Expected an object');
        for (const key of ACTIVITY_KEYS) if (!(key in a)) err('activity_field_missing', `${where}.${key}`, 'Required field is missing');
        const label = isString(a.id) ? a.id : `#${i}`;
        if (!isString(a.id) || !a.id) err('activity_id', `${where}.id`, 'Expected a non-empty string id');
        else if (activityIds.has(a.id)) err('duplicate_activity_id', `${where}.id`, `Activity id ${a.id} is used twice in this day`);
        else activityIds.add(a.id);
        for (const key of ['title', 'summary', 'context', 'intent', 'quality', 'importance'] as const) {
          if (!isString(a[key]) || !a[key]) err('activity_field_type', `${where}.${key}`, 'Expected a non-empty string');
        }
        if (!nullableString(a.area)) err('activity_field_type', `${where}.area`, 'Expected a string or null');

        let timesOk = true;
        for (const key of ['started_at', 'ended_at'] as const) {
          if (!isString(a[key]) || !CLOCK.test(a[key] as string)) {
            err('malformed_time', `${where}.${key}`, `Activity ${label}: expected HH:MM, got ${JSON.stringify(a[key])}`);
            timesOk = false;
          }
        }
        if (timesOk && (a.started_at as string) >= (a.ended_at as string)) {
          err('activity_range', where, `Activity ${label}: started_at ${a.started_at} is not before ended_at ${a.ended_at}`);
        }

        if (!Array.isArray(a.event_ids) || !a.event_ids.every((id) => Number.isInteger(id))) {
          return err('activity_event_ids', `${where}.event_ids`, `Activity ${label}: expected an array of integer event ids`);
        }
        // No events: time away from the screen, told as an activity. Nothing may have been tracked inside it.
        if (a.event_ids.length === 0) {
          if (!timesOk) return;
          for (const e of dayEvents.values()) {
            if (e.started_at.slice(11, 16) < (a.ended_at as string) && e.ended_at.slice(11, 16) > (a.started_at as string)) {
              err('activity_event_ids', `${where}.event_ids`, `Activity ${label} lists no events, but raw event ${e.id} lies inside its ${a.started_at}–${a.ended_at}`);
            }
          }
          return;
        }
        observedActivities++;
        const owned: DatasetRawEvent[] = [];
        for (const id of a.event_ids as number[]) {
          const event = dayEvents.get(id);
          if (!event) {
            err('dangling_event_reference', `${where}.event_ids`, `Activity ${label} references event ${id}, which is not in this day's raw_events`);
            continue;
          }
          const other = ownerOf.get(id);
          if (other) err('event_owned_twice', `${where}.event_ids`, `Event ${id} belongs to both ${other} and ${label}`);
          ownerOf.set(id, label);
          owned.push(event);
        }
        if (owned.length > 0 && timesOk) {
          const sorted = [...owned].sort((x, y) => Date.parse(x.started_at) - Date.parse(y.started_at));
          const first = sorted[0].started_at.slice(11, 16);
          const last = sorted.reduce((latest, e) => (e.ended_at > latest ? e.ended_at : latest), sorted[0].ended_at).slice(11, 16);
          if (first !== a.started_at || last !== a.ended_at) {
            err(
              'activity_range_mismatch',
              where,
              `Activity ${label} states ${a.started_at}–${a.ended_at} but its events span ${first}–${last}`,
            );
          }
        }
      });
      if (observedActivities === 0) err('ground_truth_empty', 'ground_truth.activities', 'Expected at least one activity that owns events');
      for (const id of dayEvents.keys()) {
        if (!ownerOf.has(id)) warn('event_without_ground_truth', 'ground_truth.activities', `Raw event ${id} belongs to no ground-truth activity`);
      }

      gt.unobserved_periods.forEach((u, i) => {
        const where = `ground_truth.unobserved_periods[${i}]`;
        if (!isObject(u) || !isString(u.reason)) return err('unobserved_shape', where, 'Expected { started_at, ended_at, reason }');
        let ok = true;
        for (const key of ['started_at', 'ended_at'] as const) {
          if (!isString(u[key]) || !CLOCK.test(u[key] as string)) {
            err('malformed_time', `${where}.${key}`, `Expected HH:MM, got ${JSON.stringify(u[key])}`);
            ok = false;
          }
        }
        if (!ok) return;
        if ((u.started_at as string) >= (u.ended_at as string)) err('unobserved_range', where, `started_at ${u.started_at} is not before ended_at ${u.ended_at}`);
        for (const e of dayEvents.values()) {
          const s = e.started_at.slice(11, 16);
          const en = e.ended_at.slice(11, 16);
          if (s < (u.ended_at as string) && en > (u.started_at as string)) {
            err('unobserved_overlaps_event', where, `Unobserved period ${u.started_at}–${u.ended_at} overlaps raw event ${e.id} (${s}–${en})`);
          }
        }
      });
    }

    // ── Laptop usage vs events (evaluation metadata; a mismatch does not block) ──
    if (isObject(day) && isObject(day.laptop_usage) && firstEvent && lastEvent) {
      const first = (firstEvent as DatasetRawEvent).started_at.slice(11, 16);
      const last = (lastEvent as DatasetRawEvent).ended_at.slice(11, 16);
      if (day.laptop_usage.first_seen !== first) warn('laptop_usage_mismatch', 'day.laptop_usage.first_seen', `States ${day.laptop_usage.first_seen}, first event starts ${first}`);
      if (day.laptop_usage.last_seen !== last) warn('laptop_usage_mismatch', 'day.laptop_usage.last_seen', `States ${day.laptop_usage.last_seen}, last event ends ${last}`);
    }

    // ── Expected reflection ──
    const reflection = data.expected_reflection;
    if (!isObject(reflection)) {
      err('expected_reflection_shape', 'expected_reflection', 'Expected an object');
    } else {
      if (!isString(reflection.period)) err('expected_reflection_field', 'expected_reflection.period', 'Expected a string');
      if (!isStringArray(reflection.key_observations) || reflection.key_observations.length === 0) {
        err('expected_reflection_field', 'expected_reflection.key_observations', 'Expected a non-empty string[]');
      }
      if (!isStringArray(reflection.important_uncertainty)) err('expected_reflection_field', 'expected_reflection.important_uncertainty', 'Expected string[]');
      if (!isString(reflection.possible_next_step)) err('expected_reflection_field', 'expected_reflection.possible_next_step', 'Expected a string');
      if (!Array.isArray(reflection.priority_alignment)) {
        err('expected_reflection_field', 'expected_reflection.priority_alignment', 'Expected an array');
      } else {
        reflection.priority_alignment.forEach((p, i) => {
          const where = `expected_reflection.priority_alignment[${i}]`;
          if (isString(p) && p.trim()) return; // a plain statement, scored on its content
          if (!isObject(p) || !isString(p.priority) || !isString(p.assessment)) return err('priority_alignment_shape', where, 'Expected { priority, assessment } or a non-empty sentence');
          // Checked against what this file states. Where it states no priorities, the entry names the day's
          // own work stream; the evaluator reads it as a statement.
          if (ownPriorities && !ownPriorities.includes(p.priority)) {
            err('unknown_priority', where, `Priority ${JSON.stringify(p.priority)} is not one of the persona's priorities`);
          }
        });
      }
    }

    // ── Expected coach outcome ──
    const coach = data.expected_coach_outcome;
    if (!isObject(coach)) {
      err('expected_coach_shape', 'expected_coach_outcome', 'Expected an object');
    } else {
      for (const key of ['primary_action', 'secondary_action'] as const) {
        if (!(key in coach)) {
          err('expected_coach_field', `expected_coach_outcome.${key}`, 'Required field is missing (use null for "no action")');
          continue;
        }
        const action = coach[key];
        if (action === null) continue;
        if (!isObject(action)) {
          err('expected_action_shape', `expected_coach_outcome.${key}`, 'Expected an object or null');
          continue;
        }
        for (const field of ACTION_KEYS) if (!(field in action)) err('expected_action_field', `expected_coach_outcome.${key}.${field}`, 'Required field is missing');
        for (const field of ['title', 'action_type', 'reason'] as const) {
          if (!isString(action[field]) || !action[field]) err('expected_action_field', `expected_coach_outcome.${key}.${field}`, 'Expected a non-empty string');
        }
      }
      if (!isStringArray(coach.things_not_to_do)) err('expected_coach_field', 'expected_coach_outcome.things_not_to_do', 'Expected string[]');

      if ('coach_history' in data) {
        const history = (data as { coach_history?: unknown }).coach_history;
        if (!Array.isArray(history)) {
          err('coach_history_shape', 'coach_history', 'Expected an array');
        } else {
          history.forEach((seed, i) => {
            const where = `coach_history[${i}]`;
            if (!isObject(seed) || !isString(seed.title) || !isString(seed.action_type) || !isString(seed.daypart) || !isString(seed.priority)) {
              err('coach_history_shape', where, 'Expected { title, action_type, daypart, focus_minutes, priority, user_decision, execution, outcome }');
              return;
            }
            if (!['accepted', 'rejected', 'deferred'].includes(seed.user_decision as string)) err('coach_history_field', `${where}.user_decision`, 'Expected accepted | rejected | deferred');
            if (!(SCENARIO_EXECUTIONS as readonly unknown[]).includes(seed.execution)) err('coach_history_field', `${where}.execution`, `Expected one of ${SCENARIO_EXECUTIONS.join(' | ')}`);
            if (!(SCENARIO_OUTCOMES as readonly unknown[]).includes(seed.outcome)) err('coach_history_field', `${where}.outcome`, `Expected one of ${SCENARIO_OUTCOMES.join(' | ')}`);
            if (isObject(data.persona) && Array.isArray(data.persona.priorities) && !data.persona.priorities.includes(seed.priority)) {
              err('coach_history_field', `${where}.priority`, 'Must be the text of one of the persona\'s stated priorities');
            }
          });
        }
      }

      if ('action_opportunity' in coach) {
        const o = coach.action_opportunity;
        const where = 'expected_coach_outcome.action_opportunity';
        if (!isObject(o) || typeof o.should_exist !== 'boolean' || !isString(o.reason) || !nullableString(o.priority) || !nullableString(o.type)) {
          err('action_opportunity_shape', where, 'Expected { should_exist, strength, reason, priority, type }');
        } else if (!(OPPORTUNITY_STRENGTHS as readonly unknown[]).includes(o.strength)) {
          err('action_opportunity_strength', `${where}.strength`, `Expected one of ${OPPORTUNITY_STRENGTHS.join(' | ')}`);
        } else {
          if (o.should_exist !== (o.strength === 'strong')) err('action_opportunity_conflict', where, 'should_exist must be true exactly when strength is "strong"');
          // An optional day may name no move of its own — "hold; other open work is fine" — when it says which work that is.
          const holds = o.strength === 'moderate' && isStringArray(coach.acceptable_streams) && coach.acceptable_streams.length > 0;
          if (o.strength !== 'none' && coach.primary_action === null && !holds) {
            err('action_opportunity_conflict', where, `strength "${o.strength}" needs a primary_action describing the useful action (or, for "moderate", acceptable_streams)`);
          }
          if (o.strength === 'none' && coach.primary_action !== null) err('action_opportunity_conflict', where, 'strength "none" contradicts a non-null primary_action');
        }
      }
      if ('execution_scenario' in coach) {
        const x = coach.execution_scenario;
        const where = 'expected_coach_outcome.execution_scenario';
        if (!isObject(x) || !isString(x.reason)) {
          err('execution_scenario_shape', where, 'Expected { user_decision, execution, outcome, reason }');
        } else {
          if (!(SCENARIO_DECISIONS as readonly unknown[]).includes(x.user_decision)) err('execution_scenario_field', `${where}.user_decision`, `Expected one of ${SCENARIO_DECISIONS.join(' | ')}`);
          if (!(SCENARIO_EXECUTIONS as readonly unknown[]).includes(x.execution)) err('execution_scenario_field', `${where}.execution`, `Expected one of ${SCENARIO_EXECUTIONS.join(' | ')}`);
          if (!(SCENARIO_OUTCOMES as readonly unknown[]).includes(x.outcome)) err('execution_scenario_field', `${where}.outcome`, `Expected one of ${SCENARIO_OUTCOMES.join(' | ')}`);
          if (x.user_decision !== 'accepted' && x.execution !== 'not_applicable') err('execution_scenario_conflict', where, 'Only an accepted action can be carried out; use execution "not_applicable"');
          if (x.execution !== 'done' && x.execution !== 'partial' && x.outcome !== 'not_applicable') err('execution_scenario_conflict', where, 'Only an action that was carried out has an outcome; use outcome "not_applicable"');
        }
      }
    }

    if (date && lastEvent) {
      previous = {
        name,
        date,
        lastEventId: (lastEvent as DatasetRawEvent).id,
        lastEndMs: Date.parse((lastEvent as DatasetRawEvent).ended_at),
      };
    }
  }

  if (offsets.size > 1) {
    add('error', 'mixed_utc_offsets', '(dataset)', '', `Timestamps use more than one UTC offset: ${[...offsets].join(', ')}`);
  }

  // ── Profile replay: every change must be possible at the moment it is made ──
  const everStated = new Set<string>();
  if (parsed.length > 0 && isObject(parsed[0].data.persona)) {
    let state = initialProfileState(parsed[0].data.persona);
    for (const p of state.priorities) everStated.add(p.text);
    for (const { name, data } of parsed) {
      const updates = (data as { profile_updates?: unknown }).profile_updates;
      if (updates === undefined) continue;
      if (!Array.isArray(updates)) {
        add('error', 'profile_update_shape', name, 'profile_updates', 'Expected an array');
        continue;
      }
      let endSeen = false;
      updates.forEach((update, i) => {
        const where = `profile_updates[${i}]`;
        if (!isObject(update) || !(PROFILE_UPDATE_OPS as readonly unknown[]).includes(update.op) || (update.at !== 'start' && update.at !== 'end')) {
          add('error', 'profile_update_shape', name, where, `Expected { at: "start" | "end", op: ${PROFILE_UPDATE_OPS.join(' | ')}, … }`);
          return;
        }
        // Replayed in file order, so a morning change cannot be listed after an evening one.
        if (update.at === 'end') endSeen = true;
        else if (endSeen) add('error', 'profile_update_order', name, where, 'A change made at the start of the day is listed after one made at its end');
        const result = applyProfileUpdate(state, update as unknown as DatasetProfileUpdate);
        if ('error' in result) add('error', 'profile_update_impossible', name, where, result.error);
        else {
          state = result.state;
          for (const p of state.priorities) everStated.add(p.text);
        }
      });
    }
  }

  // ── Persona key: work streams, and every reference to one ──
  let personaKey: DatasetPersonaKey | null = null;
  const keyPath = path.join(dir, PERSONA_KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const keyErr = (where: string, message: string) => add('error', 'persona_key', PERSONA_KEY_FILE, where, message);
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (err) {
      keyErr('', `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (raw !== null) {
      if (!isObject(raw) || !isObject(raw.work_streams)) keyErr('work_streams', 'Expected { work_streams: { <key>: { title, kind, aliases[], priorities[] } } }');
      else {
        let shapeOk = true;
        for (const [key, stream] of Object.entries(raw.work_streams)) {
          const where = `work_streams.${key}`;
          if (!isObject(stream) || !isString(stream.title) || !['work', 'leisure', 'personal'].includes(stream.kind as string) || !isStringArray(stream.aliases) || !isStringArray(stream.priorities)) {
            keyErr(where, 'Expected { title, kind: work | leisure | personal, aliases[], priorities[] }');
            shapeOk = false;
            continue;
          }
          for (const alias of stream.aliases) if (alias !== alias.toLowerCase() || alias.trim().length < 3) keyErr(`${where}.aliases`, `"${alias}" must be lower-case and at least 3 characters`);
          for (const text of stream.priorities) {
            if (!everStated.has(text)) keyErr(`${where}.priorities`, `"${text}" is never a stated priority of this persona (day 1's profile or a profile update)`);
          }
        }
        if (shapeOk) personaKey = raw as unknown as DatasetPersonaKey;
      }
    }
  }
  const streamKeys = personaKey ? new Set(Object.keys(personaKey.work_streams)) : null;
  for (const { name, data } of parsed) {
    const checkStream = (where: string, value: unknown) => {
      if (value === undefined || value === null) return;
      if (!isString(value)) add('error', 'stream_reference', name, where, 'Expected a work-stream key or null');
      else if (!streamKeys) add('error', 'stream_reference', name, where, `Names the work stream "${value}", but the persona has no ${PERSONA_KEY_FILE}`);
      else if (!streamKeys.has(value)) add('error', 'stream_reference', name, where, `"${value}" is not a work stream in ${PERSONA_KEY_FILE}`);
    };
    const activities = isObject(data.ground_truth) && Array.isArray(data.ground_truth.activities) ? data.ground_truth.activities : [];
    activities.forEach((a, i) => isObject(a) && checkStream(`ground_truth.activities[${i}].stream`, a.stream));
    const coach = data.expected_coach_outcome as unknown;
    if (!isObject(coach)) continue;
    for (const key of ['primary_action', 'secondary_action']) {
      const action = coach[key];
      if (isObject(action)) checkStream(`expected_coach_outcome.${key}.target_stream`, action.target_stream);
    }
    if (coach.response_by_stream !== undefined) {
      if (!isObject(coach.response_by_stream)) add('error', 'stream_reference', name, 'expected_coach_outcome.response_by_stream', 'Expected { <stream>: { user_decision, execution, outcome, reason } }');
      else {
        for (const [key, x] of Object.entries(coach.response_by_stream)) {
          const where = `expected_coach_outcome.response_by_stream.${key}`;
          checkStream(where, key);
          if (
            !isObject(x) ||
            !isString(x.reason) ||
            !(SCENARIO_DECISIONS as readonly unknown[]).includes(x.user_decision) ||
            !(SCENARIO_EXECUTIONS as readonly unknown[]).includes(x.execution) ||
            !(SCENARIO_OUTCOMES as readonly unknown[]).includes(x.outcome)
          ) {
            add('error', 'execution_scenario_shape', name, where, 'Expected { user_decision, execution, outcome, reason }');
          } else {
            if (x.user_decision !== 'accepted' && x.execution !== 'not_applicable') add('error', 'execution_scenario_conflict', name, where, 'Only an accepted action can be carried out; use execution "not_applicable"');
            if (x.execution !== 'done' && x.execution !== 'partial' && x.outcome !== 'not_applicable') add('error', 'execution_scenario_conflict', name, where, 'Only an action that was carried out has an outcome; use outcome "not_applicable"');
          }
        }
      }
    }
    for (const key of ['acceptable_streams', 'forbidden_streams']) {
      const list = coach[key];
      if (list === undefined) continue;
      if (!isStringArray(list)) add('error', 'stream_reference', name, `expected_coach_outcome.${key}`, 'Expected string[]');
      else list.forEach((value, i) => checkStream(`expected_coach_outcome.${key}[${i}]`, value));
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const ordered = [...parsed].sort((a, b) => a.number - b.number);
  const fileHashes = files.map((f) => ({ name: f.name, sha256: createHash('sha256').update(f.text).digest('hex') }));
  const version = createHash('sha256');
  for (const f of fileHashes) version.update(`${f.name}:${f.sha256}\n`);

  const dates = ordered.map((p) => p.data.day?.date).filter(isString);
  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    stats: {
      days: parsed.length,
      rawEvents,
      groundTruthActivities,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      utcOffset: offsets.size === 1 ? [...offsets][0] : null,
    },
    dataset:
      errors.length === 0
        ? {
            dir,
            version: `sha256:${version.digest('hex').slice(0, 16)}`,
            inputVersion: inputVersionOf(ordered.map((p) => p.data)),
            files: fileHashes,
            days: ordered.map((p) => p.data),
            personaKey,
          }
        : null,
  };
}

/** Hash of everything Reflect is given: the persona and every raw event. */
export function inputVersionOf(days: DatasetDayFile[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(days[0]?.persona ?? null));
  for (const day of days) {
    hash.update(JSON.stringify([day.day.day_number, day.day.date, day.raw_events]));
    // Seeded history reaches Reflect too (as stored actions), so it is part of the input.
    if (day.coach_history && day.coach_history.length > 0) hash.update(JSON.stringify(day.coach_history));
    // So do the user's own profile changes.
    if (day.profile_updates && day.profile_updates.length > 0) hash.update(JSON.stringify(day.profile_updates));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

/** Load the dataset or fail loudly with every validation error. */
export function loadDataset(dir: string, expectedDays: number): { dataset: LoadedDataset; validation: ValidationResult } {
  const { dataset, ...validation } = validateDataset(dir, expectedDays);
  if (!dataset) throw new DatasetValidationError(validation);
  return { dataset, validation };
}

/**
 * Split a validated dataset into the two halves. `input` is built by copying
 * an explicit whitelist of observable fields, so a new answer-key field added
 * to the files later can never reach Reflect by accident.
 */
export function splitDataset(dataset: LoadedDataset): { input: ReflectInput; evaluation: EvaluationOnly } {
  const first = dataset.days[0];
  const utcOffset = utcOffsetOf(first.raw_events[0].started_at);

  const input: ReflectInput = {
    persona: {
      id: first.persona.id,
      type: first.persona.type,
      role: first.persona.role,
      current_work: [...(first.persona.current_work ?? [])],
      priorities: [...(first.persona.priorities ?? [])],
    },
    utcOffset,
    days: dataset.days.map((d) => ({
      dayNumber: d.day.day_number,
      date: d.day.date,
      rawEvents: d.raw_events.map((e) => ({
        datasetId: e.id,
        watcher: e.watcher,
        startedAt: e.started_at,
        endedAt: e.ended_at,
        app: e.app,
        browser: e.browser,
        title: e.title,
        url: e.url,
      })),
      profileUpdates: (d.profile_updates ?? []).map((u) => ({
        at: u.at,
        op: u.op,
        ...(u.priority !== undefined ? { priority: u.priority } : {}),
        ...(u.to !== undefined ? { to: u.to } : {}),
        ...(u.current_work !== undefined ? { current_work: [...u.current_work] } : {}),
      })),
    })),
  };
  const profiles = profileByDay(dataset.days);

  const evaluation: EvaluationOnly = {
    priorities: [...new Set(dataset.days.flatMap((d) => d.persona.priorities ?? []))],
    streams: dataset.personaKey?.work_streams ?? {},
    days: dataset.days.map((d, index) => ({
      dayNumber: d.day.day_number,
      date: d.day.date,
      utcOffset,
      dayType: d.day.day_type,
      circumstances: d.day.circumstances,
      statedPriorities: [...(d.persona.priorities ?? first.persona.priorities ?? [])],
      profilePriorities: profiles[index].priorities,
      laptopUsage: d.day.laptop_usage,
      events: d.raw_events.map((e) => ({
        datasetId: e.id,
        startMs: Date.parse(e.started_at),
        endMs: Date.parse(e.ended_at),
        app: e.app,
        title: e.title,
        url: e.url,
      })),
      groundTruth: d.ground_truth,
      expectedReflection: d.expected_reflection,
      expectedCoachOutcome: d.expected_coach_outcome,
      evaluationObjectives: d.evaluation_objectives ?? null,
      coachHistory: d.coach_history ?? [],
    })),
  };

  return { input: deepFreeze(input), evaluation: deepFreeze(evaluation) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
