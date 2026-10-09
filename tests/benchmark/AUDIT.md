# Benchmark v2 — state as of 2026-10-09

All six personas now run end to end with `npm run benchmark:all`. Results of the first v2 run are in `results/v2/` (`combined.md`, `combined.html`); the audit below this section describes the state BEFORE v2 and is kept for the record.

What v2 changed, and what of the older audit it supersedes:

- **3.1 profile limit** — the day-1 texts were shortened; all six onboard.
- **3.2 classification** — labels restated in the canonical vocabulary by rules in `data/keys/build.mjs` (originals kept in `label_notes`); labels the key calls uncertain stay unscored. Coverage is reported beside every accuracy.
- **3.3 stale priorities** — day files carry dated `profile_updates`, replayed through the production profile and priority calls. The daily restated `persona.priorities` remain answer-key context and still never reach Reflect.
- **3.4 coach annotations** — every persona has work streams (`persona_key.json`), stream-level targets, `action_opportunity` for every day (seven days expect silence; none for the founder) and user responses derived from the next day's ground truth.
- **Section 5, coach target matching** — by work stream: what the action names, then what it cites, then its priority. No founder vocabulary on that path.
- **Section 5, multi-persona run and report** — `all.mjs` and `tools/combined.mjs`.

Corrections to earlier statements:

- The designer's higher boundary error on days 11–30 does not come from estimated event end times: blocks and activities are compared on the same events. It comes from "purpose not observable" stretches written as separate activities. Such stretches now define no boundary.
- The developer's low activity score is not caused by its evenly spaced events. Reflect splits one stretch of work by application and interleaves the pieces; with profile replay the block names are right and the score is unchanged (45.5%). This is a product finding and stays in the score.

Still open: reflection meaning is judged by word overlap; no recommendation failed or was postponed in 180 days, so failure handling is covered only by the scenario set; classification labels for four personas are rule-derived; profile changes are authored; no Focus sessions, corrections or learned rules in any dataset.

---
# Intelligence Lab audit — six personas × 30 days

Audited 2026-10-08 against the working tree on `main` (commit `1dacff8` plus uncommitted work under `src/`).

**Verdict: all six personas now validate; one has been run.** `founder_freelancer` is a complete end-to-end benchmark. The other five pass `benchmark:validate`, but each has limits that matter before its scores are trusted: two of them contain content written during this audit (section 2), four have profile texts longer than Reflect accepts (3.1), and classification labels are only partly scorable (3.2).

```bash
npm run benchmark:validate -- --all
```

shows the state of every persona at any time.

## 1. Dataset state

`tests/benchmark/data/<persona>/reflect[_<persona>]_day_NN.json` — one self-contained file per day. There is no generator for the 30-day sets; **the day files are the source of truth**, and `data/normalize.mjs` is the one place small corrections are made.

| Persona | Validator | Raw events | Scored activities | Classification labels the evaluator can score (context / area / intent / quality) | Runnable today |
| --- | --- | --- | --- | --- | --- |
| `founder_freelancer` | 0 errors | 742 | 236 | 236 / 236 / 236 / 236 | **yes — has been run** |
| `college_student` | 0 errors | 586 | 163 (+39 off-screen) | 9 / 10 / 38 / 52 of 163 | yes — not yet run |
| `researcher` | 0 errors, 1 warning | 618 | 153 | 32 / 4 / 26 / 30 of 153 | no — profile too long (3.1) |
| `content_creator` | 0 errors, 1 warning | 761 | 311 (+150 off-screen) | 0 / 0 / 0 / 6 of 311 | no — profile too long (3.1) |
| `sofware_developer` | 0 errors, 1 warning | 699 | 176 | 64 / 0 / 65 / 55 of 176 | no — profile too long (3.1) |
| `graphic_designer` | 0 errors, 1 warning | 722 | 244 | 200 / 7 / 198 / 151 of 244 | no — profile too long (3.1) |

All six cover 2026-09-01 → 2026-09-30 at `+05:30`. The five new persona directories are untracked in git.

## 2. Content written during this audit

Two gaps could not be closed by restating what the files said. They were filled on request, and should be reviewed as authored data rather than as original dataset.

### sofware_developer day 3 — written new
The file was a byte-identical copy of day 2; the real day existed nowhere. The new day 3 (2026-09-03, events 67–97, 17 activities) is written to connect what day 2 leaves and what day 4 assumes: the billing change is finished and goes into review, a workspace API latency ticket (PLAT-482) arrives and a first repository query change is made with only local evidence, the webhook investigation stays blocked on infrastructure, and one teammate pull request is reviewed. It follows the conventions of days 1–2 (window titles, fine-grained activities, the same label vocabulary). Its persona is day 2's, unchanged.

### graphic_designer days 11–30 — converted, with invented window titles
The original files (kept in `data/graphic_designer/original_days_11_30/`) had sentence-form "events" with no end times or window titles, no ground-truth activities, colliding event ids and free-form expectations. Each day was rewritten in the day 1–10 shape from its own content:

| Field | Where it comes from |
| --- | --- |
| Event start, app | the original record |
| Event end | the original end or duration where given (days 12, 14–17); otherwise the next record's start, capped (design tools 40 min, mail / chat / reference sites 22 min) — **estimated** |
| Window title, URL | the original `window_title` where given; otherwise **derived** from the app and the project the record was labelled with (for example Figma + new identity + "presentation" → "New Brand Identity — Presentation Board"). The descriptive sentences are not used as titles: they would hand Reflect the answer. |
| Event ids | renumbered 236–722, continuing from day 10 |
| Ground-truth activities | consecutive events of one project within a stretch of continuous use; summary from the original sentences; labels in the founder vocabulary |
| Unobserved periods | gaps of 30 minutes or more, and the original offline markers |
| Expected reflection | the original observations, uncertainties and project status, under the canonical keys |
| Expected coach action | `reason` and next step are the original text; the short **title, action type and target were assigned** by reading each day's message |
| `things_not_to_do` | empty — the originals state none |

What this means for scoring: activity boundaries and coach action types on these 20 days rest on judgement made here, and repeated titles make the days somewhat easier to segment than days 1–10. Day 10's stale first priority was replaced by the one days 8–9 use.

## 3. Limits of the personas that have not been run

### 3.1 Profile texts longer than Reflect accepts
Reflect's profile form takes priorities and work items of at most 60 characters. Day 1 of `researcher` has 8 entries over that (up to 95), `content_creator` 4, `graphic_designer` 2 and `sofware_developer` 1 (63 characters). The harness refuses to onboard a persona whose profile would be silently cut, so these four cannot be run until either the day-1 texts are shortened or the limit is raised. The validator reports it as the warning `profile_over_limit`. It may also be a product finding: these are how people naturally phrase a priority.

### 3.2 Classification is mostly unscored
From roughly the second week the new personas' `context`, `intent` and `quality` hold sentences ("No desktop activity was observed.", "Understand the practical requirements and begin solving the SQL portion.") or ad-hoc phrases instead of labels. The evaluator leaves an activity out of a dimension it cannot read — it is never counted right or wrong — and `benchmark:validate` prints how many it can score (table above). For these three personas segmentation, reflection and coach are measured; classification accuracy rests on a small early slice and should not be quoted. Relabelling the activities with the founder vocabulary (Work / Leisure / Personal, the nine intents, three qualities) is what fixes it.

### 3.3 Priorities restated day by day
Four personas restate `persona.priorities` on most days, in words written with knowledge of the day. Reflect is onboarded once, with day 1; a later day's text is treated as the answer key's view of that day and never reaches Reflect (a test asserts it). The consequence: after the first few days Reflect's stated priorities are stale for these personas, so "aligned with the user's priorities" is a harder and somewhat different question than for the founder. If a persona should really change its profile mid-month, that needs an explicit dated profile update the harness replays.

### 3.4 Coach annotations
Only the founder key has `action_opportunity` and `execution_scenario`. Without them every day counts as a strong opportunity and the simulated user never answers, so recall can be read for the new personas but the lifecycle (accept → execute → outcome → adapt) cannot. No 30-day set in any persona has a day whose key expects silence.

## 4. Realism and consistency findings (unchanged)

- **Events are pre-aggregated.** No event is shorter than 4 minutes in any persona, every timestamp is on the minute, and roughly 80–95% of events start the instant the previous one ends. The sessionizer is barely exercised. This applies to the founder set too.
- **The developer set is metronomic** (351 of 700 events last exactly 23 or 24 minutes) and its engineer works every weekend at weekday load, standups included.
- `app` is the site ("Gmail") with `browser: "Chrome"`; `browser: "Discord"` on 113 events; 88 developer events have a URL and no browser.
- Researcher and developer payloads hold things a tracker cannot see (`visible_text`, `commands_visible`). The harness drops payloads, so nothing leaks.
- No dataset contains Focus sessions, user corrections or learned rules.
- Longitudinal narrative was read in full for the developer persona (coherent apart from day 3) and checked structurally for the rest.

## 5. Benchmark and evaluation

Holds up: input / answer-key separation by whitelist with a shingle tripwire on every prompt and database value (last run: 0 leaks); no future leakage by construction (one day ingested, processed, then scored); the real pipeline with versions recorded; structural evidence checks; the coach lifecycle and the 22-scenario set.

Still missing:

| Layer | State |
| --- | --- |
| Reflection semantics | lexical concept coverage, self-declared low confidence (key observations 19% on the founder run while structural checks are 100%); it cannot tell paraphrase from miss |
| Hallucination | fabricated ids, metrics and impossible numbers are caught; a false statement in prose is not; no UNSUPPORTED verdict |
| Coach target matching | work-stream matching (`KNOWN_TARGETS`, `streamOfText`) is founder vocabulary; other personas' targets are matched by wording |
| Longitudinal expectations | only in the coach scenarios |
| Multi-persona run and report | one persona per run; no combined report |

## 6. Changes made

**Data** — all through `data/normalize.mjs` (dry run by default, `--write` to apply; every text edit is checked against the same repair on the parsed JSON; idempotent). Nothing was generated: each change restates something the file already says.

| Change | Count |
| --- | --- |
| Timestamps given their date / offset written twice / wrong-date typo | 701 / 40 / 1 |
| Day section keys (`laptop` → `laptop_usage`, `day_number`, `circumstances` as a list, clock format) | researcher 26 days, developer 27 |
| Action keys (`type` → `action_type`, `estimated_time_minutes` → `suggested_focus_minutes`, absent fields as `null`) | 106 + 52 + 106 |
| Developer actions with no title: `title` copied from `target` | 54 |
| Designer persona keys (`main_work`, `initial_priorities`) | 14 |
| Activity clock restated from the events it owns | 29 |
| Unobserved period moved to start when the running event ends | 4 |
| Event given its one possible owner / removed from a second owner | 2 / 1 |
| Priority named in a shortened or padded form replaced by the stated text | 9 |
| Stray `*_duplicate_note` keys removed, `browser: null` added | 1 event |

On the 29 clocks: in all six cases where the clock and the event list implied different boundaries, the activity's own summary matched the event list (for example "looked at the current idea list" with the Notion ideas event), so the list was kept and the clock restated.

**Validator (`runner/dataset.ts`)**
- File names may carry the persona; days are checked in day order; two files for one day is an error.
- A later day may restate `current_work` / `priorities` or omit them; `id`, `type`, `role` must not change; day 1 must be whole. Alignment entries are checked against the priorities their own file states.
- `priority_alignment` entries may be a `{priority, assessment}` pair or a sentence.
- An activity may own no events only if no raw event lies inside its time; at least one activity per day must own events.
- New warning `profile_over_limit`.

**Evaluators**
- Off-screen activities are left out of segmentation and classification.
- Alignment entries naming a priority Reflect holds are scored structurally as before; sentences and unstated work streams are scored on content (`priority_statement`, lexical).
- Labels match case-insensitively; snake_case assessments are read.
- An unknown classification label is no longer an error: it is excluded and counted (`VocabularyCheck.classification`). An unknown coach action type still is.
- Twelve action types from the creator and designer keys mapped to Reflect's, with "hold off" types deliberately given no exact match.
- A coach target may be the name of the thing itself.

**Commands and tests** — `--all`, `--persona <name>`; the split test now checks answer-key field names rather than the bare word "expected" (a researcher window title says "Expected Calibration Error"), and asserts that later-day priorities never reach the input.

No production code or prompt was changed. `founder_freelancer` and `coach_scenarios` are byte-for-byte untouched.

## 7. Test results

- `npx vitest run tests/benchmark`: 74 passed, 4 skipped (the live runs).
- `npm run benchmark:validate -- --all`: 30 tests pass, all six personas valid.
- No new model run was made. Last stored founder run, `bench-20261005T104218Z-3e6792` (`gemini-3.5-flash-lite`, 485 requests, 0 failed): activity F1 69.7% (sessionizer alone 47.7%); classification by time — area 97.6%, intent 64.3%, quality 79.1% lenient; reflection structural 100%, answer-key criteria 35%; coach recognised the important issue on 42% of days; 0 leaks.

## 8. Recommended next steps

1. Decide the 60-character question (shorten the day-1 profile texts of four personas, or raise the limit), then run `npm run benchmark -- --persona college_student` as the first non-founder run.
2. Review the authored content in section 2, in particular the designer coach action types.
3. Relabel `context` / `intent` / `quality` where the evaluator cannot score them (3.2).
4. Add `action_opportunity` / `execution_scenario` annotations, and some days that call for silence, to the new personas.
5. Replace lexical reflection scoring with a rubric judge that stores model, prompt and raw output.
