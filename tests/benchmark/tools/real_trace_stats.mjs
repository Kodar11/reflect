#!/usr/bin/env node
// Aggregate-only statistics of real tracking behaviour, read from a Reflect database.
//
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron tests/benchmark/tools/real_trace_stats.mjs --db <path to productivity-coach.db>
//
//   --db <file>            the database to read (required; a COPY of the live file is the safest thing to pass)
//   --since-days <n>       only the most recent n days that have events (default: all)
//   --min-day-minutes <n>  a day with less tracked time than this is left out of the per-day figures (default 30)
//   --out <file>           also write the JSON there
//
// What it guarantees:
//   - the database is opened read-only and with `query_only`; nothing is written to it;
//   - one query is run against `events` (and one against `tracking_pauses`), and every row is reduced to numbers
//     in memory: durations, gaps, and whether two neighbouring rows have the same app / title / domain;
//   - NOTHING that was tracked is printed: no window title, no URL or domain, no application name, no date and no
//     clock time. Applications appear only as anonymous ranks ("the most used app holds 31% of the time").
//
// Hidden events (`hidden_at`) are left out, as they are everywhere else in Reflect.
// It runs under Electron's Node because that is the runtime the SQLite binding is built for (as `npm run test:db`).

import fs from 'node:fs';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dbPath = arg('--db');
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('Pass --db <path to a Reflect database>. Nothing was read.');
  process.exit(1);
}
const sinceDays = arg('--since-days') ? Number(arg('--since-days')) : null;
const minDayMinutes = Number(arg('--min-day-minutes', '30'));

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
const hasTable = (table) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
const visible = hasColumn('events', 'hidden_at') ? 'WHERE hidden_at IS NULL' : '';
const rows = db.prepare(`SELECT watcher, started_at, ended_at, app, browser, title, url FROM events ${visible} ORDER BY started_at ASC, id ASC`).all();
const pauses = hasTable('tracking_pauses') ? db.prepare('SELECT started_at, ended_at FROM tracking_pauses').all() : null;
db.close();

// ── Helpers: numbers only ───────────────────────────────────────────────────

const round = (x, digits = 1) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null);
const share = (n, d) => (d > 0 ? round((100 * n) / d, 1) : null);
const QUANTILES = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
function quantiles(values, digits = 1) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const out = { n: sorted.length };
  for (const q of QUANTILES) out[`p${Math.round(q * 100)}`] = round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))], digits);
  out.mean = round(sorted.reduce((s, v) => s + v, 0) / sorted.length, digits);
  return out;
}
/** Counts (and optionally summed weight) per bucket; `edges` are upper bounds in the unit of the values. */
function histogram(values, edges, labels, weights = null) {
  const count = new Array(labels.length).fill(0);
  const weight = new Array(labels.length).fill(0);
  values.forEach((v, i) => {
    let b = edges.findIndex((edge) => v < edge);
    if (b < 0) b = labels.length - 1;
    count[b]++;
    if (weights) weight[b] += weights[i];
  });
  const totalWeight = weight.reduce((s, v) => s + v, 0);
  return Object.fromEntries(
    labels.map((label, i) => [label, weights ? { share_of_rows_pct: share(count[i], values.length), share_of_time_pct: share(weight[i], totalWeight) } : { share_pct: share(count[i], values.length) }]),
  );
}
const DURATION_EDGES = [0.001, 1, 2, 5, 10, 30, 60, 120, 300, 900, 1800, 3600, Infinity];
const DURATION_LABELS = ['0', '<1s', '1-2s', '2-5s', '5-10s', '10-30s', '30-60s', '1-2min', '2-5min', '5-15min', '15-30min', '30-60min', '>=60min'];
const GAP_EDGES = [0.001, 1, 5, 30, 300, 900, 1800, 3600, 14400, Infinity];
const GAP_LABELS = ['exactly 0', '<1s', '1-5s', '5-30s', '30s-5min', '5-15min', '15-30min', '30-60min', '1-4h', '>=4h'];
const BROWSER_PROCESS = /chrome|chromium|edge|firefox|brave|opera|vivaldi|arc/i;

// ── Rows → numeric records. Text is used only to compare neighbours and is dropped here. ────────────────────────

const events = [];
for (const r of rows) {
  const start = Date.parse(r.started_at);
  const end = Date.parse(r.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end)) continue;
  const local = new Date(start);
  events.push({
    start,
    end,
    seconds: Math.max(0, (end - start) / 1000),
    day: `${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`, // grouping key only; never printed
    watcher: r.watcher,
    app: r.app ?? '',
    title: r.title ?? '',
    url: r.url ?? '',
    hasBrowser: r.browser != null && r.browser !== '',
    browserProcess: BROWSER_PROCESS.test(r.app ?? ''),
    subSecondStart: start % 1000 !== 0,
    wholeMinuteStart: start % 60000 === 0,
  });
}
let dayKeys = [...new Set(events.map((e) => e.day))];
if (sinceDays !== null) dayKeys = dayKeys.slice(-sinceDays);
const keep = new Set(dayKeys);
const ev = events.filter((e) => keep.has(e.day));
if (ev.length === 0) {
  console.error('The database holds no visible events in the requested range.');
  process.exit(1);
}

// ── Per event ───────────────────────────────────────────────────────────────

const seconds = ev.map((e) => e.seconds);
const trackedSeconds = seconds.reduce((s, v) => s + v, 0);

// ── Neighbouring events ─────────────────────────────────────────────────────

/** Two rows are "contiguous" when the second starts within this many seconds of the first ending. */
const CONTIGUOUS_S = 5;
const gaps = [];
const longGapsByDay = new Map();
let overlaps = 0;
const change = { app_changed: 0, same_app_title_changed: 0, same_app_same_title_domain_changed: 0, nothing_changed: 0 };
let contiguousPairs = 0;
for (let i = 1; i < ev.length; i++) {
  const gap = (ev[i].start - ev[i - 1].end) / 1000;
  if (gap < 0) overlaps++;
  gaps.push(Math.max(0, gap));
  if (gap >= 300 && ev[i].day === ev[i - 1].day) longGapsByDay.set(ev[i].day, (longGapsByDay.get(ev[i].day) ?? 0) + 1);
  if (gap > CONTIGUOUS_S) continue;
  contiguousPairs++;
  if (ev[i].app !== ev[i - 1].app) change.app_changed++;
  else if (ev[i].title !== ev[i - 1].title) change.same_app_title_changed++;
  else if (ev[i].url !== ev[i - 1].url) change.same_app_same_title_domain_changed++;
  else change.nothing_changed++;
}

// ── Application visits: a maximal run of contiguous rows in one application ─

const visits = [];
for (let i = 0; i < ev.length; i++) {
  const last = visits[visits.length - 1];
  const contiguous = i > 0 && (ev[i].start - ev[i - 1].end) / 1000 <= CONTIGUOUS_S;
  if (last && contiguous && last.app === ev[i].app) {
    last.seconds += ev[i].seconds;
    last.rows++;
    last.end = ev[i].end;
  } else {
    visits.push({ app: ev[i].app, seconds: ev[i].seconds, rows: 1, start: ev[i].start, end: ev[i].end, day: ev[i].day, afterGap: !contiguous, browser: ev[i].browserProcess || ev[i].hasBrowser });
  }
}
// A "return": application A, then B, then A again, with no break in observation on either side of B.
const returnDetourSeconds = [];
let middleVisits = 0;
for (let i = 1; i < visits.length - 1; i++) {
  if (visits[i].afterGap || visits[i + 1].afterGap) continue;
  middleVisits++;
  if (visits[i - 1].app === visits[i + 1].app) returnDetourSeconds.push(visits[i].seconds);
}
const visitSeconds = visits.map((v) => v.seconds);

// ── Per day ─────────────────────────────────────────────────────────────────

const byDay = new Map();
for (const e of ev) {
  const d = byDay.get(e.day) ?? { events: 0, seconds: 0, apps: new Set(), domains: new Set(), first: e.start, last: e.end };
  d.events++;
  d.seconds += e.seconds;
  d.apps.add(e.app);
  if (e.url) d.domains.add(e.url);
  d.last = Math.max(d.last, e.end);
  byDay.set(e.day, d);
}
const visitsByDay = new Map();
for (const v of visits) visitsByDay.set(v.day, (visitsByDay.get(v.day) ?? 0) + 1);
const days = [...byDay.entries()].map(([key, d]) => ({ ...d, visits: visitsByDay.get(key) ?? 0 })).filter((d) => d.seconds >= minDayMinutes * 60);

// ── Applications, as anonymous ranks ────────────────────────────────────────

const perApp = new Map();
for (const e of ev) perApp.set(e.app, (perApp.get(e.app) ?? 0) + e.seconds);
const ranked = [...perApp.values()].sort((a, b) => b - a);
const topShare = (n) => share(ranked.slice(0, n).reduce((s, v) => s + v, 0), trackedSeconds);

// ── Titles: shape only ──────────────────────────────────────────────────────

const titled = ev.filter((e) => e.title !== '');

// ── Report ──────────────────────────────────────────────────────────────────

const browserRows = ev.filter((e) => e.browserProcess || e.hasBrowser);
const report = {
  about: 'Aggregate statistics only. No title, URL, domain, application name, date or clock time is included.',
  scope: {
    events: ev.length,
    days_with_events: dayKeys.length,
    days_in_per_day_figures: days.length,
    tracked_hours_total: round(trackedSeconds / 3600, 0),
    watchers_seen: new Set(ev.map((e) => e.watcher)).size,
    sample_warning: dayKeys.length < 5 || ev.length < 2000 ? 'small sample: treat every figure as indicative' : null,
  },
  timestamp_precision: {
    starts_with_sub_second_part_pct: share(ev.filter((e) => e.subSecondStart).length, ev.length),
    starts_on_a_whole_minute_pct: share(ev.filter((e) => e.wholeMinuteStart).length, ev.length),
    zero_length_events_pct: share(ev.filter((e) => e.seconds === 0).length, ev.length),
    overlapping_neighbours: overlaps,
  },
  event_duration_seconds: {
    quantiles: quantiles(seconds),
    histogram: histogram(seconds, DURATION_EDGES, DURATION_LABELS, seconds),
    shorter_than_1s_pct: share(seconds.filter((s) => s < 1).length, ev.length), // what the activity preprocessor drops
  },
  per_day: {
    events: quantiles(days.map((d) => d.events), 0),
    tracked_hours: quantiles(days.map((d) => d.seconds / 3600)),
    events_per_tracked_hour: quantiles(days.map((d) => d.events / (d.seconds / 3600))),
    app_visits_per_tracked_hour: quantiles(days.map((d) => d.visits / (d.seconds / 3600))),
    first_to_last_span_hours: quantiles(days.map((d) => (d.last - d.first) / 3_600_000)),
    distinct_apps: quantiles(days.map((d) => d.apps.size), 0),
    distinct_domains: quantiles(days.map((d) => d.domains.size), 0),
  },
  gaps_between_neighbouring_events_seconds: {
    histogram: histogram(gaps, GAP_EDGES, GAP_LABELS),
    per_day_gaps_of_5min_or_more: quantiles([...byDay.keys()].map((key) => longGapsByDay.get(key) ?? 0), 0),
  },
  transitions_between_contiguous_events: {
    pairs: contiguousPairs,
    app_changed_pct: share(change.app_changed, contiguousPairs),
    same_app_title_changed_pct: share(change.same_app_title_changed, contiguousPairs),
    same_app_same_title_domain_changed_pct: share(change.same_app_same_title_domain_changed, contiguousPairs),
    nothing_changed_pct: share(change.nothing_changed, contiguousPairs),
  },
  app_visits: {
    visits: visits.length,
    duration_seconds: quantiles(visitSeconds),
    duration_histogram: histogram(visitSeconds, DURATION_EDGES, DURATION_LABELS, visitSeconds),
    events_per_visit: quantiles(visits.map((v) => v.rows), 0),
    shorter_than_5s_pct: share(visitSeconds.filter((s) => s < 5).length, visits.length),
    shorter_than_15s_pct: share(visitSeconds.filter((s) => s < 15).length, visits.length),
    shorter_than_60s_pct: share(visitSeconds.filter((s) => s < 60).length, visits.length),
  },
  returns: {
    visits_between_two_others_without_a_break: middleVisits,
    of_which_previous_and_next_app_are_the_same_pct: share(returnDetourSeconds.length, middleVisits),
    detour_duration_seconds: quantiles(returnDetourSeconds),
    detour_shorter_than_10s_pct: share(returnDetourSeconds.filter((s) => s < 10).length, returnDetourSeconds.length),
    detour_shorter_than_60s_pct: share(returnDetourSeconds.filter((s) => s < 60).length, returnDetourSeconds.length),
    detour_shorter_than_2min_pct: share(returnDetourSeconds.filter((s) => s < 120).length, returnDetourSeconds.length),
  },
  browser: {
    rows_in_a_browser_pct: share(browserRows.length, ev.length),
    time_in_a_browser_pct: share(browserRows.reduce((s, e) => s + e.seconds, 0), trackedSeconds),
    browser_rows_with_a_domain_pct: share(browserRows.filter((e) => e.url !== '').length, browserRows.length),
    browser_rows_with_the_browser_field_set_pct: share(browserRows.filter((e) => e.hasBrowser).length, browserRows.length),
  },
  applications_as_anonymous_ranks: {
    distinct_apps: perApp.size,
    time_share_of_most_used_app_pct: topShare(1),
    time_share_of_top_3_pct: topShare(3),
    time_share_of_top_5_pct: topShare(5),
    time_share_of_top_10_pct: topShare(10),
  },
  title_shape: {
    rows_without_a_title_pct: share(ev.length - titled.length, ev.length),
    length_characters: quantiles(titled.map((e) => e.title.length), 0),
    starts_with_an_unread_counter_pct: share(titled.filter((e) => /^\(\d+\+?\)\s/.test(e.title)).length, titled.length),
    starts_with_an_unsaved_marker_pct: share(titled.filter((e) => /^[●•*]\s/.test(e.title)).length, titled.length),
    distinct_titles_per_100_events: round((100 * new Set(titled.map((e) => e.title)).size) / Math.max(1, titled.length), 1),
  },
  long_unchanged_windows: {
    note: 'One window in front for a long time. The schema cannot tell reading or watching from being away from the machine.',
    time_in_events_of_15min_or_more_pct: share(seconds.filter((s) => s >= 900).reduce((s, v) => s + v, 0), trackedSeconds),
    time_in_events_of_30min_or_more_pct: share(seconds.filter((s) => s >= 1800).reduce((s, v) => s + v, 0), trackedSeconds),
  },
  tracking_pauses:
    pauses === null
      ? 'no tracking_pauses table in this database'
      : { count: pauses.length, duration_minutes: quantiles(pauses.map((p) => (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000).filter(Number.isFinite)) },
  not_derivable_from_this_schema: [
    'idle / away-from-keyboard time: no input-idle signal is stored; an idle screen extends the foreground event',
    'why a gap happened: sleep, lock, the app not running and a crash all look the same (a paused period is the one exception)',
    'browser tabs: which tab, how many are open, background tabs and other windows are never recorded',
    'pages within a site: only the host is stored, so navigation inside one site shows only as a title change',
    'visits shorter than the 1-second poll, and how many polls an event was built from',
    'whether a title change was the user acting or the page / program changing it by itself',
    'what the user was doing or meant to do: there are no task labels in raw events',
  ],
};

const text = JSON.stringify(report, null, 2);
if (arg('--out')) fs.writeFileSync(arg('--out'), `${text}\n`);
console.log(text);
