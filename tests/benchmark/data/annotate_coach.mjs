#!/usr/bin/env node
// Adds the two coach answer-key annotations to the founder/freelancer day files:
//
//   expected_coach_outcome.action_opportunity   should the Coach have said anything at all?
//   expected_coach_outcome.execution_scenario   what the simulated user did with it, and what followed
//
// Both are derived from what the answer key ALREADY states — the expected
// actions of the day and the next day's ground-truth activities and priority
// assessments. Raw events are never touched. Re-running is idempotent.
//
//   node tests/benchmark/data/annotate_coach.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'founder_freelancer');
const files = fs.readdirSync(dir).filter((f) => /^reflect_day_\d{2}\.json$/.test(f)).sort();
const days = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

/** Action types whose whole point is "carry on" — useful to hear, never a miss to leave unsaid. */
const CONTINUATION = new Set(['continue_successful_behavior']);
/** A protect_priority that really says "do not change anything yet". */
const RESTRAINT = /\b(let .* run|hold .* steady|observation mode|wait for)\b/i;

const isRestraint = (a) => a !== null && (CONTINUATION.has(a.action_type) || RESTRAINT.test(a.title));

/** Which stated priority a work stream's action belongs to. */
function priorityOf(action, priorities) {
  if (!action) return null;
  const find = (re) => priorities.find((p) => re.test(p)) ?? null;
  if (action.target === 'Own SaaS') return find(/saas/i);
  if (action.target === 'Freelance') {
    return /\b(lead|prospect|proposal|estimate|inquiry|opportunity|outreach)\b/i.test(`${action.title} ${action.reason}`) ? find(/lead/i) : find(/client/i);
  }
  return null;
}

const minutesOf = (a) => {
  const [h1, m1] = a.started_at.split(':').map(Number);
  const [h2, m2] = a.ended_at.split(':').map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

/** How far the next day's answer key says a priority moved: 0 none … 4 strong. Mirrors evaluators/reflection.ts. */
function progressLevel(assessment) {
  const text = assessment.toLowerCase();
  if (/\bno (substantial|meaningful|visible)\b|\blittle visible\b|\bnone\b/.test(text)) return 0;
  if (/\bmaintenance\b|\blimited\b|\bsmall\b|\bcontained\b|\bbrief\b/.test(text) && !/\bstrong\b/.test(text)) return 1;
  if (/\bsome\b|\bmoderate\b/.test(text) && !/\bstrong\b/.test(text)) return 2;
  if (/\bstrong(er)?\b|\bcompleted\b/.test(text)) return 4;
  if (/\bmeaningful(ly)?\b/.test(text)) return 3;
  return null;
}

let strong = 0;
let moderate = 0;
days.forEach((day, index) => {
  const coach = day.expected_coach_outcome;
  const primary = coach.primary_action;
  const secondary = coach.secondary_action;
  const priorities = day.persona.priorities;

  // ── Opportunity ──
  // Strong: a concrete unfinished, displaced or undecided item is visible.
  // Moderate: the useful thing to say is "carry on" — worth saying, fine to leave unsaid.
  const strength = primary === null ? 'none' : isRestraint(primary) ? 'moderate' : 'strong';
  if (strength === 'strong') strong++;
  if (strength === 'moderate') moderate++;
  coach.action_opportunity = {
    should_exist: strength === 'strong',
    strength,
    reason:
      strength === 'none'
        ? 'Nothing in the day calls for a next action.'
        : strength === 'moderate'
          ? `Carrying on is the useful move: ${primary.reason}`
          : primary.reason,
    priority: priorityOf(primary, priorities),
    type: primary?.action_type ?? null,
  };

  // ── What the user did with it, read off the NEXT day's ground truth ──
  const next = days[index + 1];
  delete coach.execution_scenario;
  if (!primary || !next) return;
  const target = primary.target;
  const worked = next.ground_truth.activities.filter((a) => a.area === target).reduce((sum, a) => sum + minutesOf(a), 0);
  const workTotal = next.ground_truth.activities.filter((a) => a.context === 'Work').reduce((sum, a) => sum + minutesOf(a), 0);
  const wanted = Math.max(30, Math.round((primary.suggested_focus_minutes ?? 60) * 0.75));
  const priority = priorityOf(primary, priorities);
  const level = progressLevel(next.expected_reflection.priority_alignment.find((p) => p.priority === priority)?.assessment ?? '');

  const execution = worked >= wanted ? 'done' : worked >= 20 ? 'partial' : 'not_done';
  // The outcome is the next day's own assessment of the targeted priority — what was observed afterwards, not a claim that the advice caused it.
  const outcome = execution === 'not_done' ? 'not_applicable' : level === null ? 'partly_worked' : level >= 3 ? 'worked' : level >= 1 ? 'partly_worked' : 'did_not_work';
  const crowded = workTotal > 0 && (workTotal - worked) / workTotal >= 0.7;
  coach.execution_scenario = {
    user_decision: 'accepted',
    execution,
    outcome,
    reason:
      execution === 'not_done'
        ? `The next day shows ${worked} min on ${target}${crowded ? '; other work took the day' : ''}.`
        : `The next day shows ${worked} min on ${target}; its answer key rates that priority "${next.expected_reflection.priority_alignment.find((p) => p.priority === priority)?.assessment ?? 'unrated'}".`,
    reason_code: execution === 'not_done' ? (crowded ? 'external_constraint' : 'different_priority') : null,
  };
});

// The annotations are spliced into the file text right after things_not_to_do, so nothing else in the file
// — least of all a raw event — is reformatted or rewritten.
files.forEach((f, i) => {
  const file = path.join(dir, f);
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const coach = days[i].expected_coach_outcome;

  // Where things_not_to_do ends, and where the expected_coach_outcome object closes after it
  // (skipping over annotations written by an earlier run).
  const listEnd = text.indexOf(']', text.lastIndexOf('"things_not_to_do"')) + 1;
  let depth = 1;
  let objectEnd = listEnd;
  for (; objectEnd < text.length && depth > 0; objectEnd++) {
    if (text[objectEnd] === '{') depth++;
    if (text[objectEnd] === '}') depth--;
  }
  objectEnd--; // the closing brace of expected_coach_outcome

  const block = (key) => `,${eol}    "${key}": ${JSON.stringify(coach[key], null, 2).split('\n').join(`${eol}    `)}`;
  const added = block('action_opportunity') + (coach.execution_scenario ? block('execution_scenario') : '');
  const out = text.slice(0, listEnd) + added + eol + '  ' + text.slice(objectEnd);
  JSON.parse(out);
  fs.writeFileSync(file, out);
});
console.log(`annotated ${files.length} day(s): ${strong} strong, ${moderate} moderate, ${files.length - strong - moderate} none`);
