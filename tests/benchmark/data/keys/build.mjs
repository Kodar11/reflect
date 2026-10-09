#!/usr/bin/env node
// Applies the v2 answer-key annotations to the persona day files.
//
//   node tests/benchmark/data/keys/build.mjs            dry run: what would change, and anything left unresolved
//   node tests/benchmark/data/keys/build.mjs --write    apply
//   node tests/benchmark/data/keys/build.mjs --check    exit 1 unless the day files already hold exactly this
//   … --persona <name>                                  one persona only
//
// The per-persona modules next to this file are the source of truth for:
//
//   work streams             →  <persona>/persona_key.json
//   dated profile changes    →  day.profile_updates                       (INPUT: replayed to Reflect)
//   stream of each activity  →  ground_truth.activities[].stream
//   coach expectation        →  expected_coach_outcome.{primary,secondary}_action.target_stream,
//                               .action_opportunity, .acceptable_streams, .forbidden_streams
//
// and two things are DERIVED here from what the files already state, by the rules below:
//
//   canonical labels         →  activities[].context / intent / quality    (the key's own free text is kept in label_notes)
//   the user's response      →  expected_coach_outcome.execution_scenario and .response_by_stream
//                               (from the NEXT day's ground-truth activity on each work stream)
//
// Raw events are never touched. Re-running is idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serializeLike } from './serialize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CHECK = args.includes('--check');
const only = args.includes('--persona') ? args[args.indexOf('--persona') + 1] : null;
const PERSONAS = ['founder_freelancer', 'college_student', 'researcher', 'content_creator', 'sofware_developer', 'graphic_designer'];

// ── Canonical labels ────────────────────────────────────────────────────────

const CONTEXTS = ['Work', 'Leisure', 'Personal'];
const INTENTS = ['Create', 'Communicate', 'Plan', 'Consume', 'Learn', 'Manage', 'Research', 'Review', 'Complete', 'Organize'];
const QUALITIES = ['Focused', 'Routine', 'Break-Idle'];
const canonical = (list, value) => (typeof value === 'string' ? list.find((x) => x.toLowerCase() === value.trim().toLowerCase()) ?? null : null);

/**
 * What an activity was for, read from the verb the key itself uses — the first one in its own description of the
 * intent, else in the title. Ordered by where the word stands, so "Check the requirements and draft the answer"
 * is a Review and "Draft the answer, then check it" a Create.
 */
const INTENT_WORDS = [
  ['Learn', /\b(prepar\w* for|learn\w*|understand\w*|stud(y|ying|ied)|revision|revis\w* (for|the topic)|practi[cs]e\w*|tutorial|quiz|self-test\w*|recall|consolidat\w*|weak[- ]topic)\b/],
  ['Communicate', /\b(communicat\w*|coordinat\w*|discuss\w*|respond\w*|repl(y|ied|ying)|meeting|standup|messag\w*|e-?mail\w*|inbox|chat|call|attend\w*|clarif\w* .* with)\b/],
  ['Complete', /\b(finali[sz]\w*|submi(t|ssion)\w*|complet\w*|clos(e|ed|ing|eout|ure)\w*|deliver\w*|hand(ed)? ?off|publish\w*|upload\w*|releas\w*|ship\w*|archiv\w*)\b/],
  ['Plan', /\b(plan\w*|decid\w*|defin\w*|choos\w*|outlin\w*|scop\w*|prioriti\w*|schedul\w*|rank\w*|fram\w*|shap\w*|checklist)\b/],
  ['Research', /\b(research\w*|investigat\w*|analy[sz]\w*|compar\w*|explor\w*|diagnos\w*|inspect\w*|trac(e|ed|ing)|survey\w*|debug\w*|evaluat\w*|synthesi[sz]\w*|quantif\w*|experiment\w*|ran|run(ning)?)\b/],
  ['Review', /\b(verif\w*|check\w*|review\w*|confirm\w*|monitor\w*|observ\w*|validat\w*|glance|audit\w*|wait\w*|status|test\w*)\b/],
  ['Create', /\b(implement\w*|writ(e|ing|ten)|wrote|draft\w*|produc\w*|build\w*|built|design\w*|edit\w*|record\w*|revis\w*|refin\w*|fix\w*|develop\w*|solv\w*|cod(e|ing)|appl(y|ied|ying)|address\w*|incorporat\w*|integrat\w*|assembl\w*|compress\w*|prepar\w*|polish\w*|harden\w*|creat\w*|updat\w*|document\w*|sketch\w*|extend\w*|strengthen\w*|improv\w*|tighten\w*|adjust\w*|mak(e|ing)|turn\w*|convert\w*|captur\w*|continu\w*|resum\w*|advanc\w*)\b/],
  ['Manage', /\b(organi[sz]\w*|maintain\w*|maintenance|clean\w*|admin\w*|fil(e|ing)|triag\w*|track\w*|housekeeping)\b/],
  ['Consume', /\b(recreation\w*|leisure|wind down|relax\w*|watch\w*|entertainment|gaming|brows\w*|social)\b/],
];
function intentOf(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const [intent, pattern] of INTENT_WORDS) {
    const at = lower.search(pattern);
    if (at >= 0 && (best === null || at < best.at)) best = { intent, at };
  }
  return best?.intent ?? null;
}

/** How the time was spent, from the key's own words for it. Read in order: the first cue decides. */
const QUALITY_WORDS = [
  ['Break-Idle', /\b(leisure|break|idle|recreation\w*|rest|personal|offline|entertainment)\b/],
  ['Focused', /\b(focus\w*|substantive|deep|sustained|strong|meaningful|production|completion\w*|substantial|implementation)\b/],
  ['Routine', /\b(brief|routine|light\w*|maintenance|coordination|check\w*|verification|follow-up|necessary|administrative|interruption|bounded|quick|admin)\b/],
];
function qualityOf(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const [quality, pattern] of QUALITY_WORDS) {
    const at = lower.search(pattern);
    if (at >= 0 && (best === null || at < best.at)) best = { quality, at };
  }
  return best?.quality ?? null;
}

/** The key's own word for "this cannot be told from the screen". Such a label is left alone: the activity is not scored on it. */
const UNDECIDED = /^(uncertain|ambiguous|unknown|mixed|unresolved|unclear)\b/i;

/** The label fields as the key first wrote them: `label_notes` holds any this script has already replaced. */
const original = (activity, field) => (activity.label_notes && field in activity.label_notes ? activity.label_notes[field] : activity[field]);

function labelsFor(activity, stream, kind, minutes) {
  const was = { context: original(activity, 'context'), intent: original(activity, 'intent'), quality: original(activity, 'quality') };
  const undecided = (field) => typeof was[field] === 'string' && UNDECIDED.test(was[field].trim());
  // Context: the three areas where the key already uses them; "Academic" is a student's work; otherwise the stream decides.
  let context = canonical(CONTEXTS, was.context);
  if (!context && typeof was.context === 'string' && /^academic$/i.test(was.context.trim())) context = 'Work';
  if (!context && kind && !undecided('context')) context = kind === 'work' ? 'Work' : kind === 'leisure' ? 'Leisure' : 'Personal';
  // Intent and quality: the canonical word where the key has one, else its own description, else the title.
  let intent = canonical(INTENTS, was.intent);
  if (!intent && !undecided('intent')) {
    if (kind && kind !== 'work') intent = intentOf(String(was.intent ?? '')) ?? (kind === 'leisure' ? 'Consume' : null);
    intent ??= intentOf(String(was.intent ?? '')) ?? intentOf(activity.title);
  }
  let quality = canonical(QUALITIES, was.quality);
  if (!quality && !undecided('quality')) {
    if (kind && kind !== 'work') quality = 'Break-Idle';
    quality ??= qualityOf(String(was.quality ?? ''));
  }
  if (!quality && !undecided('quality') && intent) quality = minutes >= 40 && ['Create', 'Research', 'Learn', 'Complete'].includes(intent) ? 'Focused' : 'Routine';
  return {
    labels: { context: context ?? was.context, intent: intent ?? was.intent, quality: quality ?? was.quality },
    notes: Object.fromEntries(Object.entries(was).filter(([field, value]) => ({ context, intent, quality })[field] !== null && ({ context, intent, quality })[field] !== value)),
  };
}

// ── The user's response, from the next day's ground truth ───────────────────

const TROUBLE = /\b(fail(ed|ure|ing)?|did not work|unsuccessful|retake|second (recording )?attempt|replacement take|blocked|blocker)\b/i;

/**
 * What the user does with a recommendation aimed at `stream`, read from what the NEXT day's ground truth shows
 * them doing. Deciding, doing and whether it helped stay three separate facts; none says the advice was right.
 *
 *   ≥ 90 min on it next day             accepted · done · worked
 *   45–89 min                           accepted · done · partly worked
 *   10–44 min                           accepted · partial · partly worked
 *   …and most of that time was a retry, a failure or a blocker
 *                                       accepted · done · did not work
 *   under 10 min, on a light day        "not now"  (deferred)
 *   under 10 min, another stream took most of the day
 *                                       rejected · different priority
 *   under 10 min otherwise              accepted · not done
 *   the stream is closed that day       rejected · not relevant
 */
function responseFor(stream, next, closedToday) {
  if (closedToday) return { user_decision: 'rejected', execution: 'not_applicable', outcome: 'not_applicable', reason: 'That work is already finished or parked.', reason_code: 'not_relevant' };
  const minutes = next.byStream.get(stream) ?? 0;
  const where = `Day ${next.number} shows ${Math.round(minutes)} min on this work`;
  if (minutes >= 10) {
    const trouble = (next.troubleByStream.get(stream) ?? 0) >= minutes / 2;
    if (minutes >= 45 && trouble) return { user_decision: 'accepted', execution: 'done', outcome: 'did_not_work', reason: `${where}, most of it a retry, a failure or a blocker.`, reason_code: 'other' };
    if (minutes >= 90) return { user_decision: 'accepted', execution: 'done', outcome: 'worked', reason: `${where}.`, reason_code: null };
    if (minutes >= 45) return { user_decision: 'accepted', execution: 'done', outcome: 'partly_worked', reason: `${where}.`, reason_code: null };
    return { user_decision: 'accepted', execution: 'partial', outcome: 'partly_worked', reason: `${where}: a short return to it.`, reason_code: null };
  }
  if (next.workMinutes < 180) return { user_decision: 'deferred', execution: 'not_applicable', outcome: 'not_applicable', reason: `Day ${next.number} was a light day (${Math.round(next.workMinutes)} min of tracked work) with none of it on this.`, reason_code: null };
  const [topStream, topMinutes] = [...next.byStream].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (topStream && topMinutes >= next.workMinutes / 2) {
    return { user_decision: 'rejected', execution: 'not_applicable', outcome: 'not_applicable', reason: `Day ${next.number} went to other work (${topStream}, ${Math.round(topMinutes)} min).`, reason_code: 'different_priority' };
  }
  return { user_decision: 'accepted', execution: 'not_done', outcome: 'not_applicable', reason: `Day ${next.number} shows no time on this work.`, reason_code: 'other' };
}

// ── Per persona ─────────────────────────────────────────────────────────────

const minutesOf = (events) => events.reduce((sum, e) => sum + (Date.parse(e.ended_at) - Date.parse(e.started_at)), 0) / 60000;
const inRanges = (ranges, day) => (ranges ?? []).some(([from, to]) => day >= from && day <= to);
let unresolved = 0;
let changedFiles = 0;
let outOfDate = 0;

for (const persona of PERSONAS) {
  if (only && persona !== only) continue;
  const mod = await import(pathToFileURL(path.join(here, `${persona}.mjs`)).href);
  const dir = path.join(dataRoot, persona);
  const files = fs.readdirSync(dir).filter((f) => /^reflect_(?:[a-z0-9]+_)*day_\d{2}\.json$/.test(f)).sort();
  const texts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const days = texts.map((t) => JSON.parse(t));
  const problems = [];
  const stats = { labelled: 0, unlabelled: 0, relabelled: { context: 0, intent: 0, quality: 0 }, noStream: [] };

  // ── persona_key.json ──
  const work_streams = Object.fromEntries(
    Object.entries(mod.streams).map(([key, s]) => [key, { title: s.title, kind: s.kind, aliases: s.aliases, priorities: mod.priorities[key] ?? [] }]),
  );
  const keyText = `${JSON.stringify({ work_streams }, null, 2)}\n`;

  // A profile change must be worded as the user would word it — never lifted from what a later day's file says the day was about.
  const laterTexts = new Set(days.slice(1).flatMap((d) => [...(d.persona.priorities ?? []), ...(d.persona.current_work ?? [])]));
  const firstTexts = new Set([...(days[0].persona.priorities ?? []), ...(days[0].persona.current_work ?? [])]);
  for (const updates of Object.values(mod.profile)) {
    for (const u of updates) {
      for (const text of [u.priority, u.to, ...(u.current_work ?? [])].filter(Boolean)) {
        if (text.length > 60) problems.push(`profile text over 60 characters: "${text}"`);
        if (laterTexts.has(text) && !firstTexts.has(text)) problems.push(`profile text copies a later day's answer-key wording: "${text}"`);
      }
    }
  }

  // ── Pass 1: streams and labels, and each day's minutes per stream ──
  const summaries = [];
  days.forEach((day, index) => {
    const n = day.day.day_number;
    const events = new Map(day.raw_events.map((e) => [e.id, e]));
    const byStream = new Map();
    const troubleByStream = new Map();
    let workMinutes = 0;
    for (const activity of day.ground_truth.activities) {
      const own = activity.event_ids.map((id) => events.get(id)).filter(Boolean);
      const minutes = minutesOf(own);
      let stream;
      if (mod.streamOf === null) stream = activity.area !== null && activity.area in mod.streams ? activity.area : null;
      else {
        const area = activity.label_notes && 'area' in activity.label_notes ? activity.label_notes.area : activity.area;
        stream = mod.streamOf(`${String(area).toLowerCase()} | ${activity.title.toLowerCase()}`, n, activity);
        if (stream !== null && !(stream in mod.streams)) problems.push(`day ${n} ${activity.id}: streamOf returned unknown stream "${stream}"`);
        activity.stream = stream;
        if (stream === null && own.length > 0) stats.noStream.push(`d${n} ${activity.id} ${Math.round(minutes)}m "${activity.title}" [${String(area).slice(0, 30)}]`);
        const kind = stream ? mod.streams[stream].kind : null;
        const { labels, notes } = labelsFor(activity, stream, kind, minutes);
        for (const field of ['context', 'intent', 'quality']) {
          if (labels[field] !== activity[field]) stats.relabelled[field]++;
          activity[field] = labels[field];
        }
        if (Object.keys(notes).length > 0) activity.label_notes = { ...(activity.label_notes ?? {}), ...notes };
        if (own.length > 0) {
          const ok = canonical(CONTEXTS, activity.context) && canonical(INTENTS, activity.intent) && canonical(QUALITIES, activity.quality);
          if (ok) stats.labelled++;
          else stats.unlabelled++;
        }
      }
      if (stream && mod.streams[stream].kind === 'work') {
        byStream.set(stream, (byStream.get(stream) ?? 0) + minutes);
        workMinutes += minutes;
        if (TROUBLE.test(`${activity.title} ${activity.summary}`)) troubleByStream.set(stream, (troubleByStream.get(stream) ?? 0) + minutes);
      }
    }
    summaries[index] = { number: n, byStream, troubleByStream, workMinutes };
  });

  // ── Pass 2: profile updates and the coach key ──
  days.forEach((day, index) => {
    const n = day.day.day_number;
    const updates = mod.profile[n];
    if (updates) day.profile_updates = updates;
    else delete day.profile_updates;

    const coach = day.expected_coach_outcome;
    // The key as first written, kept when a day's expectation is restated as "say nothing".
    const first = coach.original_actions ?? { primary_action: coach.primary_action, secondary_action: coach.secondary_action };
    if (mod.coach === 'keep') {
      for (const slot of ['primary_action', 'secondary_action']) {
        const action = coach[slot];
        if (action) action.target_stream = action.target !== null && action.target in mod.streams ? action.target : null;
      }
      return;
    }
    const entry = mod.coach[n];
    if (!entry) {
      problems.push(`day ${n}: no coach entry`);
      return;
    }
    const [primary, secondary, strength, note, extra] = entry;
    for (const key of [primary, secondary, ...(extra?.acceptable ?? []), ...(extra?.forbidden ?? [])]) {
      if (key !== null && key !== undefined && !(key in mod.streams)) problems.push(`day ${n}: coach names unknown stream "${key}"`);
    }
    const restated = primary === null || (first.secondary_action !== null && secondary === null);
    if (restated) coach.original_actions = first;
    else delete coach.original_actions;
    coach.primary_action = primary === null ? null : { ...first.primary_action, target_stream: primary };
    coach.secondary_action = secondary === null || first.secondary_action === null ? null : { ...first.secondary_action, target_stream: secondary };
    if (primary !== null && first.primary_action === null) problems.push(`day ${n}: a primary stream is given but the key has no primary action`);

    coach.action_opportunity = {
      should_exist: strength === 'strong',
      strength,
      reason: note ?? first.primary_action?.reason ?? 'the answer key expects no action',
      priority: primary === null ? null : (mod.priorities[primary]?.[0] ?? null),
      type: primary === null ? null : (first.primary_action?.action_type ?? null),
    };
    const closedToday = Object.keys(mod.closed).filter((key) => inRanges(mod.closed[key], n));
    const forbidden = [...new Set([...closedToday, ...(extra?.forbidden ?? [])])].filter((key) => key !== primary && key !== secondary && !(extra?.acceptable ?? []).includes(key));
    if (extra?.acceptable?.length) coach.acceptable_streams = extra.acceptable;
    else delete coach.acceptable_streams;
    if (forbidden.length) coach.forbidden_streams = forbidden;
    else delete coach.forbidden_streams;
    for (const key of closedToday) if (key === primary || key === secondary) problems.push(`day ${n}: "${key}" is both expected and closed`);

    // The user's response: per work stream, and for the day's expected move.
    const next = summaries[index + 1];
    delete coach.execution_scenario;
    delete coach.response_by_stream;
    if (next) {
      const responses = {};
      for (const [key, stream] of Object.entries(mod.streams)) {
        if (stream.kind !== 'work') continue;
        responses[key] = responseFor(key, next, forbidden.includes(key));
      }
      coach.response_by_stream = responses;
      if (primary !== null) coach.execution_scenario = responses[primary];
    }
  });

  // ── Report, write or check ──
  // A persona whose key is kept as it is gets one line added per expected action and nothing else moves; the
  // others are written back in the layout they were read in.
  const addTargetStream = (text) =>
    text.replace(/^([ \t]*)"target": ("(?:[^"\\]|\\.)*"|null)(\r?)$/gm, (_, indent, value, cr) => `${indent}"target": ${value},${cr}\n${indent}"target_stream": ${value}`+ cr);
  const out = days.map((d, i) => {
    if (mod.coach === 'keep') {
      const patched = /"target_stream"/.test(texts[i]) ? texts[i] : addTargetStream(texts[i]);
      if (JSON.stringify(JSON.parse(patched)) === JSON.stringify(d)) return patched;
    }
    return serializeLike(d, texts[i]);
  });
  const changed = out.filter((text, i) => text !== texts[i]).length;
  const keyPath = path.join(dir, 'persona_key.json');
  const keyChanged = !fs.existsSync(keyPath) || fs.readFileSync(keyPath, 'utf8') !== keyText;

  const opportunities = { strong: 0, moderate: 0, none: 0 };
  const decisions = {};
  for (const day of days) {
    const o = day.expected_coach_outcome.action_opportunity;
    if (o) opportunities[o.strength]++;
    const s = day.expected_coach_outcome.execution_scenario;
    if (s) {
      const key = s.user_decision === 'accepted' ? `accepted/${s.execution}/${s.outcome}` : s.user_decision;
      decisions[key] = (decisions[key] ?? 0) + 1;
    }
  }
  console.log(`\n=== ${persona}: ${changed} of ${files.length} day file(s) ${WRITE ? 'written' : 'would change'}${keyChanged ? ', persona_key.json ' + (WRITE ? 'written' : 'would change') : ''}`);
  if (mod.streamOf !== null) {
    console.log(`  activities with canonical context/intent/quality: ${stats.labelled} of ${stats.labelled + stats.unlabelled} on-screen (relabelled: context ${stats.relabelled.context}, intent ${stats.relabelled.intent}, quality ${stats.relabelled.quality})`);
    console.log(`  on-screen activities with no stream: ${stats.noStream.length}`);
    for (const line of stats.noStream.slice(0, args.includes('--all') ? 999 : 12)) console.log(`     ${line}`);
  }
  console.log(`  profile updates on ${Object.keys(mod.profile).length} day(s); coach days strong ${opportunities.strong} · optional ${opportunities.moderate} · silent ${opportunities.none}`);
  console.log(`  user response to the expected move: ${Object.entries(decisions).map(([k, v]) => `${k} ${v}`).join(' · ') || '(kept as it is)'}`);
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  unresolved += problems.length;

  if (CHECK && (changed > 0 || keyChanged)) outOfDate++;
  if (WRITE && problems.length === 0) {
    out.forEach((text, i) => {
      if (text !== texts[i]) fs.writeFileSync(path.join(dir, files[i]), text);
    });
    if (keyChanged) fs.writeFileSync(keyPath, keyText);
    changedFiles += changed;
  }
}

if (unresolved > 0) {
  console.log(`\n${unresolved} problem(s) — nothing was written for the personas that have them.`);
  process.exit(1);
}
if (CHECK && outOfDate > 0) {
  console.log(`\n${outOfDate} persona(s) are out of date with data/keys — run build.mjs --write.`);
  process.exit(1);
}
console.log(WRITE ? `\n${changedFiles} file(s) written.` : CHECK ? '\nUp to date.' : '\nDry run. Pass --write to apply.');
