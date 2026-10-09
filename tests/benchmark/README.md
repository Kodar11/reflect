# Reflect benchmark

Runs a 30-day simulated user through the **real** Reflect pipeline and the **real** Gemini model, then scores what Reflect produced against held-out ground truth.

> Given only the observable raw events and normal user state, how well does Reflect reconstruct the user's activity and produce Reflection + Coach intelligence?

```
tests/benchmark/
├── data/<persona>/reflect[_<persona>]_day_NN.json   six personas × 30 days: raw events, profile changes, answer key
├── data/<persona>/persona_key.json   the persona's work streams (answer key; never sent to Reflect)
├── data/keys/<persona>.mjs   source of truth for streams, dated profile changes and the stream-level coach key
├── data/keys/build.mjs       applies data/keys to the day files and derives labels and user responses (--write / --check)
├── data/normalize.mjs        repairs mechanical drift in the persona day files (dry run unless --write)
├── AUDIT.md                  state of all six personas and of the evaluators
├── data/coach_scenarios/<scenario>/reflect_day_NN.json   twenty-two small Coach scenarios (+ generate.mjs)
├── data/annotate_coach.mjs   derives the coach answer-key annotations of the 30-day set
├── runner/            what talks to Reflect (sees raw events only)
├── runner/simulatedUser.ts   the user's decisions on recommendations (the one runner file that reads the answer key)
├── evaluators/        what scores Reflect (the only place the answer key is read)
├── evaluators/coachDiagnostics.ts   why each unanswered Coach day was unanswered (MISS_REASON)
├── runner/coachReplay.ts   the Coach's measurement layer replayed over a stored run — no Gemini
├── dataset.test.ts    dataset validation — runs with the ordinary suite
├── evaluators.test.ts evaluator unit tests — runs with the ordinary suite
├── benchmark.test.ts  the end-to-end run — only with REFLECT_BENCHMARK=1
├── coachScenarios.test.ts   scenario validation (always) + the live scenario run (REFLECT_COACH_SCENARIOS=1)
├── evaluators/streams.ts   what a recommendation is aimed at, read from its wording, its evidence and its priority
├── profileReplay.test.ts   dated profile replay against the real priority model (no Gemini)
├── cli.mjs            launcher for one persona
├── all.mjs            every persona, then the combined report: `npm run benchmark:all`
├── tools/combined.mjs  combined report over a results directory (JSON, Markdown, HTML)
└── results/latest/ , results/archived/<run id>/ , results/v2/<persona>/
```

## Running it

```bash
npm run benchmark:all
```

All six personas, thirty days each, and the combined report — one command. It validates every dataset and answer key, checks that the day files hold what `data/keys` says, runs each persona on its own fresh database (profile changes replayed on their day, the simulated user answering recommendations), scores each run and writes `results/v2/<persona>/latest/` plus `results/v2/combined.{json,md,html}`. Real Gemini requests: about 3,000 for the full set. `-- --days 3` runs a short pass, `-- --personas a,b` a subset, `-- --parallel 2` fewer at once, `-- --report-only` rebuilds the combined report from the runs already there, and `-- --baseline <results dir>` adds a before/after table.

The commands below run or inspect one persona.

```bash
npm run benchmark:validate
```

Validates the dataset and stops. No database, no Gemini.

```bash
npm run benchmark:validate -- --all
```

Validates every persona directory under `data/` and prints one line per persona with its error counts. `--persona <name>` picks one of them (for a run as well: `npm run benchmark -- --persona researcher`). It also prints how many of each persona's classification labels the evaluator can score. All six validate today; `AUDIT.md` says what limits the new ones have before they can be run.

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

```bash
npm run benchmark -- --action-policy scenario
```

The same thirty days with the **simulated user** answering each recommendation as the day's `execution_scenario` says — the run that exercises the whole Coach loop (decide → execute → outcome → adapt).

```bash
npm run benchmark -- --coach-scenarios
```

The twenty-two Coach scenarios instead of the 30-day set: each on its own database, through the same pipeline, with the simulated user. Results go to `results/coach_scenarios/summary.md` (`--scenario <text>` runs a subset).

```bash
npm run benchmark -- --diagnose
```

Reads the stored run in `results/latest` (or `--run <dir>`) and writes `coach_diagnostics.md` — one MISS_REASON for every Coach day that was not answered correctly — and `coach_signals.md`, the Coach's measurement layer replayed over the run's stored activities. No database, no Gemini. Every run and every `--reevaluate` writes the diagnostics too.

`npm run benchmark -- --help` lists every option. The launcher starts vitest under Electron's Node (the runtime the SQLite binding is built for, as `npm run test:db` does) in the simulated user's timezone.

## What happens in a run

1. **Validate** the dataset. Any error stops the run; nothing is repaired.
2. **Split** it into `ReflectInput` (raw events + persona) and `EvaluationOnly` (ground truth, expected reflection, expected coach outcome).
3. Create an **isolated database** — a fresh temporary file, run through the normal migrations. The app's own database is never opened.
4. **Onboard** as the persona through `UserProfileRepository` (roles, description, current work, priorities).
5. For each day, on the **same database**:
   - replay what the user changed in their profile that morning (`profile_updates` with `at: "start"`), with the clock just before the first event;
   - insert the day's raw events through `EventRepository`;
   - move the simulated clock to the end of the day;
   - run **one** production cycle: `IntelligenceScheduler.runCycle()` → (the evening's profile changes, `at: "end"`) → `ReflectionScheduler.runCycle()` → `CoachService.observe()` — the order `main.ts` runs them in;
   - capture the timeline, AI activities, report, coach actions, memory;
   - evaluate against that day's answer key and write `results/latest/days/day_NN.json`.
6. Aggregate into `summary.json`, `report.md`, `review.md` and `manifest.json`; copy the run to `results/archived/<run id>/`.

The service graph in `runner/runtime.ts` is constructed the way `src/electron/main.ts` constructs it. The only substitutions are seams production code already exposes: the database path, the `now` clock, and scheduler timers (inert, so nothing fires on its own).

### Profile changes are replayed on their day

A persona's priorities do not stand still for a month: an assignment is submitted, a video is published, a new ticket arrives. Reflect is onboarded with day 1's profile, and from then on each day file may carry `profile_updates` — what the user changed in their profile that day, in the order they changed it:

```json
"profile_updates": [
  { "at": "end", "op": "complete", "priority": "Complete the DBMS assignment due later this week" },
  { "at": "end", "op": "add", "priority": "Prepare for the Operating Systems quiz" }
]
```

`op` is `add`, `remove`, `complete`, `pause`, `resume`, `rename` (with `to`) or `set_current_work` (with `current_work[]`); `at` is `start` (before the day's first event) or `end` (in the evening, before the day is reflected on). The harness replays each change through the calls the app's own profile form and priority list make (`UserProfileRepository.updateProfile` + the profile-changed notification, `ReflectionService.setPriorityStatus`) with the simulated clock at that moment, so the priority's own history records it there — and nothing about it exists in Reflect's database before. A completed or paused priority stays in the record; it is closed, not erased.

These changes are **input**: they are part of `inputVersion`, they are worded as a user would word them, and a test asserts none of them copies what a later day's answer key says the day was about. The validator replays them and rejects a change that could not have been made (a priority that is not there, a sixth priority, text longer than the profile field).

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

**Reflection** (`evaluators/reflection.ts`) — A: deterministic checks (generated, well-formed, every cited activity and metric exists, every cited activity is anchored to raw events of the block it names, every insight has a backend-owned subject and continuity, carried work agrees with priority state and recent activity, measurements agree with the raw events, no impossible numbers, no answer-key wording). B: answer-key criteria as PASS / PARTIAL / FAIL — key observations, priority alignment, uncertainty, next step.

**Work streams** (`persona_key.json`, `evaluators/streams.ts`) — every persona's answer key names its bodies of work by a stable key (`dbms`, `pg_partial_video`, `Own SaaS`), labels each ground-truth activity with its stream, and states each expected move against a stream. Nothing in the evaluator recognises a project by the words one persona's files use for it. What a recommendation is aimed at is read, in this order, from what it **names** (a stream's aliases, as whole words, in its title, task or description), from the **evidence** it cites (the tracked events behind the activities it cites belong, in the answer key, to that stream), and from the **priority** it is linked to. The first that says anything decides, and the verdict says which one it was.

**Coach** — two layers.

`evaluators/coach.ts`: thirteen criteria as PASS / PARTIAL / FAIL / NOT_APPLICABLE. They mostly ask "did the Coach avoid doing something wrong?" — and a Coach that never says anything passes most of them, which is exactly how thirty days with zero actions once scored 70%.

`evaluators/coachDimensions.ts`: the other half, kept as separate numbers that are never merged:

| Question | Dimensions |
| --- | --- |
| Was the recommendation right? | opportunity recall · fully correct · partially correct · opportunity detection · opportunity precision · false opportunity rate · correctly silent days · action precision · alignment · specificity · evidence grounding · feasibility · not generic · not a repeat · concentration on one target · appropriate null |
| Did the user follow it? | decisions recorded · execution tracking coverage · established by Reflect itself · supported by Reflect's own observation · reported by the user only |
| Did it help? | outcome tracking coverage · outcomes as stated |
| Did the Coach adapt? | rejected not repeated · deferred not repeated · failed not repeated · worked reused · partly-worked refined · external constraint not penalised |

Three of these need a word:

- **Opportunity precision / false opportunity rate** are counted over DAYS on which the Coach said something: on how many did what it said answer an opportunity the day really held (verdict correct or partially correct), and on how many did it answer nothing the day called for (wrong or unnecessary). Action precision asks the same of each ACTION and is stricter (a repeat, a generic or an ungrounded action is not justified even on the right day). Recall can be bought with volume; these two are what volume costs.
- **Not a repeat** depends on what became of the first time, not on the calendar. The same move said again is a repeat when the earlier one was carried out, turned down, reported as not working, or not done for a reason about the action itself — or when today no longer calls for it. Said again while it is still unanswered, on a day that still calls for it, it is *restated while open*: reported, never counted against the Coach. Two actions that share a frame but name different things are two actions; a step that could not happen for an outside reason may be offered again.
- **Closed work.** An action linked to a priority the user marked completed or paused, or aimed only at streams the day's key lists under `forbidden_streams` (submitted, handed off, deliberately parked), is not justified whatever else is right about it.
- **Silence.** A day whose `action_opportunity.strength` is `none` expects no recommendation: silence is `correct_null`, any action `unnecessary`. Five of the six personas have such days (the founder key has optional days only). "Silence kept" is reported next to recall and precision.

- **Fully / partially correct.** On the 30-day set "partially correct" almost always means *the action was aimed at the day's secondary work stream instead of its primary one* — a question of which priority was chosen, not of how specific the sentence is. The key cannot tell "Continue the assignment" from "Finish the query-plan section" beyond the kind of action; that distinction is enforced in production (`CoachValidator`: a project is not a next action) and pinned by unit tests.
- **Concentration on one target** is the share of all actions aimed at the single most-recommended priority. It is reported, not scored: a user with one real priority should see it high.
- **Execution** is counted three ways and never merged: Reflect established it before anyone spoke; Reflect's tracked activity supports it at all; the user said so and Reflect saw nothing matching. Only the first two are "observed".
- **Worked reused** passes when the next action for that target keeps the strategy — the same kind of action, or the same shape (time of day + size) on a new item, or one that explicitly builds on the earlier action. The same sentence again is a repeat, not reuse, and fails.

Nothing rewards volume: an action on a day with no opportunity is `unnecessary` and lowers precision and appropriate-null, exactly as silence on a strong day lowers recall. `coach_review.md` lays every day out as GROUND TRUTH → REFLECT COACH → VERDICT → WHY, followed by action → decision → execution → outcome → what the Coach did next.

### Coach diagnostics — why a day was not answered

"The Coach missed it" is an outcome; the cause decides what to change. `coach_diagnostics.md` puts one reason next to every day that was not answered correctly, taken from the verdict, the Coach's own decision log for the day (every attempt: what it concluded, what it proposed, what the validator kept and why not) and the measurement layer replayed over the day's stored activities:

| Layer | MISS_REASON | Meaning |
| --- | --- | --- |
| DATA | `missing_upstream_evidence` | nothing tracked that day was linked to the expected target |
| OPPORTUNITY GENERATION | `candidate_not_generated` · `candidate_too_weak` · `historical_context_missing` | no signal for the target · only a "possible" one · the expected move rests on a multi-day pattern that was not measured as one |
| REASONING | `gemini_decision` · `unstable_decision` · `priority_choice` · `wrong_kind_of_action` · `false_opportunity` | a clear candidate, and silence · silence on one attempt and an action on another (the first valid answer is kept) · acted on another target · right target, wrong kind of move · acted on a day that called for nothing |
| VALIDATION | `validator_suppression` · `withdrawn_after_refusal` · `previous_action_suppression` · `repeat` | refused for how it was written · refused for its wording and then withdrawn on the retry · the model kept proposing what the record already covers and nothing else · right target, restating a recent action |
| PERSISTENCE | `retry_persistence_loss` | an attempt kept an action the stored report does not hold |
| EVALUATION | `evaluator_mismatch` | the action answers the day; the evaluator did not count it |

The replay (`runner/coachReplay.ts`) runs the Coach's deterministic half — situation board, signals, and what the record of earlier actions says about each signal — as the code is NOW over the activities a run produced THEN. For a fresh run the two coincide. For an older run the difference is the point: it shows what a change to the measurement layer would have measured on the same days, without the noise of a new model run.

### Coach answer key

`expected_coach_outcome` keeps `primary_action`, `secondary_action` and `things_not_to_do`. Each expected action carries `target_stream` (the stream key it is aimed at — this, not the wording of `target`, is what an action is matched against), and the outcome may add `acceptable_streams` (other work a good recommendation could equally be aimed at: full credit), `forbidden_streams` (work that is finished or parked that day), `response_by_stream` (what the simulated user does with a recommendation aimed at each stream), and:

```json
"action_opportunity": { "should_exist": true, "strength": "strong", "reason": "…", "priority": "…", "type": "complete_open_loop" },
"execution_scenario": { "user_decision": "accepted", "execution": "done", "outcome": "worked", "reason": "…", "reason_code": null }
```

- `strength`: `strong` (silence is a miss) · `moderate` (an action and silence are both fine) · `none` (any action is unnecessary). Absent: `strong` when a primary action is expected, otherwise `none`.
- `execution_scenario` is what the simulated user does: `accepted | rejected | deferred | not_applicable`, then `done | partial | not_done`, then `worked | partly_worked | did_not_work`. Not following an action never marks the recommendation as wrong, and an outcome is what was observed afterwards — no causality is claimed.

Both live only in the answer key. `splitDataset` does not copy them into `ReflectInput`, raw events are unchanged, and the dataset's `inputVersion` (a hash of persona + raw events) lets a stored run be re-scored after the answer key gains annotations.

For the 30-day set the two annotations are derived by `data/annotate_coach.mjs` from what the key already states (the expected actions, and the next day's ground-truth activities and priority assessments). That set has 24 strong and 6 moderate days and **no** null day, and its simulated user accepts and carries out everything. It therefore cannot tell a good Coach from a talkative one, and a Coach tuned to it would learn to always say something. Treat its recall as one reading among several: appropriate-null, rejection, postponement, failure, "too difficult", external-constraint handling and the choice among competing priorities are measured by the scenario set, which is the check against overfitting to this one.

For the other five personas `data/keys/<persona>.mjs` states, per day, the primary and secondary stream and the strength; `build.mjs` applies them. A day whose own expected "action" in the original key is to wait, hold or defer is restated as `none` (or as an optional day that names which other work is acceptable); the original actions are kept under `original_actions` and never scored. The user's response is derived from the **next day's ground truth** for each work stream — ninety minutes or more on it: accepted, done, worked; a short return: partial; none on a light day: "not now"; none while another stream took the day: rejected for a different priority; a closed stream: rejected as not relevant — so a recommendation aimed somewhere the user did not go is declined or left undone, whatever the day's expected move was. The simulated user therefore mostly accepts what the key expects; its rejections and postponements arise where the Coach points elsewhere.

**Classification labels.** Four personas' keys described `context`, `intent` and `quality` in free text. `build.mjs` restates them in the canonical vocabulary (Work / Leisure / Personal; the intents; Focused / Routine / Break-Idle) by fixed rules read from the key's own words — the first verb of its intent sentence, the first cue in its quality phrase — and keeps the original under `label_notes`. A label the key itself calls uncertain, ambiguous or mixed is left as it is: that time is not scored on that dimension, and every accuracy is reported next to the share of time it covers. These labels are rule-derived, not individually hand-labelled; treat a classification difference of a few points as within that noise.

**Uncertain activities and boundaries.** Where a key says of a stretch that its purpose cannot be told from the screen (context `Uncertain` / `Ambiguous` / `Mixed`), it asserts no activity boundary there. For segmentation that stretch is taken out of the comparison on both sides, and two pieces of one work stream separated only by it count as one activity. A key with no such activity is scored exactly as before.

### Coach scenario set

`data/coach_scenarios/` holds twenty-two 2–5 day datasets, one question each, across four personas (student, founder, writer, designer): clear open loop · priority repeatedly displaced · momentum worth protecting · approaching deadline · fragmented day · nothing needed · heavy load / rest · accepted-done-worked · previous action failed · previous action rejected · same app, different goal · stated priority vs attention · already on track · ambiguous evidence · external constraint · competing priorities (three, the next move on the smallest) · a finished priority going quiet · a one-off displacement · success reused on a new target · partly worked → refined · postponed ("not now") · too difficult → smaller. Each has exactly one **probe day**; the days before it are ordinary history (`moderate`). Seven probe days expect silence, two leave the choice open, thirteen expect one particular kind of move. A scenario passes when its probe day is answered correctly and every adaptation check holds. Regenerate with `node tests/benchmark/data/coach_scenarios/generate.mjs`.

**Seeded history.** A day may carry `coach_history`: recommendations that were on the user's Coach panel since the evening before, with the user's answer to each (`accepted | rejected | deferred`, then execution, outcome and a reason from Reflect's own list). The harness stores each one through `CoachRepository` exactly as the daily pass stores an action and then plays the user through the Coach's own service calls (`decide`, Reflect's observation sweep, `reportExecution`, `reportOutcome`). It lets a scenario ask "given THIS history, what does the Coach do next?" without depending on the Coach having happened to make that recommendation the day before — previously an adaptation scenario silently tested nothing whenever the earlier day produced no action. Seeded history is input, not answer key: it is part of `inputVersion`, and it never states what the Coach should do next.

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
| `--action-policy` | `none` — the user never answers, so suggestions expire | `scenario` — the simulated user answers as the answer key says for the work the action is aimed at (`npm run benchmark:all` uses this) · `accept_all` — every suggestion is accepted |
| `--same-events` (with `--reevaluate`) | off | score a run made before the dataset replayed profile changes, when its raw events are the ones on disk — old model output, today's key and evaluator |
| `--url-mode` | `domain` — what the tracker stores | `raw` |
| `--iou`, `--boundary-tolerance-ms`, `--min-overlap-ms` | 0.5, 60 s, 60 s | |
