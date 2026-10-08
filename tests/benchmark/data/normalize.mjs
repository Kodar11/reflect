#!/usr/bin/env node
// Repairs MECHANICAL drift in the persona day files — the same fact written in a
// different shape — and nothing else:
//
//   raw_events   a timestamp written without its date ("11:46:00+05:30") gets the day's date;
//                a timestamp on another date gets the day's date when that makes the event
//                fit exactly between its neighbours (a typo), and is left alone otherwise
//   day          laptop → laptop_usage, longest_gap_minutes → longest_unobserved_gap_minutes,
//                first_seen / last_seen as HH:MM, circumstances as a list, day_number from the file name
//   coach        type → action_type, estimated_time_minutes → suggested_focus_minutes,
//                an absent suggested_focus_minutes / target written as null
//
// It never writes a label, a sentence, an event or an expectation that the file does not
// already state: a missing title, a free-text classification or a missing day stays missing
// and is reported by `npm run benchmark:validate -- --all`.
//
// Edits are spliced into the file text, so nothing else in a file is reformatted, and each
// edited file is checked against the same repair applied to the parsed JSON before it is
// written. Re-running is idempotent.
//
//   node tests/benchmark/data/normalize.mjs            what would change (writes nothing)
//   node tests/benchmark/data/normalize.mjs --write    apply

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const write = process.argv.includes('--write');

const TIME_ONLY = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const FULL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DOUBLED_OFFSET = /^(.*\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)([+-]\d{2}:\d{2})\2$/;
const EVENT_KEYS = ['id', 'watcher', 'started_at', 'ended_at', 'app', 'browser', 'title', 'url', 'payload'];
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const quote = (s) => JSON.stringify(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rename `from` to `to` in place, keeping the key's position. */
function renameKey(object, from, to) {
  const entries = Object.entries(object).map(([k, v]) => [k === from ? to : k, v]);
  for (const key of Object.keys(object)) delete object[key];
  for (const [k, v] of entries) object[k] = v;
}

/** The repair, applied to the parsed file. Returns what was done. */
function repair(data, dayNumber) {
  const done = [];
  const day = data.day;
  const date = isObject(day) && typeof day.date === 'string' ? day.date : null;

  if (date && Array.isArray(data.raw_events)) {
    const events = data.raw_events;
    events.forEach((event, i) => {
      if (!isObject(event)) return;
      for (const key of ['started_at', 'ended_at']) {
        if (typeof event[key] === 'string' && DOUBLED_OFFSET.test(event[key])) {
          event[key] = event[key].replace(DOUBLED_OFFSET, '$1$2');
          done.push('timestamp_offset_twice');
        }
        // "started_at_duplicate_note" holding the very value of "started_at" says nothing.
        if (`${key}_duplicate_note` in event && event[`${key}_duplicate_note`] === event[key]) {
          delete event[`${key}_duplicate_note`];
          done.push('duplicate_note_removed');
        }
      }
      // An event that is otherwise whole but has no "browser" key: no browser was recorded.
      if (EVENT_KEYS.every((key) => key === 'browser' || key in event) && !('browser' in event)) {
        const rest = { ...event };
        for (const key of Object.keys(event)) delete event[key];
        for (const key of EVENT_KEYS) event[key] = key === 'browser' ? null : rest[key];
        for (const [key, value] of Object.entries(rest)) if (!(key in event)) event[key] = value;
        done.push('browser_null');
      }
      for (const key of ['started_at', 'ended_at']) {
        if (typeof event[key] === 'string' && TIME_ONLY.test(event[key])) {
          event[key] = `${date}T${event[key]}`;
          done.push('timestamp_without_date');
        }
      }
      // A full timestamp on another date: a typo exactly when the day's own date makes the event meet its neighbours.
      for (const key of ['started_at', 'ended_at']) {
        const match = typeof event[key] === 'string' ? FULL.exec(event[key]) : null;
        if (!match || match[1] === date) continue;
        const fixed = date + event[key].slice(10);
        const other = key === 'started_at' ? event.ended_at : event.started_at;
        const neighbour = key === 'started_at' ? events[i - 1]?.ended_at : events[i + 1]?.started_at;
        const ordered = key === 'started_at' ? Date.parse(fixed) < Date.parse(other) : Date.parse(fixed) > Date.parse(other);
        const neighbourFull = typeof neighbour === 'string' && TIME_ONLY.test(neighbour) ? `${date}T${neighbour}` : neighbour;
        if (ordered && typeof neighbourFull === 'string' && Date.parse(fixed) === Date.parse(neighbourFull)) {
          event[key] = fixed;
          done.push('timestamp_on_wrong_date');
        }
      }
    });
  }

  if (isObject(day)) {
    if (!('day_number' in day)) {
      const entries = Object.entries(day);
      for (const key of Object.keys(day)) delete day[key];
      day.day_number = dayNumber;
      for (const [k, v] of entries) day[k] = v;
      done.push('day_number_added');
    }
    if (typeof day.circumstances === 'string') {
      day.circumstances = [day.circumstances];
      done.push('circumstances_as_list');
    }
    if (isObject(day.laptop) && !('laptop_usage' in day)) {
      renameKey(day, 'laptop', 'laptop_usage');
      done.push('laptop_usage_key');
    }
    const usage = day.laptop_usage;
    if (isObject(usage)) {
      if ('longest_gap_minutes' in usage && !('longest_unobserved_gap_minutes' in usage)) {
        renameKey(usage, 'longest_gap_minutes', 'longest_unobserved_gap_minutes');
        done.push('longest_gap_key');
      }
      for (const key of ['first_seen', 'last_seen']) {
        const match = typeof usage[key] === 'string' ? FULL.exec(usage[key]) : null;
        if (match && match[1] === date) {
          usage[key] = match[2];
          done.push('laptop_usage_clock');
        }
      }
    }
  }

  // The persona's two lists under the names every other file uses.
  const persona = data.persona;
  if (isObject(persona)) {
    for (const [from, to] of [['main_work', 'current_work'], ['initial_priorities', 'priorities']]) {
      if (from in persona && !(to in persona)) {
        renameKey(persona, from, to);
        done.push(`${to}_key`);
      }
    }
  }

  // Ground truth: which events an activity owns is what is scored, and where the stated clock
  // times disagree with that list it is the list that matches the activity's own summary.
  const truth = data.ground_truth;
  const events = Array.isArray(data.raw_events) ? data.raw_events : [];
  const whole = events.length > 0 && events.every((e) => isObject(e) && Number.isInteger(e.id) && FULL.test(e.started_at ?? '') && FULL.test(e.ended_at ?? ''));
  if (whole && isObject(truth) && Array.isArray(truth.activities)) {
    const clock = (iso) => iso.slice(11, 16);
    const byId = new Map(events.map((e) => [e.id, e]));
    const activities = truth.activities.filter((a) => isObject(a) && Array.isArray(a.event_ids) && typeof a.started_at === 'string' && typeof a.ended_at === 'string');
    const states = (a, e) => clock(e.started_at) >= a.started_at && clock(e.ended_at) <= a.ended_at;
    // An event listed by two activities stays with the one whose stated time holds it.
    for (const event of events) {
      const listed = activities.filter((a) => a.event_ids.includes(event.id));
      const holding = listed.filter((a) => states(a, event));
      if (listed.length > 1 && holding.length === 1) {
        for (const a of listed) if (a !== holding[0]) a.event_ids = a.event_ids.filter((id) => id !== event.id);
        done.push('event_single_owner');
      }
      // An event listed by none joins the one activity whose stated time holds it.
      if (listed.length === 0) {
        const around = activities.filter((a) => a.event_ids.length > 0 && states(a, event));
        if (around.length === 1) {
          around[0].event_ids = [...around[0].event_ids, event.id].sort((x, y) => x - y);
          done.push('event_given_owner');
        }
      }
    }
    for (const a of activities) {
      const owned = a.event_ids.map((id) => byId.get(id));
      if (owned.length === 0 || owned.some((e) => !e)) continue;
      const first = owned.map((e) => clock(e.started_at)).sort()[0];
      const last = owned.map((e) => clock(e.ended_at)).sort().pop();
      if (a.started_at !== first || a.ended_at !== last) {
        a.started_at = first;
        a.ended_at = last;
        done.push('activity_clock_from_events');
      }
    }
    // An unobserved period that begins while an event is still running begins when that event ends.
    for (const period of Array.isArray(truth.unobserved_periods) ? truth.unobserved_periods : []) {
      if (!isObject(period) || typeof period.started_at !== 'string' || typeof period.ended_at !== 'string') continue;
      const running = events.filter((e) => clock(e.started_at) < period.ended_at && clock(e.ended_at) > period.started_at);
      if (running.length === 0) continue;
      const from = running.map((e) => clock(e.ended_at)).sort().pop();
      if (running.some((e) => clock(e.started_at) < period.started_at) || from >= period.ended_at) continue;
      for (const a of activities) {
        if (a.event_ids.length === 0 && a.started_at === period.started_at && a.ended_at === period.ended_at) a.started_at = from;
      }
      period.started_at = from;
      done.push('unobserved_after_event');
    }
  }

  // A priority named by a shortened or padded form of exactly one stated priority is that priority.
  const alignment = data.expected_reflection?.priority_alignment;
  if (isObject(persona) && Array.isArray(persona.priorities) && Array.isArray(alignment)) {
    const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const within = (short, long) => {
      let i = 0;
      for (const word of words(long)) if (word === words(short)[i]) i++;
      return i === words(short).length && i > 2;
    };
    for (const entry of alignment) {
      if (!isObject(entry) || typeof entry.priority !== 'string' || persona.priorities.includes(entry.priority)) continue;
      const stated = persona.priorities.filter((p) => typeof p === 'string' && (within(entry.priority, p) || within(p, entry.priority)));
      if (stated.length === 1) {
        entry.priority = stated[0];
        done.push('priority_named_in_full');
      }
    }
  }

  const coach = data.expected_coach_outcome;
  if (isObject(coach)) {
    for (const slot of ['primary_action', 'secondary_action']) {
      const action = coach[slot];
      if (!isObject(action)) continue;
      // An action stated only by its target is titled by that target — the same words, nothing added.
      if (!('title' in action) && typeof action.target === 'string' && action.target) {
        const rest = { ...action };
        for (const key of Object.keys(action)) delete action[key];
        action.title = rest.target;
        Object.assign(action, rest);
        done.push('title_from_target');
      }
      if ('type' in action && !('action_type' in action)) {
        renameKey(action, 'type', 'action_type');
        done.push('action_type_key');
      }
      if ('estimated_time_minutes' in action && !('suggested_focus_minutes' in action)) {
        renameKey(action, 'estimated_time_minutes', 'suggested_focus_minutes');
        done.push('focus_minutes_key');
      }
      for (const key of ['suggested_focus_minutes', 'target']) {
        if (!(key in action)) {
          action[key] = null;
          done.push(`${key}_null`);
        }
      }
    }
  }
  return done;
}

// ── The same repair, spliced into the file text ─────────────────────────────

/** Index just past the value that starts at `from` (an object, array, string or scalar). */
function endOfValue(text, from) {
  let i = from;
  if (text[i] === '"') {
    for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
    return i + 1;
  }
  if (text[i] !== '{' && text[i] !== '[') {
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
    return i;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced JSON');
}

/** [start, end) of every element of the array that opens at `from`. */
function elementSpans(text, from) {
  const spans = [];
  let i = from + 1;
  for (;;) {
    while (/[\s,]/.test(text[i])) i++;
    if (text[i] === ']') return spans;
    const end = endOfValue(text, i);
    spans.push({ start: i, end });
    i = end;
  }
}

/** [start, end) of the value of the first `"key":` at or after `from`. */
function valueSpan(text, key, from = 0, to = text.length) {
  const match = new RegExp(`"${escapeRe(key)}"\\s*:\\s*`, 'g');
  match.lastIndex = from;
  const found = match.exec(text);
  if (!found || found.index >= to) return null;
  const start = found.index + found[0].length;
  return { keyStart: found.index, start, end: endOfValue(text, start) };
}

function repairText(text, original, dayNumber) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const day = original.day;
  const date = isObject(day) && typeof day.date === 'string' ? day.date : null;
  let out = text;

  // Raw-event timestamps. Ground-truth clocks are "HH:MM" and never match.
  const events = valueSpan(out, 'raw_events');
  if (events && date) {
    let body = out.slice(events.start, events.end);
    const repaired = structuredClone(original);
    repair(repaired, dayNumber);
    // An event whose set of keys changes is written out again whole, at its own indentation.
    original.raw_events.forEach((event, i) => {
      const after = repaired.raw_events[i];
      if (!isObject(event) || Object.keys(event).join() === Object.keys(after).join()) return;
      const open = new RegExp(`\\{\\s*"id"\\s*:\\s*${event.id}\\b`).exec(body);
      if (!open) throw new Error(`cannot locate event ${event.id}`);
      const indent = /[ \t]*$/.exec(body.slice(0, open.index))[0];
      const text = JSON.stringify(after, null, 2).split('\n').join(eol + indent);
      body = body.slice(0, open.index) + text + body.slice(endOfValue(body, open.index));
    });
    body = body.replace(/("(?:started_at|ended_at)"\s*:\s*"[^"]*?\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)([+-]\d{2}:\d{2})\2"/g, '$1$2"');
    body = body.replace(/("(?:started_at|ended_at)"\s*:\s*")(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))"/g, `$1${date}T$2"`);
    original.raw_events.forEach((event, i) => {
      for (const key of ['started_at', 'ended_at']) {
        const before = event?.[key];
        const after = repaired.raw_events[i]?.[key];
        // Already written above: a time without a date, a doubled offset, an event written out whole.
        if (typeof before !== 'string' || before === after || TIME_ONLY.test(before) || DOUBLED_OFFSET.test(before)) continue;
        if (Object.keys(event).join() !== Object.keys(repaired.raw_events[i]).join()) continue;
        const pattern = new RegExp(`("id"\\s*:\\s*${event.id}\\b[^{}]*?"${key}"\\s*:\\s*)${escapeRe(quote(before))}`);
        if (!pattern.test(body)) throw new Error(`cannot locate event ${event.id}.${key}`);
        body = body.replace(pattern, `$1${quote(after)}`);
      }
    });
    out = out.slice(0, events.start) + body + out.slice(events.end);
  }

  // The day section.
  const daySpan = valueSpan(out, 'day');
  if (daySpan && isObject(day)) {
    let body = out.slice(daySpan.start, daySpan.end);
    const indent = /\n([ \t]+)"/.exec(body)?.[1] ?? '    ';
    if (!('day_number' in day)) body = body.replace(/^\{(\s*)/, `{$1"day_number": ${dayNumber},$1`);
    if (typeof day.circumstances === 'string') {
      const span = valueSpan(body, 'circumstances');
      body = `${body.slice(0, span.start)}[${eol}${indent}  ${body.slice(span.start, span.end)}${eol}${indent}]${body.slice(span.end)}`;
    }
    if (isObject(day.laptop) && !('laptop_usage' in day)) body = body.replace(/"laptop"(\s*:)/, '"laptop_usage"$1');
    body = body.replace(/"longest_gap_minutes"(\s*:)/, '"longest_unobserved_gap_minutes"$1');
    if (date) body = body.replace(new RegExp(`("(?:first_seen|last_seen)"\\s*:\\s*")${date}T(\\d{2}:\\d{2}):\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})"`, 'g'), '$1$2"');
    out = out.slice(0, daySpan.start) + body + out.slice(daySpan.end);
  }

  const repaired = structuredClone(original);
  repair(repaired, dayNumber);
  /** Replace the value of `key` inside the object at [start, end) of `out`. */
  const setField = (start, end, key, valueText) => {
    const span = valueSpan(out, key, start, end);
    if (!span) throw new Error(`cannot locate "${key}"`);
    out = out.slice(0, span.start) + valueText + out.slice(span.end);
  };
  /** A list of numbers written the way the list it replaces was written. */
  const listLike = (oldText, values) => {
    if (!oldText.includes('\n')) return `[${values.join(oldText.includes(', ') ? ', ' : ',')}]`;
    const inner = /\n([ \t]*)\S/.exec(oldText)[1];
    const closing = /\n([ \t]*)\]$/.exec(oldText)[1];
    return `[${eol}${values.map((v) => inner + v).join(`,${eol}`)}${eol}${closing}]`;
  };

  // The persona's key names.
  if (isObject(original.persona)) {
    const span = valueSpan(out, 'persona');
    let body = out.slice(span.start, span.end);
    if ('main_work' in original.persona && !('current_work' in original.persona)) body = body.replace(/"main_work"(\s*:)/, '"current_work"$1');
    if ('initial_priorities' in original.persona && !('priorities' in original.persona)) body = body.replace(/"initial_priorities"(\s*:)/, '"priorities"$1');
    out = out.slice(0, span.start) + body + out.slice(span.end);
  }

  // Ground truth and priority names: field by field, last element first so earlier spans stay put.
  const truth = original.ground_truth;
  if (isObject(truth)) {
    for (const [listKey, fields] of [['unobserved_periods', ['started_at']], ['activities', ['event_ids', 'ended_at', 'started_at']]]) {
      const before = truth[listKey];
      const after = repaired.ground_truth[listKey];
      if (!Array.isArray(before)) continue;
      for (let i = before.length - 1; i >= 0; i--) {
        for (const field of fields) {
          if (!isObject(before[i]) || isDeepStrictEqual(before[i][field], after[i][field])) continue;
          const section = valueSpan(out, 'ground_truth');
          const element = elementSpans(out, valueSpan(out, listKey, section.start, section.end).start)[i];
          const old = valueSpan(out, field, element.start, element.end);
          setField(element.start, element.end, field, Array.isArray(after[i][field]) ? listLike(out.slice(old.start, old.end), after[i][field]) : quote(after[i][field]));
        }
      }
    }
  }
  const alignment = original.expected_reflection?.priority_alignment;
  if (Array.isArray(alignment)) {
    for (let i = alignment.length - 1; i >= 0; i--) {
      const after = repaired.expected_reflection.priority_alignment[i];
      if (!isObject(alignment[i]) || alignment[i].priority === after.priority) continue;
      const section = valueSpan(out, 'expected_reflection');
      const element = elementSpans(out, valueSpan(out, 'priority_alignment', section.start, section.end).start)[i];
      setField(element.start, element.end, 'priority', quote(after.priority));
    }
  }

  // Expected actions.
  const coach = original.expected_coach_outcome;
  if (isObject(coach)) {
    // Later slot first, so an edit never moves a span still to be read.
    for (const slot of ['secondary_action', 'primary_action']) {
      const action = coach[slot];
      if (!isObject(action)) continue;
      const coachSpan = valueSpan(out, 'expected_coach_outcome');
      const span = valueSpan(out, slot, coachSpan.start, coachSpan.end);
      let body = out.slice(span.start, span.end);
      if (!('title' in action) && typeof action.target === 'string' && action.target) body = body.replace(/^\{(\s*)/, `{$1"title": ${quote(action.target).replace(/\$/g, '$$$$')},$1`);
      if ('type' in action && !('action_type' in action)) body = body.replace(/"type"(\s*:)/, '"action_type"$1');
      if ('estimated_time_minutes' in action && !('suggested_focus_minutes' in action)) body = body.replace(/"estimated_time_minutes"(\s*:)/, '"suggested_focus_minutes"$1');
      const indent = /\n([ \t]+)"/.exec(body)?.[1] ?? '      ';
      const closing = /\s*\}$/.exec(body)[0];
      let added = '';
      const has = (key) => key in action || (key === 'suggested_focus_minutes' && 'estimated_time_minutes' in action);
      for (const key of ['suggested_focus_minutes', 'target']) if (!has(key)) added += `,${eol}${indent}"${key}": null`;
      body = body.slice(0, body.length - closing.length) + added + closing;
      out = out.slice(0, span.start) + body + out.slice(span.end);
    }
  }
  return out;
}

// ── Run ─────────────────────────────────────────────────────────────────────

let changedFiles = 0;
const totals = new Map();
for (const persona of fs.readdirSync(root).sort()) {
  const dir = path.join(root, persona);
  if (persona === 'coach_scenarios' || !fs.statSync(dir).isDirectory()) continue;
  const perPersona = new Map();
  let files = 0;
  for (const name of fs.readdirSync(dir).filter((f) => /_day_\d{2}\.json$/.test(f)).sort()) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    const dayNumber = Number(/_day_(\d{2})\.json$/.exec(name)[1]);
    let original;
    try {
      original = JSON.parse(text);
    } catch {
      continue; // not valid JSON: the validator's finding, not something to repair
    }
    const expected = structuredClone(original);
    const done = repair(expected, dayNumber);
    if (done.length === 0) continue;

    const out = repairText(text, original, dayNumber);
    if (!isDeepStrictEqual(JSON.parse(out), expected)) throw new Error(`${persona}/${name}: the text edit does not equal the intended repair; nothing was written for this file`);
    if (repair(JSON.parse(out), dayNumber).length !== 0) throw new Error(`${persona}/${name}: the repair is not idempotent`);
    files++;
    changedFiles++;
    for (const kind of done) {
      perPersona.set(kind, (perPersona.get(kind) ?? 0) + 1);
      totals.set(kind, (totals.get(kind) ?? 0) + 1);
    }
    if (write) fs.writeFileSync(file, out);
  }
  if (files > 0) console.log(`${persona}: ${files} file(s) — ${[...perPersona].map(([kind, n]) => `${kind} ×${n}`).join(', ')}`);
}
console.log(
  changedFiles === 0
    ? 'nothing to repair'
    : `${write ? 'repaired' : 'would repair'} ${changedFiles} file(s): ${[...totals].map(([kind, n]) => `${kind} ×${n}`).join(', ')}${write ? '' : '\n(dry run — pass --write to apply)'}`,
);
