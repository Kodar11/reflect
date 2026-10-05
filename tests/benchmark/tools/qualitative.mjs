#!/usr/bin/env node
// Qualitative Coach review of a stored run — no database, no Gemini.
//
//   node tests/benchmark/tools/qualitative.mjs [results dir] [--all]
//
// For every day with a strong opportunity (every day with --all) it lays out,
// from what the run stored:
//
//   GROUND TRUTH      what the answer key says should matter
//   OBSERVED CONTEXT  what Reflect actually knew: the situation board and the signals it measured
//   COACH DECISION    how the model read each priority, and act / null
//   ACTION · TARGET · EVIDENCE
//   VERDICT · WHY
//
// and, for every earlier action settled since the day before:
//
//   PREVIOUS ACTION → user decision → execution → outcome → NEXT COACH DECISION → did it learn?
//
// It needs a run made with --save-prompts (the scenario runs always are).
// Written next to the run as coach_qualitative.md.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const all = args.includes('--all');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'tests/benchmark/results/latest');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const daysDir = path.join(dir, 'days');
if (!fs.existsSync(daysDir)) {
  console.error(`No stored run at ${dir}`);
  process.exit(1);
}

/** Every coach attempt of a day: the prompt's coach context and the parsed coach half of the response. */
function attemptsOf(dayNumber) {
  const promptDir = path.join(dir, 'prompts', `day_${String(dayNumber).padStart(2, '0')}`);
  if (!fs.existsSync(promptDir)) return [];
  return fs
    .readdirSync(promptDir)
    .filter((f) => f.includes('daily_reflection_coach'))
    .sort()
    .map((f) => {
      const stored = readJson(path.join(promptDir, f));
      const prompt = stored.request?.prompt ?? '';
      let coach = null;
      try {
        coach = JSON.parse(stored.responseText ?? 'null')?.coach ?? null;
      } catch {
        coach = null;
      }
      return { prompt, coach };
    });
}

const section = (prompt, heading) => {
  const start = prompt.indexOf(heading);
  if (start < 0) return '';
  const end = prompt.indexOf('\n\n', start);
  return prompt.slice(start, end < 0 ? undefined : end);
};
const jsonLines = (text) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const out = ['# Coach — qualitative review', '', `Run: \`${path.basename(dir)}\` · ${all ? 'every day' : 'days with a strong opportunity'}`, ''];
const files = fs.readdirSync(daysDir).filter((f) => /^day_\d{2}\.json$/.test(f)).sort();

for (const file of files) {
  const day = readJson(path.join(daysDir, file));
  const assessment = day.evaluation?.coach?.assessment;
  if (!assessment) continue;
  if (!all && assessment.opportunity.strength !== 'strong' && assessment.adaptation.length === 0) continue;

  const actions = day.captured.coach.actions;
  const priorities = new Map(day.captured.priorities.map((p) => [p.id, p.text]));
  const attempts = attemptsOf(day.dayNumber);
  // The attempt whose coaching was kept: the one that proposed the stored actions (or, for a null day, the first that concluded there was none).
  const kept =
    attempts.find((a) => actions.length > 0 && actions.every((act) => (a.coach?.actions ?? []).some((x) => x.title === act.title))) ??
    attempts.find((a) => actions.length === 0 && a.coach?.decision?.verdict === 'no_useful_move') ??
    attempts[0] ??
    null;

  out.push(`## Day ${day.dayNumber} — ${day.date} · opportunity: ${assessment.opportunity.strength}`, '');
  out.push(`**GROUND TRUTH** — ${assessment.expectedPrimary ?? 'no action'}${assessment.expectedSecondary ? `  \n_also:_ ${assessment.expectedSecondary}` : ''}`, '');

  if (kept) {
    const board = jsonLines(section(kept.prompt, 'SITUATION BY PRIORITY'));
    const signals = jsonLines(section(kept.prompt, 'NEXT-MOVE SIGNALS'));
    out.push('**OBSERVED CONTEXT** — what Reflect knew');
    for (const line of board) {
      out.push(
        `- “${line.priority}”: ${line.today}${line.lastStoodAt ? `; last stood at ${line.lastStoodAt}` : ''}` +
          `${line.withoutTime ? `; without time: ${line.withoutTime}` : ''}${line.carriedOver ? `; ${line.carriedOver}` : ''}; coach so far: ${line.coachSoFar}`,
      );
    }
    out.push(
      signals.length > 0
        ? `- signals: ${signals.map((s) => `${s.signal}/${s.strength}${s.priorityId ? ` (${priorities.get(s.priorityId) ?? s.priorityId})` : ''}`).join(' · ')}`
        : '- signals: none measured',
      '',
    );

    const decision = kept.coach?.decision;
    if (decision) {
      out.push(`**COACH DECISION** — ${decision.verdict === 'act' ? 'act' : 'null'}${attempts.length > 1 ? ` (${attempts.length} attempts)` : ''}`);
      for (const c of decision.candidates ?? []) {
        out.push(`- “${priorities.get(c.priorityId) ?? c.priorityId}” read as **${c.state}**${c.item ? ` — item: ${c.item}` : ''}${c.nextMove ? ` — next: ${c.nextMove}` : ''}`);
      }
      out.push('');
    }
  }

  if (actions.length === 0) {
    out.push(`**ACTION** — none${assessment.noActionReason ? ` (“${assessment.noActionReason}”)` : ''}`, '');
  } else {
    for (const action of actions) {
      out.push(
        `**ACTION** — ${action.title}`,
        `**TARGET** — ${action.priorityId ? `“${priorities.get(action.priorityId) ?? action.priorityId}”` : action.thread ?? 'the day as a whole'} · ${action.actionType} · ${action.daypart}${action.focusMinutes ? ` · ${action.focusMinutes}m` : ''}`,
        `**EVIDENCE** — ${action.rationale}${action.evidence?.length ? `  \n_cites:_ ${action.evidence.map((e) => e.label + (e.value ? ` = ${e.value}` : '')).slice(0, 4).join(' · ')}` : ''}`,
        '',
      );
    }
  }
  const uncertainty = day.captured.reflection.report?.coach?.uncertainty ?? [];
  if (uncertainty.length > 0) out.push(`**UNCERTAINTY STATED** — ${uncertainty.join(' ')}`, '');

  out.push(`**VERDICT** — ${assessment.verdict.replace(/_/g, ' ')}`, '', `**WHY** — ${assessment.why}`, '');

  for (const check of assessment.adaptation) {
    const earlier = day.captured.coach.earlierActions.find((a) => a.id === check.earlierActionId);
    if (!earlier) continue;
    const decision = earlier.status === 'rejected' ? 'rejected' : earlier.status === 'snoozed' ? 'postponed' : earlier.acceptedAt ? 'accepted' : 'undecided';
    const execution = earlier.execution
      ? `${earlier.execution.replace('_', ' ')} (${earlier.executionSource === 'observed' ? 'observed by Reflect' : earlier.observation?.kind === 'executed' || earlier.observation?.kind === 'attempted' ? 'reported by the user; Reflect also saw matching work' : 'reported by the user'})`
      : '—';
    out.push(
      `**ADAPTATION** — _previous action:_ “${earlier.title}” → _decision:_ ${decision}${earlier.reasonCode ? ` (${earlier.reasonCode.replace(/_/g, ' ')})` : ''} → _execution:_ ${execution} → _outcome:_ ${earlier.outcome?.replace(/_/g, ' ') ?? '—'}` +
        ` → _next coach decision:_ ${actions.length > 0 ? actions.map((a) => `“${a.title}” (${a.strategyKey})`).join('; ') : 'no action'}` +
        ` → _did it learn?_ **${check.pass ? 'yes' : 'no'}** — ${check.behaviour}`,
      '',
    );
  }
}

const target = path.join(dir, 'coach_qualitative.md');
fs.writeFileSync(target, `${out.join('\n')}\n`);
console.log(`wrote ${target} (${files.length} day file(s))`);
