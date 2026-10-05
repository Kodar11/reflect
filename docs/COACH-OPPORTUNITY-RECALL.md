# Coach — opportunity recall: diagnostic report

Iteration of 2026-10-05. Prompt `reflect-coach-v4`, evaluator `reflect-benchmark-eval-v3`, model `gemini-3.5-flash-lite`.

The question was: *the Coach sometimes has enough evidence for a useful intervention and does not recognise it — where is it lost?* This is what the stored runs say, what was changed, and what the numbers did. Every figure below is from a live run through the real pipeline; where a comparison is made, both sides are scored by the same evaluator.

## 1. Where the opportunities were being lost

Classified with `npm run benchmark -- --diagnose` (`tests/benchmark/evaluators/coachDiagnostics.ts`): for every day that was not answered correctly, one reason, taken from the verdict, the Coach's own decision log for the day, and the measurement layer replayed over the day's stored activities.

**Baseline, 30-day Founder/Freelancer run — 21 of 30 days not answered correctly:**

| Layer | Days | Reason |
| --- | --- | --- |
| DATA | 0 | — |
| OPPORTUNITY GENERATION | 0 | — (but see below: the *ranking* of what was generated was the root of the next two rows) |
| REASONING | 11 | `priority_choice` 11 — acted on a different target than the day called for |
| VALIDATION | 10 | `previous_action_suppression` 8 — **every one of the 8 missed days**; `repeat` 2 |
| PERSISTENCE | 0 | — |

Not one missed day was the model deciding "no action". On all eight the model said **act**, proposed an action, and the validator refused it — correctly — as a repeat of something the user had already carried out. All three attempts then proposed the same thing again. Two sentences account for 14 of the 24 strong days: *"Complete the remaining sections of the freelance proposal in Google Docs"* and *"Review the remaining items on the SaaS Roadmap in Notion…"*.

Why the model fixated on them:

| # | Root cause | Evidence |
| --- | --- | --- |
| 1 | **An activity was read as a state.** `workStateOf` counted "drafting" / "drafted" as "the description says it is unfinished". | 28 of the 30 "explicitly open" activities in the run matched on `draft*` alone. A 20-minute routine outreach block produced the two highest-confidence signals of the day (`carried_over: clear 0.9`, `left_off: clear 0.75`) on most days. |
| 2 | **The last glance was read as the work.** "Where a priority stands" was its *last* activity. | Twenty minutes on the roadmap after 2h 25m on the dashboard made "Reviewing SaaS product roadmap" the SaaS priority's open item, day after day. |
| 3 | **Signals had no memory.** Nothing joined a signal with what had already been suggested about that same item. | The clearest signal of the day was the one already suggested four times and carried out four times. The validator knew; the model was never told. |
| 4 | **An inference that never lapsed.** The Coach's own "open loop" memory was shown under "respect them" indefinitely. | *"Freelance proposal document in Google Docs remains open"* (written by the Coach on day 2) was still in the prompt on day 30. |
| 5 | **A refusal with nowhere to go.** "You already did this" named no alternative. | Three identical proposals per day on the eight missed days. |

**Scenario set (22 scenarios), baseline:** 4 probe days failed under the corrected evaluator — two real misses (`01` clear open loop, `12` stated priority vs attention), two repeats. Scenario 12 exposed a sixth cause:

| 6 | **A finished step was read as a finished priority.** "Completed the practice set" three days ago made "Prepare for the midterm" read as *done*, although no time had gone to it since and the time had gone to nothing the user named. | `displaced_priority: possible` with "it may simply be done", on all three days. |

**The first live run of the fix made recall worse** (30-day 44% → 35%, scenarios 69% → 62%) and exposed three more causes, all in validation and retry:

| # | Root cause | Evidence |
| --- | --- | --- |
| 7 | **A wording refusal talked the model out of a sound target.** "…name the point the work should reach, *or return no action*" — it returned no action. | Attempt 1 proposed the right target and was refused for "Continue…" or for naming the priority; attempt 2 answered "everything is progressing". 30-day days 11, 12, 25; scenarios 08, 09, 11. |
| 8 | **A changed attempt was refused as a repeat.** After "did not help", the same item at another time of day still matched the "already carried out" rule. | Scenario 09: "Use an afternoon block to finish the recurring invoices feature" — the expected answer — refused. |
| 9 | **A kept action was lost in the retry loop.** When no attempt validated cleanly, the *last* attempt's valid subset was stored, even when an earlier one had kept an action. | Scenario 02: attempt 2 kept an action (next to an unrelated memory error), attempt 3 kept nothing; nothing was stored. |

Two further things were introduced and then removed in the same iteration because the live run showed them to be wrong: a "the very same sentence is never re-sent" rule (it refused exactly the action a three-day displacement called for), and reading early-stage work as merely "possible" (it removed the only trace of "left as a draft").

## 2. What was changed

No new pipeline, no score, no migration. The existing `signals → model → validator` path gained the explicit intermediate step it was missing: **a signal is read against the record before the model sees it.**

| Area | Change | File |
| --- | --- | --- |
| Work state | Four readings instead of three: `open` (a *statement*: "still failing", "2 drafts", "4 of 9 solved"), `underway` (early-stage work: drafting, debugging — unfinished, ranked below a statement), `stopping_point`, `unknown`. "0 failed", "no errors", "bug fixing" and a title that *starts* with "Draft …" are not open states. `wasDelivered` tells a hand-over from the end of a step. | `CoachWorkState.ts` (new) |
| Situation | A priority stands at its **main piece of work** since its last finish, not at the last thing touched (`mainItem`). The same main item on consecutive days is `carriedOver`. `elsewhereStreak`: days in a row with no time for a priority *and* most tracked time linked to no stated priority. | `CoachSituation.ts` |
| Signals | `left_off` / `carried_over` are about the main item and carry `item` and `days`. The same main item for three days without a finish is a clear pattern. A stated priority untouched for three days while the time went to nothing the user named is clear, and its only admissible answer is a question (`ask`). | `CoachOpportunities.ts` |
| Record | `withRecord`: every signal joined with what was already suggested about that same item — `on_the_list`, `postponed`, `rejected`, `acted_on`, `routine` (covered: shown to the model as *not candidates*, with the reason), `partly_helped`, `did_not_help`, `could_not_happen`, `unanswered` (kept, with the form an action may take). A signal about a priority as a whole is not used up by work on one of its items. | `CoachOpportunities.ts`, `CoachContext.ts` |
| Memory | An open loop the Coach itself inferred lapses after a week or once an action about the same thing exists; it is resolved with the day's report. What the user said never lapses. | `CoachContext.ts`, `CoachService.ts` |
| Prompt | The decision asks, in order: intended · happened · **patterns across days** · per priority what is unresolved and **what a step would change** · tried · candidate · verdict. New sections: how to read signals and the record; when an intervention is worth making, and when it is not. | `CoachPrompt.ts` (v4) |
| Validator | A record-based refusal names what else is open, or says nothing is. A wording refusal hands over the day's own words for that priority and — where the model itself read something open — says "reword, do not withdraw". After "partly worked" a refinement, and after "did not help" a changed strategy, are not repeats. A priority Reflect cannot place may only be answered with a question. | `CoachValidator.ts` |
| Retry | When no attempt validates cleanly, the attempt whose valid subset kept the most is what survives. | `ReflectionService.ts`, `ReflectionCoachHook.ts` |

Benchmark side: `opportunity precision`, `false opportunity rate`, `correctly silent days`; two false positives of "repeat" removed (same frame around different items; a step re-offered after an external constraint) and "the same … again" prohibitions checked structurally; `--diagnose`; the replay (`runner/coachReplay.ts`); per-persona scenario results.

## 3. Results

Same evaluator (v3) on both sides. "Baseline" is the stored run made before this iteration, re-scored.

**Coach scenario set — 22 scenarios, 4 personas, 7 probe days that expect silence**

| Probe days | Baseline | After |
| --- | --- | --- |
| Scenarios passed | 18 / 22 | 18 / 22 (+2 partial) |
| **Opportunity recall** | 69% (9 / 13) | **77% (10 / 13)** |
| Opportunity detection | 85% (11 / 13) | 92% (12 / 13) |
| **Opportunity precision** | 83% (10 / 12) | **92% (11 / 12)** |
| False opportunity rate | 17% (2 / 12) | 8% (1 / 12) |
| **Action precision** | 83% (10 / 12) | **92% (11 / 12)** |
| Not a repeat | 83% (10 / 12) | 92% (11 / 12) |
| **Appropriate null** | 100% (7 / 7) | **100% (7 / 7)** |
| Adaptation | 8 / 8 | 8 / 8 |
| Alignment · grounding · feasibility · not generic | 100% each | 100% each |
| Specificity | 83% | 83% |

The two "partial" scenarios are the right target with a differently-labelled kind of action ("an afternoon Focus session" where "change of timing" was expected; "address the 2 failing tests" as `change_approach` where a Focus block was expected). Counting them as answered rather than as half, 11 of the 13 strong probe days were answered.

By persona (probe days, after): student 10 / 11 scenarios, recall 80%, null 5 / 5 · founder 5 / 8, recall 60%, null 2 / 2 · researcher 2 / 2 · designer 1 / 1. Nothing in the Coach knows which persona it is looking at.

**30-day Founder/Freelancer**

| | Baseline | After |
| --- | --- | --- |
| **Opportunity recall** | 44% (10.5 / 24) | **46% (11 / 24)** |
| Fully correct | 29% (7 / 24) | 33% (8 / 24) |
| Opportunity detection | 67% (16 / 24) | 71% (17 / 24) |
| Opportunity precision | 90% (18 / 20) | 86% (18 / 21) |
| Action precision | 90% (18 / 20) | 86% (18 / 21) |
| Not a repeat | 95% | 95% |
| Concentration on one target | 45% | 38% |
| Missed (silence on a strong day) | 8 | 7 |
| Alignment · specificity · grounding · not generic | 100% each | 100% each |
| Feasibility | 100% | 90% (two 45-minute blocks where the key sees 20 minutes) |
| Adaptation | 4 / 5 | 6 / 9 (partly-refined 5 / 5, worked-reused 1 / 4) |
| Execution / outcome tracking | 100% / 100% | 100% / 100% |
| Execution supported by Reflect's own observation | 47% | 60% |

**This set did not move.** 44% → 46% is inside run-to-run variation. The target of 70% was not reached, and no claim of improvement is made for it.

## 4. Why the 30-day number did not move, and what it would take

After the change, the 19 unanswered days break down as:

| Layer | Days | Reason |
| --- | --- | --- |
| REASONING | 12 | `priority_choice` **10**, `wrong_kind_of_action` 1, `unstable_decision` 1 |
| VALIDATION | 4 | `previous_action_suppression` 2, `repeat` 1, `withdrawn_after_refusal` 1 |
| OPPORTUNITY GENERATION | 3 | `candidate_too_weak` 2, `historical_context_missing` 1 |
| DATA · PERSISTENCE | 0 | — |

The fixation is gone (the eight "proposed, refused, proposed again" days became two), and what replaced it is one thing: **on ten days the Coach acted on a real open item of a different work stream than the one the answer key calls primary.** Most score half. Eight of those ten expect *Ship the SaaS MVP* — the first-listed priority, which is also the one that reads as "progressing" most days — where the Coach chose a concrete loose end on the client or lead-generation side (often the key's own secondary action).

That is a product question, not a defect the code can settle:

1. **Is the order of stated priorities a ranking?** The prompt currently says the opposite on purpose ("the priority listed first" is named as *not* a reason to choose a candidate). If the first priority should win ties, that is a small, explainable change — and it should be the user's decision, not something inferred from one persona's answer key.
2. **Should steady work on the main priority be nudged at all?** Nine of the key's 24 "strong" days expect "continue / protect / let it run" for the SaaS. The scenario set says the opposite for the same shape of day ("already on track", "one-off displacement" expect silence). The Coach follows the scenario set.

The set itself limits what its recall can mean: 24 strong days, 6 optional, **no day on which silence is right**, a simulated user who accepts and carries out everything. Its own README says a Coach tuned to it "would learn to always say something". Reaching 70% on it requires acting on ~80% of days.

## 5. Remaining weaknesses

- **Which of several open things to choose** (above). The largest remaining lever, and a decision for the product owner.
- **The act / no-act decision is unstable on marginal days.** With only "possible" signals the same prompt gives an action on one attempt and silence on the next (30-day day 28). The first valid answer is kept by design.
- **Verbatim re-offers.** With clearer evidence an unanswered suggestion may come back in the same words (scenario 04 failed on this). Refusing it was tried and refused the right action (scenario 02). The signal's record asks for a different form; nothing enforces it.
- **Fragmentation is still weak upstream.** Scenario 05 depends on whether activity reconstruction keeps the day's pieces apart; when it merges them, nothing measures the breaking-up.
- **Specificity depends on activity summaries.** When reconstruction writes "Working on database systems assignment", the item ("the indexing section", "the failing index test") is gone before the Coach starts. Raw window titles are deliberately not shown to the Coach.
- **"Worked → reused"** passed 1 of 4 on the 30-day run (two near-repeats of a sentence, one switch of approach); 2 of 2 on the scenario set.
- **Reflection retries.** About 50 of the ~70 daily requests per 30 days are retries caused by the *reflection* half (a `change_over_time` insight without a comparison metric). They cost latency and money and re-roll nothing in the Coach, but they are the reason most days take three requests.
- **One run each.** Gemini is not deterministic; a difference of one scenario or one day is within noise.

## 6. Is it ready for real-user testing?

For a **small, observed test: yes** — on the evidence that matters for not being annoying: silence where silence is right 7 / 7, false opportunities 1 in 12, no repeat of rejected, postponed, failed or done advice, every action grounded and aligned, and rejection / "not now" / "too difficult" / external-constraint handling all holding.

It is **not** yet a Coach that reliably notices: on strong days it still says nothing, or picks the lesser of two open things, often enough that a user would see it. The honest description is *restrained and usually right when it speaks; still misses about one clear opportunity in four on the scenario set.* The next iteration should start from the priority-ranking question above, not from the prompt.

## 7. Reproducing

```bash
npm run benchmark -- --action-policy scenario
```

```bash
npm run benchmark -- --coach-scenarios
```

```bash
npm run benchmark -- --diagnose
```

The last one reads `tests/benchmark/results/latest` and writes `coach_diagnostics.md` and `coach_signals.md` there. Check free disk space first: a scenario run writes about 40 MB.
