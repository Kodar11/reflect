# Reflect benchmark

Runs a 30-day simulated user through the **real** Reflect pipeline and the **real** Gemini model, then scores what Reflect produced against held-out ground truth.

> Given only the observable raw events and normal user state, how well does Reflect reconstruct the user's activity and produce Reflection + Coach intelligence?

```
tests/benchmark/
├── data/founder_freelancer/reflect_day_01.json … reflect_day_30.json
├── runner/            what talks to Reflect (sees raw events only)
├── evaluators/        what scores Reflect (the only place the answer key is read)
├── dataset.test.ts    dataset validation — runs with the ordinary suite
├── evaluators.test.ts evaluator unit tests — runs with the ordinary suite
├── benchmark.test.ts  the end-to-end run — only with REFLECT_BENCHMARK=1
├── cli.mjs            launcher
└── results/latest/ , results/archived/<run id>/
```

## Running it

```bash
npm run benchmark:validate
```

Validates the dataset and stops. No database, no Gemini.

```bash
npm run benchmark
```

The full run. Needs `GEMINI_API_KEY` (read from `.env`, as the app does in development) and makes real requests.

```bash
npm run benchmark -- --days 3 --keep-db --save-prompts
```

A short run for debugging: three days, the database kept at `results/latest/benchmark.db`, every prompt and raw response under `results/latest/prompts/`.

```bash
npm run benchmark -- --reevaluate
```

Re-scores the stored run in `results/latest` with the current evaluators and thresholds (for example `--reevaluate --iou 0.3`). It reads the captured output only — no database, no Gemini — so a change to how things are measured is applied to the same model output instead of to a new, differently-random run.

`npm run benchmark -- --help` lists every option. The launcher starts vitest under Electron's Node (the runtime the SQLite binding is built for, as `npm run test:db` does) in the simulated user's timezone.

## What happens in a run

1. **Validate** the dataset. Any error stops the run; nothing is repaired.
2. **Split** it into `ReflectInput` (raw events + persona) and `EvaluationOnly` (ground truth, expected reflection, expected coach outcome).
3. Create an **isolated database** — a fresh temporary file, run through the normal migrations. The app's own database is never opened.
4. **Onboard** as the persona through `UserProfileRepository` (roles, description, current work, priorities).
5. For each day, on the **same database**:
   - insert the day's raw events through `EventRepository`;
   - move the simulated clock to the end of the day;
   - run **one** production cycle: `IntelligenceScheduler.runCycle()` → `ReflectionScheduler.runCycle()` → `CoachService.observe()` — the order `main.ts` runs them in;
   - capture the timeline, AI activities, report, coach actions, memory;
   - evaluate against that day's answer key and write `results/latest/days/day_NN.json`.
6. Aggregate into `summary.json`, `report.md`, `review.md` and `manifest.json`; copy the run to `results/archived/<run id>/`.

The service graph in `runner/runtime.ts` is constructed the way `src/electron/main.ts` constructs it. The only substitutions are seams production code already exposes: the database path, the `now` clock, and scheduler timers (inert, so nothing fires on its own).

### When the day's cycle runs

At the user's reflection time (22:00 by default), or — on a day that ran later — at the first hourly tick after the last event, so the whole day has been analysed before it is reflected on. One cycle per day. A day that ends after midnight is reflected on as a closed day, through the scheduler's ordinary backlog path.

### How raw events are stored

Format only, never meaning (`runner/ingest.ts`):

| Dataset | Stored as | Why |
| --- | --- | --- |
| `watcher: "desktop"` | `window` | Reflect's foreground-window watcher is named `window` |
| `+05:30` timestamps | UTC ISO strings | what the heartbeat engine writes; range queries compare these strings |
| full URL | host only | the tracker stores only the host (`getDomain`); `--url-mode raw` keeps the URL |

## Gemini requests

Every request goes through the production `GeminiClient`, unchanged. A meter around it counts requests per stage:

| Stage | Made by | Expected |
| --- | --- | --- |
| `activity_reconstruction` | `IntelligenceService` | one per hour that has events (`--intelligence-window hour`), or one per day (`day`) |
| `thread_linking` | `ReflectionAnnotator` | about one per day (cached per activity signature) |
| `daily_reflection_coach` | `ReflectionService` + Coach, one request | one per day, plus production retries |
| `reflection` | `ReflectionService` for a closed week | one per week |

So "about 30 daily intelligence calls" is the `daily_reflection_coach` row. In the default `hour` mode the activity reconstruction that feeds it adds roughly 13 requests per day. Retries are the pipelines' own (three attempts, as in production); the harness adds none, except that a cycle stopped by an infrastructure failure (quota, network) is run again after a pause — the app's next tick — up to `--cycle-retries` times, after which the run is aborted rather than scored.

## Keeping the answer key out

- `splitDataset` builds `ReflectInput` by copying a whitelist of observable fields. A new answer-key field in the files cannot reach Reflect by accident.
- `runner/day.ts`, `runner/ingest.ts` and `runner/runtime.ts` — everything that touches a production service — import no answer-key type and nothing from `evaluators/`.
- A tripwire checks the claim: every sentence of the answer key is turned into 8-word shingles, and each outgoing prompt, and after the run every text value in the benchmark database, is searched for them. A hit aborts the run. The counts are in `manifest.json` under `safeguards`.

## What is measured

**Activities** (`evaluators/segmentation.ts`) — precision, recall, F1, temporal IoU (mean and duration-weighted), ground-truth coverage, over- and under-segmentation, boundary precision / recall / F1 / MAE, duration error. A predicted block matches a ground-truth activity on temporal overlap of the events it owns; titles are never compared. Two tracks are scored: the **timeline** the user sees (AI activities, deterministic sessions where there is none) and the **sessionizer alone** as a no-AI baseline.

**Classification** (`evaluators/classification.ts`, `taxonomyMapping.ts`) — per dimension and all together, by matched pair and by tracked time. The dataset's labels are mapped to Reflect's taxonomy in the open:

| Dataset | Compared with | |
| --- | --- | --- |
| context (Work / Leisure / Personal) | Reflect **Area** | exact |
| area (Own SaaS / Freelance / …) | the stated **priority** Reflection linked the activity to | Reflect has no such classification dimension — reported as ambiguous |
| intent | Reflect **Intent** | `Review`, `Complete` have no twin — judged against an accept-set |
| quality | Reflect **Quality** | `Focused` accepts `Focused` or `Deep Work` |

Strict accuracy counts only labels with a single Reflect twin; lenient accuracy uses the accept-sets; unmappable labels are excluded and counted.

**Reflection** (`evaluators/reflection.ts`) — A: deterministic checks (generated, well-formed, every cited activity and metric exists, measurements agree with the raw events, no impossible numbers, no answer-key wording). B: answer-key criteria as PASS / PARTIAL / FAIL — key observations, priority alignment, uncertainty, next step.

**Coach** (`evaluators/coach.ts`) — thirteen criteria as PASS / PARTIAL / FAIL / NOT_APPLICABLE.

### Two kinds of verdict

- **structural** — computed from ids, intervals and stored numbers. Exact.
- **lexical · low confidence** — meaning compared without a second model, by concept coverage and word lists (`evaluators/text.ts`). "Client work displaced planned product work" and "an urgent client issue consumed time that was available for product development" count as the same idea. It is a screening signal and it will be wrong sometimes: `review.md` puts the answer key next to what Reflect wrote, for every day, so a person can confirm or overrule it.

No second model is used for scoring.

## Reproducibility

`manifest.json` records the run id, dataset version (hash of the files), persona, day range, git commit, Node / Electron / vitest versions, Gemini model and the model version that answered, prompt and schema versions, the full configuration including matching thresholds, the profile and taxonomy Reflect was given, and totals for requests, retries and failures.

The harness itself is deterministic: no randomness, fixed ordering, deterministic matching. Gemini is not — the same dataset, code, configuration and model give *comparable* runs, not identical ones.

## Options that change what is measured

| Flag | Default | Alternative |
| --- | --- | --- |
| `--intelligence-window` | `hour` — production cadence | `day` — one whole-day request; cheaper, but not how the app runs |
| `--action-policy` | `none` — the dataset contains no user decisions, so suggestions expire | `accept_all` — every suggestion is accepted, exercising follow-through and observation |
| `--url-mode` | `domain` — what the tracker stores | `raw` |
| `--iou`, `--boundary-tolerance-ms`, `--min-overlap-ms` | 0.5, 60 s, 60 s | |
