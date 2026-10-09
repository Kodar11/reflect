#!/usr/bin/env node
// The whole benchmark, in one command:
//
//   npm run benchmark:all                       six personas × 30 days (real Gemini requests)
//   npm run benchmark:all -- --days 3           a short run of every persona
//   npm run benchmark:all -- --personas a,b     some of them
//   npm run benchmark:all -- --report-only      rebuild the combined report from the runs already there
//
// It does, in order:
//   1. validates every persona dataset and its answer key           (stops on any error)
//   2. checks the day files hold exactly what data/keys says         (stops if they are out of date)
//   3. runs each persona on its own fresh database through the real pipeline — profile changes replayed on
//      their day, the simulated user answering recommendations — and scores it against its answer key
//   4. writes one report per persona and one combined report
//
// Each persona's run is the ordinary `cli.mjs` run; nothing here changes what is measured. Results go to
// tests/benchmark/results/v2/<persona>/ (override with --results), so earlier results are never overwritten.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueOf = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const resultsRoot = path.resolve(valueOf('--results', path.join(here, 'results', 'v2')));
const parallel = Math.max(1, Number(valueOf('--parallel', '3')));
const days = valueOf('--days', null);
const baseline = valueOf('--baseline', null);
const reportOnly = args.includes('--report-only');
const passThrough = ['--action-policy', '--intelligence-window', '--min-call-interval-ms', '--cycle-retries'].flatMap((flag) => (args.includes(flag) ? [flag, valueOf(flag)] : []));
if (!passThrough.includes('--action-policy')) passThrough.push('--action-policy', 'scenario');

const dataRoot = path.join(here, 'data');
const NOT_A_PERSONA = ['coach_scenarios', 'keys'];
const all = fs.readdirSync(dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !NOT_A_PERSONA.includes(e.name)).map((e) => e.name).sort();
const personas = valueOf('--personas', null)?.split(',').filter(Boolean) ?? all;
for (const persona of personas) {
  if (!all.includes(persona)) {
    console.error(`Unknown persona "${persona}". Known: ${all.join(', ')}`);
    process.exit(2);
  }
}

const say = (message) => console.log(`[benchmark:all] ${message}`);
const run = (file, fileArgs) => spawnSync(process.execPath, [file, ...fileArgs], { stdio: 'inherit' }).status === 0;

if (!reportOnly) {
  say('validating every dataset and answer key');
  if (!run(path.join(here, 'cli.mjs'), ['--validate', '--all'])) process.exit(1);
  say('checking the day files against data/keys');
  if (!run(path.join(dataRoot, 'keys', 'build.mjs'), ['--check'])) process.exit(1);

  fs.mkdirSync(resultsRoot, { recursive: true });
  const queue = [...personas];
  const failed = [];
  const runOne = (persona) =>
    new Promise((resolve) => {
      const log = path.join(resultsRoot, `${persona}.console.log`);
      const out = fs.openSync(log, 'w');
      const child = spawn(process.execPath, [path.join(here, 'cli.mjs'), '--persona', persona, '--results', path.join(resultsRoot, persona), ...(days ? ['--days', days] : []), ...passThrough], { stdio: ['ignore', out, out] });
      const started = Date.now();
      say(`${persona}: started (log: ${path.relative(process.cwd(), log)})`);
      child.on('exit', (code) => {
        fs.closeSync(out);
        const line = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('[benchmark] completed') || l.includes('aborted')).pop();
        say(`${persona}: ${code === 0 ? 'done' : `FAILED (exit ${code})`} in ${Math.round((Date.now() - started) / 60000)} min${line ? ` — ${line.replace(/^.*\[benchmark\] /, '')}` : ''}`);
        if (code !== 0) failed.push(persona);
        resolve();
      });
    });
  const worker = async () => {
    for (let persona = queue.shift(); persona; persona = queue.shift()) await runOne(persona);
  };
  await Promise.all(Array.from({ length: Math.min(parallel, personas.length) }, worker));
  if (failed.length > 0) say(`runs that did not complete: ${failed.join(', ')} — the combined report covers what is there`);
}

say('writing the combined report');
const ok = run(path.join(here, 'tools', 'combined.mjs'), [resultsRoot, ...(baseline ? ['--baseline', path.resolve(baseline)] : [])]);
process.exit(ok ? 0 : 1);
