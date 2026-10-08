#!/usr/bin/env node
// Launcher for the Reflect benchmark.
//
//   npm run benchmark -- [options]        run the benchmark (real Gemini requests)
//   npm run benchmark:validate            validate the dataset only (no database, no Gemini)
//   npm run benchmark:validate -- --all   validate every persona dataset under data/
//   npm run benchmark -- --reevaluate     re-score the stored run (no database, no Gemini)
//   npm run benchmark -- --diagnose       why each unanswered Coach day was unanswered (no database, no Gemini)
//   npm run benchmark -- --coach-scenarios   run the fifteen Coach scenarios (real Gemini requests)
//
// It turns flags into REFLECT_BENCH_* environment variables and starts vitest
// on the benchmark test under Electron's Node — the runtime the native SQLite
// binding is built for (the same way `npm run test:db` does).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

const HELP = `Reflect benchmark

Usage
  npm run benchmark -- [options]
  npm run benchmark:validate [-- --all | --persona <name>]

Options
  --days <n>                    run days 1..n only (history accumulates, so a run always starts at day 1)
  --keep-db                     keep the benchmark database in results/latest/benchmark.db
  --intelligence-window <mode>  hour (default) production cadence: one request per hour that has events
                                day  one request per day over the whole day
  --action-policy <policy>      none (default) the simulated user never answers a recommendation
                                accept_all  every recommendation is accepted
                                scenario    the user answers as the day's execution_scenario says: decides,
                                            then next day reports whether it happened and whether it helped
  --url-mode <mode>             domain (default) store the host only, as Reflect's tracker does; raw  store the dataset URL
  --iou <0..1>                  temporal IoU needed for a match (default 0.5)
  --boundary-tolerance-ms <ms>  boundary matching tolerance (default 60000)
  --min-overlap-ms <ms>         shared time that counts as overlap for over/under-segmentation (default 60000)
  --min-call-interval-ms <ms>   pause between Gemini requests, for rate-limited keys (default 0)
  --cycle-retries <n>           extra ticks after an infrastructure failure (default 2)
  --cycle-retry-delay-ms <ms>   wait before each extra tick (default 60000)
  --save-prompts                write every prompt and raw response to results/latest/prompts
  --tz <iana zone>              the simulated user's timezone (default Asia/Kolkata; must match the dataset's offset)
  --dataset <dir>               dataset directory (default tests/benchmark/data/founder_freelancer)
  --persona <name>              the dataset in tests/benchmark/data/<name> (short for --dataset)
  --all                         with --validate: every persona dataset under tests/benchmark/data
  --results <dir>               results directory (default tests/benchmark/results)
  --coach-scenarios             run the Coach scenario set (data/coach_scenarios) instead of the 30-day dataset:
                                each scenario on its own database, the simulated user answering as its answer
                                key says; results in results/coach_scenarios/
  --scenario <text>             with --coach-scenarios: only scenarios whose directory name contains this text
  --validate                    validate the dataset and stop
  --reevaluate                  re-score the stored run in results/latest with the current evaluators and
                                thresholds (--iou etc.); no database, no Gemini requests
  --diagnose                    classify every Coach day the stored run did not answer (MISS_REASON) and replay the
                                Coach's measurement layer over its stored activities; no database, no Gemini requests
  --run <dir>                   with --reevaluate / --diagnose: the stored run to read instead of results/latest
  --expected-days <n>           how many day files the dataset holds (default 30)
  --help
`;

const VALUE_FLAGS = {
  '--days': 'REFLECT_BENCH_DAYS',
  '--intelligence-window': 'REFLECT_BENCH_INTELLIGENCE_WINDOW',
  '--action-policy': 'REFLECT_BENCH_ACTION_POLICY',
  '--url-mode': 'REFLECT_BENCH_URL_MODE',
  '--iou': 'REFLECT_BENCH_IOU',
  '--boundary-tolerance-ms': 'REFLECT_BENCH_BOUNDARY_TOLERANCE_MS',
  '--min-overlap-ms': 'REFLECT_BENCH_MIN_OVERLAP_MS',
  '--min-call-interval-ms': 'REFLECT_BENCH_MIN_CALL_INTERVAL_MS',
  '--cycle-retries': 'REFLECT_BENCH_CYCLE_RETRIES',
  '--cycle-retry-delay-ms': 'REFLECT_BENCH_CYCLE_RETRY_DELAY_MS',
  '--tz': 'REFLECT_BENCH_TZ',
  '--dataset': 'REFLECT_BENCH_DATASET',
  '--results': 'REFLECT_BENCH_RESULTS',
  '--run': 'REFLECT_BENCH_RUN_DIR',
  '--scenario': 'REFLECT_COACH_SCENARIO_FILTER',
  '--expected-days': 'REFLECT_BENCH_EXPECTED_DAYS',
};
const BOOLEAN_FLAGS = { '--keep-db': 'REFLECT_BENCH_KEEP_DB', '--save-prompts': 'REFLECT_BENCH_SAVE_PROMPTS' };

const env = { ...process.env };
let validateOnly = false;
let reevaluateOnly = false;
let diagnoseOnly = false;
let coachScenarios = false;
let allPersonas = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split(/=(.*)/s);
  if (flag === '--help' || flag === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (flag === '--validate') {
    validateOnly = true;
  } else if (flag === '--reevaluate') {
    reevaluateOnly = true;
  } else if (flag === '--diagnose') {
    diagnoseOnly = true;
  } else if (flag === '--coach-scenarios') {
    coachScenarios = true;
  } else if (flag === '--all') {
    allPersonas = true;
  } else if (flag === '--persona') {
    const value = inline ?? args[++i];
    if (!value || /[\\/]/.test(value)) {
      process.stderr.write(`--persona needs the name of a directory in tests/benchmark/data\n\n${HELP}`);
      process.exit(2);
    }
    env.REFLECT_BENCH_DATASET = path.join(here, 'data', value);
  } else if (flag in BOOLEAN_FLAGS) {
    env[BOOLEAN_FLAGS[flag]] = '1';
  } else if (flag in VALUE_FLAGS) {
    const value = inline ?? args[++i];
    if (value === undefined) {
      process.stderr.write(`${flag} needs a value\n\n${HELP}`);
      process.exit(2);
    }
    env[VALUE_FLAGS[flag]] = value;
  } else {
    process.stderr.write(`Unknown option: ${args[i]}\n\n${HELP}`);
    process.exit(2);
  }
}

if (allPersonas && !validateOnly) {
  // A run writes one results directory for one persona's thirty days on one database.
  process.stderr.write('--all validates every persona; a run takes one persona at a time (--persona <name>)\n');
  process.exit(2);
}
if (allPersonas) env.REFLECT_BENCH_ALL_PERSONAS = '1';

const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
let command;
let commandArgs;
if (validateOnly) {
  // Pure validation: plain Node is enough.
  command = process.execPath;
  commandArgs = [vitest, 'run', 'tests/benchmark/dataset.test.ts'];
} else if (diagnoseOnly) {
  // Diagnosis reads stored output only: no database, no Gemini, plain Node.
  command = process.execPath;
  commandArgs = [vitest, 'run', 'tests/benchmark/diagnose.test.ts', '--disable-console-intercept'];
  env.REFLECT_BENCH_DIAGNOSE = '1';
} else if (reevaluateOnly) {
  // Re-scoring reads stored output only: no database, no Gemini, plain Node.
  command = process.execPath;
  commandArgs = [vitest, 'run', 'tests/benchmark/reevaluate.test.ts', '--disable-console-intercept'];
  env.REFLECT_BENCH_REEVALUATE = '1';
} else {
  // Under plain Node the `electron` package resolves to the path of its binary.
  command = require('electron');
  // Console interception off: progress lines appear as each simulated day finishes.
  commandArgs = [vitest, 'run', coachScenarios ? 'tests/benchmark/coachScenarios.test.ts' : 'tests/benchmark/benchmark.test.ts', '--pool=forks', '--disable-console-intercept'];
  env.ELECTRON_RUN_AS_NODE = '1';
  if (coachScenarios) env.REFLECT_COACH_SCENARIOS = '1';
  else env.REFLECT_BENCHMARK = '1';
  // Period boundaries are local calendar boundaries: run in the simulated user's zone.
  env.TZ = env.REFLECT_BENCH_TZ || 'Asia/Kolkata';
}

const child = spawn(command, commandArgs, { cwd: repoRoot, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
child.on('error', (err) => {
  process.stderr.write(`Could not start the benchmark: ${err.message}\n`);
  process.exit(1);
});
