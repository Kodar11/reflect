#!/usr/bin/env node
// Coach scenario set — twenty-two small, multi-day datasets, each built to ask
// the Coach one question (is there an open loop? should it stay silent? which
// of three priorities holds the next move? does it adapt after a failure?).
// Four personas, and as many days that call for silence as for a particular
// kind of action. Same file format as the 30-day dataset, so they run
// through the same harness and therefore the same production path:
//
//   raw events → activity reconstruction → reflection + coach (one request)
//     → validation → coach_actions → simulated user → next day's coach pass
//
// The raw events carry only what a tracker would see (app, window title, URL).
// Everything that says what the day MEANT — ground truth, the opportunity, the
// user's decision and what followed — lives in the answer-key sections.
//
//   node tests/benchmark/data/coach_scenarios/generate.mjs
//
// The generated directories are checked in; this script is how to change them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OFFSET = '+05:30';

// ── Personas ────────────────────────────────────────────────────────────────

const ASSIGNMENT = 'Finish the database systems assignment';
const MIDTERM = 'Prepare for the algorithms midterm';
const STUDENT = {
  id: 'cs_student_01',
  type: 'student',
  role: 'Third-year computer science student',
  current_work: ['Database systems course', 'Algorithms course'],
  priorities: [ASSIGNMENT, MIDTERM],
};

const SAAS = 'Ship the invoicing SaaS beta';
const CLIENT = 'Deliver the retainer client work';
const FOUNDER = {
  id: 'solo_founder_02',
  type: 'founder',
  role: 'Solo founder building a small invoicing SaaS alongside one retainer client',
  current_work: ['Building an invoicing SaaS', 'One retainer client portal'],
  priorities: [SAAS, CLIENT],
};

const GRANT = 'Finish the grant application';
const NEWSLETTER = 'Publish the weekly newsletter';
const WRITER = {
  id: 'researcher_01',
  type: 'researcher',
  role: 'Independent researcher and writer',
  current_work: ['A grant application for a field study', 'A weekly newsletter'],
  priorities: [GRANT, NEWSLETTER],
};

const BRAND = 'Deliver the bakery brand guidelines';
const PORTFOLIO = 'Update the portfolio site';
const INVOICES = "Send this month's client invoices";
const DESIGNER = {
  id: 'freelance_designer_01',
  type: 'designer',
  role: 'Freelance brand and web designer',
  current_work: ['Brand guidelines for a bakery client', 'Own portfolio site', 'Monthly invoicing'],
  priorities: [BRAND, PORTFOLIO, INVOICES],
};

// ── Windows (what the tracker sees) ─────────────────────────────────────────

const code = (file, project) => ({ app: 'Code', browser: null, title: `${file} — ${project} — Visual Studio Code`, url: null });
const term = (title) => ({ app: 'WindowsTerminal', browser: null, title, url: null });
const web = (title, url) => ({ app: 'Chrome', browser: 'Chrome', title, url });
const app = (name, title) => ({ app: name, browser: null, title, url: null });

// ── Blocks ──────────────────────────────────────────────────────────────────

/** One ground-truth activity: a stretch of the day, the windows it moved between, and what it really was. */
const block = (at, minutes, title, summary, labels, windows, slice = 20) => ({ at, minutes, title, summary, labels, windows, slice });

const work = (area, intent = 'Create', quality = 'Focused', importance = 'high') => ({ context: 'Work', area, intent, quality, importance });
const leisure = { context: 'Leisure', area: null, intent: 'Consume', quality: 'Break-Idle', importance: 'low' };

// Student
const assignmentWriting = (at, min, section) =>
  block(at, min, `Drafting the ${section} section`, `Wrote and revised the ${section} section of the database assignment; it was still a draft when the block ended.`, work(ASSIGNMENT), [
    code(`${section.replace(/\s+/g, '_')}.sql`, 'db-assignment-3'),
    web('PostgreSQL: Documentation: 11. Indexes', 'https://www.postgresql.org/docs/current/indexes.html'),
    web(`Assignment 3 report — ${section} (DRAFT) — Google Docs`, 'https://docs.google.com/document/d/a3report'),
  ]);
const assignmentDebugging = (at, min) =>
  block(at, min, 'Debugging the failing index test', 'Ran the assignment test suite repeatedly; the composite-index test was still failing at the end.', work(ASSIGNMENT), [
    term('pytest tests/test_indexes.py — 1 failed, 6 passed — db-assignment-3'),
    code('test_indexes.py', 'db-assignment-3'),
    web('python - EXPLAIN shows Seq Scan instead of Index Scan - Stack Overflow', 'https://stackoverflow.com/questions/index-scan'),
  ]);
const assignmentSubmit = (at, min, what = 'Assignment 3') =>
  block(at, min, `Submitting ${what}`, `Ran the full test suite (all passing), exported the report and submitted ${what} on the course site.`, work(ASSIGNMENT, 'Complete', 'Routine'), [
    term('pytest — 7 passed — db-assignment-3'),
    web(`${what}: Query Optimization — Submitted — Course LMS`, 'https://lms.university.example/courses/db/assignments/3'),
  ], 15);
const midtermStudy = (at, min, topic, done = false) =>
  block(
    at,
    min,
    done ? `Completed ${topic} practice set` : `${topic} practice set, part-way`,
    done ? `Finished every problem in the ${topic} practice set and checked the answers.` : `Worked through part of the ${topic} practice set; several problems were still unattempted.`,
    work(MIDTERM, 'Learn'),
    [
      web(done ? `Practice Set — ${topic} — 9 of 9 solved — Completed — Algorithms` : `Practice Set — ${topic} — 4 of 9 solved — In progress — Algorithms`, 'https://lms.university.example/courses/algo/practice'),
      app('Obsidian', `Algorithms midterm notes — ${topic} — Obsidian`),
      web(`Lecture — ${topic}.pdf`, 'https://lms.university.example/courses/algo/lectures'),
    ],
  );
const gaming = (at, min) => block(at, min, 'Playing a game', 'Played a game in the evening.', leisure, [app('Hades', 'Hades')], 30);
const video = (at, min) =>
  block(at, min, 'Watching videos', 'Watched entertainment videos.', leisure, [web('Best speedruns of the year - YouTube', 'https://www.youtube.com/watch?v=speedruns')], 30);
const modding = (at, min) =>
  block(at, min, 'Hobby game mod', 'Built and tested a hobby mod for a game — a personal side project, not coursework.', { context: 'Leisure', area: null, intent: 'Create', quality: 'Focused', importance: 'low' }, [
    app('Godot', 'tile_shader.gdshader — cavern-mod — Godot Engine'),
    web('Shaders — Godot Engine documentation', 'https://docs.godotengine.org/en/stable/tutorials/shaders/'),
    app('Godot', 'cavern-mod (DEBUG) — Godot Engine'),
  ]);

// Founder
const saasBuilding = (at, min, feature) =>
  block(at, min, `Implementing ${feature}`, `Implemented part of ${feature} in the invoicing SaaS and ran it locally; tests were still failing and the pull request was still a draft.`, work(SAAS), [
    code(`${feature.replace(/\s+/g, '-')}.tsx`, 'invoicely'),
    web('localhost:3000/invoices/new', 'http://localhost:3000/invoices/new'),
    term('npm test — 2 failed, 31 passed — invoicely'),
    web(`Draft: ${feature} · Pull Request #41 · invoicely`, 'https://github.com/founder/invoicely/pull/41'),
  ]);
const saasShipped = (at, min, feature) =>
  block(at, min, `Shipping ${feature}`, `${feature}: finished; its pull request went in and the production deploy went out.`, work(SAAS, 'Complete'), [
    code(`${feature.replace(/\s+/g, '-')}.tsx`, 'invoicely'),
    web(`Merged: ${feature} by founder · Pull Request #41 · invoicely`, 'https://github.com/founder/invoicely/pull/41'),
    web('Deployment completed — invoicely — Vercel', 'https://vercel.com/founder/invoicely/deployments'),
  ]);
const clientWork = (at, min, what) =>
  block(at, min, `Client work: ${what}`, `Worked on ${what} for the client portal and checked it on staging.`, work(CLIENT), [
    code(`${what.replace(/\s+/g, '-')}.ts`, 'acme-portal'),
    web('Acme Portal (staging)', 'https://staging.acme-portal.example/reports'),
    app('Slack', 'Acme — #portal-support — Slack'),
  ]);
const clientDelivered = (at, min, what) =>
  block(at, min, `Delivering ${what}`, `Finished ${what}, deployed it to the client portal and sent the weekly update.`, work(CLIENT, 'Complete'), [
    code(`${what.replace(/\s+/g, '-')}.ts`, 'acme-portal'),
    web('Deployed to production — acme-portal — Render', 'https://dashboard.render.com/acme-portal'),
    web('Sent: Weekly update — Acme portal — Gmail', 'https://mail.google.com/mail/u/0/#sent'),
  ]);
const clientIncident = (at, min) =>
  block(at, min, 'Client production outage', 'The client portal was down; investigated, patched and monitored it for most of the day.', work(CLIENT, 'Manage'), [
    app('Slack', 'Acme — #incident-portal-down — Slack'),
    web('Incident: Portal unavailable — Acme Status', 'https://status.acme-portal.example/incidents/1042'),
    code('db-pool.ts', 'acme-portal'),
    term('kubectl logs portal-api — acme-prod'),
  ]);

// Writer — both priorities live in the same application
const grantDrafting = (at, min, section) =>
  block(at, min, `Drafting grant ${section}`, `Wrote part of the ${section}; it still had open comments and unfinished paragraphs.`, work(GRANT), [
    web(`Grant application — ${section} (draft, 3 open comments) — Google Docs`, 'https://docs.google.com/document/d/grant'),
    web('Field Study Fund — Application guidelines', 'https://fund.example.org/guidelines'),
  ]);
const newsletterDrafting = (at, min, issue) =>
  block(at, min, `Drafting newsletter ${issue}`, `Wrote the draft of newsletter issue ${issue}.`, work(NEWSLETTER), [
    web(`Newsletter #${issue} draft — Google Docs`, 'https://docs.google.com/document/d/newsletter'),
  ]);
const newsletterPublished = (at, min, issue) =>
  block(at, min, `Publishing newsletter ${issue}`, `Finalised issue ${issue} and published it to subscribers.`, work(NEWSLETTER, 'Complete', 'Routine'), [
    web(`Newsletter #${issue} draft — Google Docs`, 'https://docs.google.com/document/d/newsletter'),
    web(`Published — Newsletter #${issue} — Substack`, 'https://writer.substack.com/publish/post/48'),
  ], 15);

// Designer — three priorities of very different size
const brandWork = (at, min, part) =>
  block(at, min, `Designing brand ${part}`, `Worked on the ${part} pages of the bakery brand guidelines.`, work(BRAND), [
    app('Figma', `Bakery brand guidelines — ${part} — Figma`),
    web('Bakery moodboard — Pinterest', 'https://www.pinterest.com/designer/bakery-moodboard/'),
  ]);
const brandDelivered = (at, min) =>
  block(at, min, 'Delivering the brand guidelines', 'Exported the guidelines as a PDF and emailed them to the bakery client.', work(BRAND, 'Complete', 'Routine'), [
    app('Figma', 'Bakery brand guidelines — Export PDF — Figma'),
    web('Sent: Brand guidelines v1 (PDF attached) — Gmail', 'https://mail.google.com/mail/u/0/#sent'),
  ], 15);
const portfolioWork = (at, min, what) =>
  block(at, min, `Portfolio site: ${what}`, `Edited the ${what} of the portfolio site and previewed it locally.`, work(PORTFOLIO, 'Create', 'Focused', 'medium'), [
    code(`${what.replace(/\s+/g, '-')}.astro`, 'portfolio'),
    web('localhost:4321/work', 'http://localhost:4321/work'),
  ]);
const invoicesDrafted = (at, min) =>
  block(at, min, 'Drafting monthly invoices', 'Prepared two of the five client invoices; none had gone out when the block ended.', work(INVOICES, 'Manage', 'Routine'), [
    web('Invoices — 2 drafts, 0 sent, 3 clients not invoiced — FreshBooks', 'https://my.freshbooks.com/#/invoices'),
    app('Excel', 'Hours October.xlsx — Excel'),
  ], 12);
const incidentClosed = (at, min) =>
  block(at, min, 'Closing the client incident', 'Saw the portal stay stable, posted the resolution note and closed the incident.', work(CLIENT, 'Complete', 'Routine'), [
    web('Resolved: Portal unavailable — Acme Status', 'https://status.acme-portal.example/incidents/1042'),
    app('Slack', 'Acme — #incident-portal-down — resolved — Slack'),
  ], 15);

// ── Answer-key helpers ──────────────────────────────────────────────────────

/**
 * History, not answer key: a recommendation that was on the Coach panel since
 * the evening before the day it is attached to, and what the user did with it.
 * `action_type` is one of Reflect's own action types.
 */
const seed = (title, action_type, daypart, focus_minutes, priority, user_decision, execution = 'not_applicable', outcome = 'not_applicable', reason_code = null) => ({
  title,
  action_type,
  daypart,
  focus_minutes,
  priority,
  user_decision,
  execution,
  outcome,
  reason_code,
});

const action = (title, action_type, target, reason, minutes = null) => ({ title, action_type, reason, suggested_focus_minutes: minutes, target });

/** An ordinary day inside a scenario: carrying on is fine to say and fine to leave unsaid. */
const ordinary = (priority) => ({
  primary: action(`Carry on with: ${priority}`, 'continue_successful_behavior', priority, 'Work is moving normally; continuing it is the natural step and needs no intervention.'),
  strength: 'moderate',
  reason: 'An ordinary day inside the scenario: an action is optional.',
});

const scenarios = [];
const scenario = (id, title, tests, persona, days) => scenarios.push({ id, title, tests, persona, days });

// ── 1. Clear open loop ──────────────────────────────────────────────────────
scenario('01_clear_open_loop', 'Clear open loop', 'A task was started and visibly left mid-way → an action should be generated.', STUDENT, [
  { blocks: [assignmentSubmit('10:00', 30, 'Assignment 2'), midtermStudy('11:00', 60, 'Dynamic Programming', true), gaming('20:00', 60)], coach: ordinary(MIDTERM) },
  {
    probe: true,
    blocks: [assignmentWriting('09:30', 80, 'indexing'), assignmentDebugging('11:00', 45), midtermStudy('14:00', 40, 'Graph Algorithms', true), gaming('19:30', 60)],
    coach: {
      primary: action('Finish the indexing section and get the failing index test passing', 'complete_open_loop', ASSIGNMENT, 'The indexing section was drafted and its test was still failing when work stopped.', 60),
      strength: 'strong',
      scenario: { user_decision: 'accepted', execution: 'done', outcome: 'worked', reason: 'The next day the test passes and the assignment is submitted.' },
      not: ['Do not criticize the evening spent playing a game.'],
    },
  },
  { blocks: [assignmentDebugging('09:30', 40), assignmentSubmit('10:15', 30), midtermStudy('14:00', 70, 'Greedy Algorithms'), video('20:00', 40)], coach: ordinary(MIDTERM) },
]);

// ── 2. Important priority repeatedly displaced ──────────────────────────────
scenario('02_priority_repeatedly_displaced', 'Priority repeatedly displaced', 'A stated priority gets no time for several days running → an action should be generated.', FOUNDER, [
  { blocks: [saasBuilding('09:00', 150, 'recurring invoices'), clientDelivered('13:30', 90, 'the CSV export')], coach: ordinary(SAAS) },
  { blocks: [clientWork('09:00', 170, 'the audit report'), clientWork('13:30', 130, 'the audit report filters')], coach: { ...ordinary(SAAS), reason: 'One day without product time is not yet a pattern.' } },
  {
    blocks: [clientWork('09:00', 180, 'the audit report filters'), clientWork('13:30', 140, 'the role permissions screen')],
    coach: { primary: action('Protect a block for the invoicing SaaS', 'protect_priority', SAAS, 'The product priority has had no time for two days while client work filled both.', 90), strength: 'strong' },
  },
  {
    probe: true,
    blocks: [clientWork('09:00', 160, 'the role permissions screen'), clientDelivered('13:30', 120, 'the role permissions screen')],
    coach: {
      primary: action('Protect a block for the invoicing SaaS before client work starts', 'protect_priority', SAAS, 'The product priority has now had no time for three days running; recurring invoices was left unfinished.', 90),
      strength: 'strong',
      not: ['Do not recommend extending the workday to make up for the missing product time.'],
    },
  },
]);

// ── 3. Strong momentum worth protecting ─────────────────────────────────────
scenario('03_momentum_worth_protecting', 'Momentum worth protecting', 'Sustained daily progress on one priority → a continuation / protection action should be possible, never required.', STUDENT, [
  { blocks: [assignmentSubmit('09:30', 30), midtermStudy('10:30', 150, 'Dynamic Programming', true)], coach: ordinary(MIDTERM) },
  { blocks: [midtermStudy('09:30', 170, 'Graph Algorithms', true), video('20:00', 40)], coach: ordinary(MIDTERM) },
  {
    probe: true,
    blocks: [midtermStudy('09:30', 180, 'Network Flow'), gaming('20:00', 45)],
    coach: {
      primary: action('Finish the Network Flow practice set in tomorrow morning\'s study block', 'start_focus', MIDTERM, 'Three days of long morning study blocks, and today\'s practice set was left part-way through.', 90),
      strength: 'moderate',
      reason: 'Steady momentum with one set part-way through: continuing is useful to say and fine to leave unsaid.',
    },
  },
]);

// ── 4. Approaching deadline ─────────────────────────────────────────────────
scenario('04_approaching_deadline', 'Approaching deadline', 'A visible deadline tomorrow with the work half done → a concrete, timely action.', STUDENT, [
  { blocks: [assignmentWriting('10:00', 60, 'query plan analysis'), midtermStudy('14:00', 80, 'Dynamic Programming', true)], coach: ordinary(ASSIGNMENT) },
  {
    probe: true,
    blocks: [
      block('09:30', 10, 'Checking the assignment deadline', 'Opened the course site and looked at the assignment page, which shows the deadline.', work(ASSIGNMENT, 'Plan', 'Routine', 'medium'), [
        web('Assignment 3: Query Optimization — Due tomorrow 23:59 — Not submitted — Course LMS', 'https://lms.university.example/courses/db/assignments/3'),
      ]),
      assignmentWriting('09:40', 50, 'query plan analysis'),
      midtermStudy('11:00', 120, 'Graph Algorithms', true),
      gaming('20:00', 60),
    ],
    coach: {
      primary: action('Finish the query plan analysis and submit the assignment tomorrow', 'complete_open_loop', ASSIGNMENT, 'The assignment is due tomorrow night, is not submitted, and its analysis section is still a draft.', 90),
      strength: 'strong',
      not: ['Do not criticize the time spent on midterm preparation or on the game.'],
    },
  },
]);

// ── 5. Fragmented day with an actionable pattern ────────────────────────────
const fragmentedDay = () => {
  const out = [];
  const pieces = [
    () => block('', 10, 'Replying in the client support channel', 'Answered client messages.', work(CLIENT, 'Communicate', 'Routine', 'medium'), [app('Slack', 'Acme — #portal-support — Slack')], 10),
    () => block('', 12, 'Short stretch on recurring invoices', 'Picked up the recurring-invoices code briefly before being pulled away.', work(SAAS), [code('recurring-invoices.tsx', 'invoicely')], 12),
    () => block('', 8, 'Checking email', 'Read and triaged email.', work(CLIENT, 'Communicate', 'Routine', 'low'), [web('Inbox (14) — Gmail', 'https://mail.google.com/mail/u/0/#inbox')], 8),
    () => block('', 11, 'Short stretch on the client audit report', 'Touched the audit report code briefly.', work(CLIENT), [code('audit-report.ts', 'acme-portal')], 11),
  ];
  let minutes = 9 * 60;
  for (let i = 0; i < 32; i++) {
    const b = pieces[i % pieces.length]();
    b.at = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    out.push(b);
    minutes += b.minutes + (i === 15 ? 55 : 0);
  }
  return out;
};
scenario('05_fragmented_day', 'Fragmented day with an actionable pattern', 'Switching far above this user\'s own norm → reduce_fragmentation or a scheduling action.', FOUNDER, [
  { blocks: [saasShipped('09:00', 150, 'invoice templates'), clientDelivered('13:30', 110, 'the CSV export')], coach: ordinary(SAAS) },
  { blocks: [saasBuilding('09:00', 160, 'recurring invoices'), clientDelivered('13:30', 100, 'the audit report')], coach: ordinary(SAAS) },
  { blocks: [saasBuilding('09:00', 150, 'recurring invoices'), clientDelivered('13:30', 120, 'the audit report filters')], coach: ordinary(SAAS) },
  {
    probe: true,
    blocks: fragmentedDay(),
    coach: {
      primary: action('Keep one uninterrupted block for recurring invoices before opening Slack and email', 'reduce_fragmentation', null, 'The day broke into ten-minute pieces between chat, email and two codebases; earlier days held long blocks.', 90),
      secondary: action('Protect a block for the invoicing SaaS', 'protect_priority', SAAS, 'Recurring invoices only advanced in short pieces today.', 90),
      strength: 'strong',
      not: ['Do not describe the day as unproductive or wasted.'],
    },
  },
]);

// ── 6. No meaningful issue and no useful next step ──────────────────────────
scenario('06_nothing_needed', 'Nothing needed', 'Everything reached a stopping point, nothing was displaced → null is correct.', STUDENT, [
  { blocks: [assignmentWriting('10:00', 70, 'indexing'), midtermStudy('14:00', 60, 'Dynamic Programming', true)], coach: ordinary(ASSIGNMENT) },
  {
    probe: true,
    blocks: [assignmentSubmit('10:00', 35), midtermStudy('11:00', 75, 'Graph Algorithms', true), gaming('15:00', 90), video('20:00', 45)],
    coach: { primary: null, strength: 'none', reason: 'The assignment was submitted, the practice set was completed, and the rest of the day was leisure: nothing is open and nothing was displaced.', not: ['Do not treat the afternoon and evening of leisure as something to reduce.'] },
  },
]);

// ── 7. Heavy work days where rest is actually supported ─────────────────────
const longDay = (feature, what) => [saasShipped('07:30', 270, feature), clientDelivered('12:45', 250, what), saasShipped('18:00', 130, `${feature} polish`)];
scenario('07_heavy_load_rest', 'Heavy load — rest may be supported', 'Five ten-hour days in a row, each ending at a stopping point → deliberate rest may be appropriate; it is never required.', FOUNDER, [
  { blocks: longDay('invoice templates', 'the CSV export'), coach: ordinary(SAAS) },
  { blocks: longDay('tax settings', 'the audit report'), coach: ordinary(SAAS) },
  { blocks: longDay('payment reminders', 'the audit report filters'), coach: ordinary(SAAS) },
  { blocks: longDay('client portal links', 'the role permissions screen'), coach: ordinary(SAAS) },
  {
    probe: true,
    blocks: longDay('multi-currency totals', 'the usage dashboard'),
    coach: {
      primary: action('Plan a lighter day or a deliberate stop', 'deliberate_rest', null, 'Five consecutive days of well over ten tracked hours, each ending with work shipped: nothing is open, and the load itself is the notable fact.'),
      strength: 'moderate',
      reason: 'Rest is supported by the record of long days; saying nothing is equally acceptable.',
      not: ['Do not infer tiredness, stress or burnout from the long days.', 'Do not recommend working more.'],
    },
  },
]);

// ── 8. Action accepted and completed successfully ───────────────────────────
scenario('08_success_then_continuation', 'Accepted, done, worked', 'An action was accepted, carried out and reported as having worked → is continuing with the same approach appropriate next?', STUDENT, [
  {
    blocks: [assignmentWriting('09:30', 75, 'indexing'), assignmentDebugging('11:00', 40), midtermStudy('14:00', 45, 'Dynamic Programming', true)],
    coach: {
      primary: action('Finish the indexing section and fix the failing index test', 'complete_open_loop', ASSIGNMENT, 'The indexing section and its test were left unfinished.', 60),
      strength: 'strong',
    },
  },
  {
    probe: true,
    history: [seed('Get the index test passing in one morning block', 'focus_session', 'morning', 60, ASSIGNMENT, 'accepted', 'done', 'worked')],
    blocks: [
      block('09:30', 70, 'Finishing the indexing section', 'Fixed the failing test and completed the indexing section; all tests passed.', work(ASSIGNMENT, 'Complete'), [
        code('indexing.sql', 'db-assignment-3'),
        term('pytest tests/test_indexes.py — 7 passed — db-assignment-3'),
      ]),
      assignmentWriting('11:00', 60, 'transactions'),
      midtermStudy('14:00', 50, 'Graph Algorithms', true),
    ],
    coach: {
      primary: action('Finish the transactions section in tomorrow morning\'s block', 'start_focus', ASSIGNMENT, 'Yesterday\'s focused finish worked, and the next section was started and left as a draft.', 60),
      strength: 'strong',
    },
  },
]);

// ── 9. Previous action failed ───────────────────────────────────────────────
scenario('09_previous_action_failed', 'Previous action failed', 'The user did what was suggested and said it did not work → the strategy must change, not repeat.', FOUNDER, [
  { blocks: [saasBuilding('09:00', 150, 'recurring invoices'), clientDelivered('13:30', 90, 'the CSV export')], coach: ordinary(SAAS) },
  {
    blocks: [clientWork('09:00', 170, 'the audit report'), clientDelivered('13:30', 120, 'the audit report')],
    coach: {
      primary: action('Protect a block for the invoicing SaaS', 'protect_priority', SAAS, 'The product got no time today while recurring invoices is unfinished.', 90),
      strength: 'strong',
    },
  },
  {
    probe: true,
    history: [seed('Keep the first ninety minutes of the morning for recurring invoices', 'protect_priority', 'morning', 90, SAAS, 'accepted', 'done', 'did_not_work', 'bad_timing')],
    blocks: [
      block('09:00', 15, 'Short stretch on recurring invoices', 'Started on recurring invoices before a client message arrived.', work(SAAS), [code('recurring-invoices.tsx', 'invoicely')], 15),
      block('09:15', 12, 'Replying in the client support channel', 'Answered a client question.', work(CLIENT, 'Communicate', 'Routine', 'medium'), [app('Slack', 'Acme — #portal-support — Slack')], 12),
      block('09:27', 14, 'Short stretch on recurring invoices', 'Returned to recurring invoices briefly.', work(SAAS), [code('recurring-invoices.tsx', 'invoicely')], 14),
      block('09:41', 15, 'Replying in the client support channel', 'Answered another client question.', work(CLIENT, 'Communicate', 'Routine', 'medium'), [app('Slack', 'Acme — #portal-support — Slack')], 15),
      block('09:56', 16, 'Short stretch on recurring invoices', 'Returned to recurring invoices briefly; it was still unfinished.', work(SAAS), [code('recurring-invoices.tsx', 'invoicely')], 16),
      clientWork('10:30', 150, 'the role permissions screen'),
      clientDelivered('14:00', 100, 'the role permissions screen'),
    ],
    coach: {
      primary: action('Give recurring invoices one block at a different time, with the client channel closed', 'schedule_change', SAAS, 'The morning product block was tried and kept breaking up; the same block again would repeat what did not work.', 60),
      strength: 'strong',
      not: ['Do not recommend the same morning block again unchanged.'],
    },
  },
]);

// ── 10. Previous action rejected ────────────────────────────────────────────
scenario('10_previous_action_rejected', 'Previous action rejected', 'The user turned a recommendation down as not relevant → the Coach stays off that item afterwards, however it might be reworded.', STUDENT, [
  {
    blocks: [assignmentWriting('10:00', 70, 'indexing'), midtermStudy('14:00', 80, 'Dynamic Programming', true)],
    coach: {
      primary: action('Finish the indexing section of the assignment', 'complete_open_loop', ASSIGNMENT, 'The indexing section was left as a draft.', 60),
      strength: 'strong',
    },
  },
  {
    probe: true,
    history: [seed('Complete the indexing write-up before lunch', 'close_open_loop', 'morning', null, ASSIGNMENT, 'rejected', 'not_applicable', 'not_applicable', 'not_relevant')],
    blocks: [assignmentWriting('10:00', 40, 'indexing'), midtermStudy('14:00', 90, 'Graph Algorithms', true), gaming('20:00', 60)],
    coach: {
      primary: null,
      strength: 'none',
      reason: 'The only open item is the one the user just said is not relevant; the other priority reached a stopping point.',
      not: ['Do not recommend finishing the indexing section again.'],
    },
  },
]);

// ── 11. Same application, different goal ────────────────────────────────────
scenario('11_same_app_different_goal', 'Same application, different goal', 'Two priorities live in the same app; one was finished and one left mid-way → the action must follow the meaning, not the app.', WRITER, [
  { blocks: [newsletterDrafting('09:30', 60, 48), grantDrafting('11:00', 90, 'project description')], coach: ordinary(GRANT) },
  {
    probe: true,
    blocks: [newsletterDrafting('09:30', 45, 48), newsletterPublished('10:15', 15, 48), grantDrafting('11:00', 100, 'budget justification')],
    coach: {
      primary: action('Finish the budget justification of the grant application', 'complete_open_loop', GRANT, 'The newsletter was published; the budget justification was drafted and left unfinished.', 60),
      strength: 'strong',
      not: ['Do not recommend more work on the newsletter issue that was already published.'],
    },
  },
]);

// ── 12. Stated priority conflicts with raw attention ────────────────────────
scenario('12_priority_vs_attention', 'Stated priority vs observed attention', 'A stated priority gets nothing for days while a hobby gets hours → name the mismatch without moralizing.', STUDENT, [
  { blocks: [midtermStudy('10:00', 90, 'Dynamic Programming', true), assignmentWriting('14:00', 60, 'indexing')], coach: ordinary(MIDTERM) },
  { blocks: [assignmentSubmit('10:00', 40), modding('11:00', 240)], coach: { ...ordinary(MIDTERM), reason: 'One day without midterm preparation is not yet a pattern.' } },
  {
    blocks: [modding('10:00', 260), video('20:00', 40)],
    coach: { primary: action('Decide whether midterm preparation is still a current priority', 'clarify_priority', MIDTERM, 'Two days with no midterm preparation while a hobby project took the tracked time.'), strength: 'strong' },
  },
  {
    probe: true,
    blocks: [modding('10:00', 250), video('20:30', 30)],
    coach: {
      primary: action('Settle whether midterm preparation is still current, or protect one study block for it', 'clarify_priority', MIDTERM, 'Three days running with no midterm preparation; the tracked time went to a hobby project. Only the user can say which is right.', 60),
      strength: 'strong',
      not: ['Do not criticize the time spent on the hobby project.', 'Do not describe the hobby project as a distraction or as wasted time.'],
    },
  },
]);

// ── 13. Already doing exactly what should be done ───────────────────────────
scenario('13_already_on_track', 'Already on track', 'A steady rhythm where both priorities ship every day → no intervention.', FOUNDER, [
  { blocks: [saasShipped('09:00', 180, 'invoice templates'), clientDelivered('13:30', 120, 'the CSV export')], coach: ordinary(SAAS) },
  { blocks: [saasShipped('09:00', 175, 'tax settings'), clientDelivered('13:30', 125, 'the audit report')], coach: ordinary(SAAS) },
  { blocks: [saasShipped('09:00', 185, 'payment reminders'), clientDelivered('13:30', 115, 'the audit report filters')], coach: ordinary(SAAS) },
  {
    probe: true,
    blocks: [saasShipped('09:00', 180, 'client portal links'), clientDelivered('13:30', 120, 'the role permissions screen')],
    coach: { primary: null, strength: 'none', reason: 'Both priorities were worked on and shipped, as on every recent day; nothing is open, displaced or fragmented.', not: ['Do not recommend working longer.'] },
  },
]);

// ── 14. Ambiguous evidence ──────────────────────────────────────────────────
scenario('14_ambiguous_evidence', 'Ambiguous evidence', 'A short day of activity that cannot be interpreted → uncertainty, not a confident action.', STUDENT, [
  { blocks: [assignmentSubmit('10:00', 35), midtermStudy('11:00', 70, 'Dynamic Programming', true)], coach: ordinary(MIDTERM) },
  {
    probe: true,
    blocks: [
      block('15:00', 80, 'Unclear browsing and file handling', 'Moved between blank tabs, an untitled document and a downloads folder; what it was for cannot be told from the tracker.', { context: 'Personal', area: null, intent: 'Manage', quality: 'Routine', importance: 'low' }, [
        web('New Tab', 'chrome://newtab/'),
        web('Untitled document — Google Docs', 'https://docs.google.com/document/d/untitled'),
        app('Explorer', 'Downloads'),
        web('Google', 'https://www.google.com/'),
      ], 10),
    ],
    coach: { primary: null, strength: 'none', reason: 'Eighty minutes of activity that cannot be tied to anything: there is no basis for an action.', not: ['Do not assume the untracked rest of the day was unproductive.'] },
  },
]);

// ── 15. External constraint prevents execution ──────────────────────────────
scenario('15_external_constraint', 'External constraint', 'An accepted action could not be carried out because an outage took the day → adapt, do not blame.', FOUNDER, [
  { blocks: [saasBuilding('09:00', 150, 'recurring invoices'), clientDelivered('13:30', 90, 'the CSV export')], coach: ordinary(SAAS) },
  {
    blocks: [clientWork('09:00', 170, 'the audit report'), clientDelivered('13:30', 120, 'the audit report')],
    coach: {
      primary: action('Protect a block for the invoicing SaaS', 'protect_priority', SAAS, 'The product got no time today while recurring invoices is unfinished.', 90),
      strength: 'strong',
    },
  },
  {
    probe: true,
    history: [seed('Keep a ninety-minute morning block for recurring invoices', 'protect_priority', 'morning', 90, SAAS, 'accepted', 'not_done', 'not_applicable', 'external_constraint')],
    blocks: [clientIncident('08:30', 240), clientIncident('13:30', 200)],
    coach: {
      primary: action('Return to recurring invoices once the incident is closed', 'protect_priority', SAAS, 'The planned product block could not happen: a client outage took the day. The product work is still where it was left.', 60),
      strength: 'strong',
      not: ['Do not describe the missed product block as a failure to follow through.', 'Do not recommend adding product work on top of the outage day.'],
    },
  },
]);

// ── 16. Competing priorities: the next move is on the smallest one ─────────
scenario('16_competing_priorities', 'Competing priorities', 'Three priorities: the biggest was delivered, one is simply continuing, the smallest has a specific unfinished item → the action belongs to the smallest, not the most visible.', DESIGNER, [
  { blocks: [brandWork('09:00', 180, 'colour palette'), portfolioWork('14:00', 90, 'case study page')], coach: ordinary(BRAND) },
  { blocks: [brandWork('09:00', 200, 'typography'), portfolioWork('14:30', 60, 'about page')], coach: ordinary(BRAND) },
  {
    probe: true,
    blocks: [brandWork('09:00', 150, 'logo usage'), brandDelivered('11:30', 30), portfolioWork('13:30', 80, 'case study page'), invoicesDrafted('15:30', 25)],
    coach: {
      primary: action('Send the remaining client invoices', 'complete_open_loop', INVOICES, 'Two of five invoices were drafted and none sent; the brand guidelines were delivered and the portfolio is simply continuing.', 30),
      strength: 'strong',
      not: ['Do not recommend more brand guideline work after it was delivered.'],
    },
  },
]);

// ── 17. A finished priority going quiet is not displacement ─────────────────
scenario('17_finished_priority_goes_quiet', 'Finished priority goes quiet', 'A priority was completed and then, naturally, got no more time → its absence is not something to act on.', STUDENT, [
  { blocks: [assignmentWriting('10:00', 60, 'transactions'), assignmentSubmit('11:15', 30), midtermStudy('14:00', 60, 'Dynamic Programming', true)], coach: ordinary(MIDTERM) },
  { blocks: [midtermStudy('10:00', 150, 'Graph Algorithms', true), gaming('20:00', 60)], coach: ordinary(MIDTERM) },
  {
    probe: true,
    blocks: [midtermStudy('10:00', 140, 'Network Flow', true), video('20:00', 40)],
    coach: {
      primary: null,
      strength: 'none',
      reason: 'The assignment was submitted two days ago, so its absence is completion and not displacement; today the practice set was completed too.',
      not: ['Do not recommend protecting time for the assignment after it was submitted.'],
    },
  },
]);

// ── 18. One unusual day is a circumstance, not a pattern ────────────────────
scenario('18_one_off_displacement', 'One-off displacement', 'One day lost to an outage that was then closed, after the other priority had shipped → no intervention.', FOUNDER, [
  { blocks: [saasShipped('09:00', 170, 'invoice templates'), clientDelivered('13:30', 110, 'the CSV export')], coach: ordinary(SAAS) },
  { blocks: [saasShipped('09:00', 180, 'tax settings'), clientDelivered('13:30', 100, 'the audit report')], coach: ordinary(SAAS) },
  {
    probe: true,
    blocks: [clientIncident('08:30', 230), clientIncident('13:00', 150), incidentClosed('15:40', 30)],
    coach: {
      primary: null,
      strength: 'none',
      reason: 'A single day without product time, caused by an outage that was closed the same day; the product work had shipped the day before. One unusual day is not a pattern.',
      not: ['Do not describe the product priority as neglected after one outage day.'],
    },
  },
]);

// ── 19. A strategy that worked, reused on what is open now ──────────────────
scenario('19_success_reused_on_new_target', 'Success reused on a new target', 'A morning block finished one section; the next section is now open → the same shape, aimed at the new item — not the old sentence.', WRITER, [
  { blocks: [newsletterDrafting('09:30', 60, 49), grantDrafting('11:00', 90, 'project description')], coach: ordinary(GRANT) },
  {
    probe: true,
    history: [seed('Resolve the open comments on the project description in one morning block', 'focus_session', 'morning', 60, GRANT, 'accepted', 'done', 'worked')],
    blocks: [
      block('09:00', 70, 'Finishing the project description', 'Cleared every open comment and completed the project description.', work(GRANT, 'Complete'), [
        web('Grant application — project description (final, 0 open comments) — Google Docs', 'https://docs.google.com/document/d/grant'),
      ]),
      newsletterDrafting('10:30', 45, 49),
      newsletterPublished('11:15', 15, 49),
      grantDrafting('13:00', 80, 'budget justification'),
    ],
    coach: {
      primary: action("Finish the budget justification in tomorrow morning's block", 'start_focus', GRANT, 'A morning block finished the previous section, and the next section was drafted and left unfinished.', 60),
      strength: 'strong',
      not: ['Do not recommend more work on the project description after it was completed.'],
    },
  },
]);

// ── 20. Partly worked → refine one thing ────────────────────────────────────
scenario('20_partly_worked_refined', 'Partly worked, refined', 'A long evening block was only partly carried out and partly helped → keep the idea, make it smaller or move it; do not repeat it unchanged.', STUDENT, [
  { blocks: [assignmentSubmit('10:00', 30), midtermStudy('19:00', 60, 'Network Flow')], coach: ordinary(MIDTERM) },
  {
    probe: true,
    history: [seed('Work through the Network Flow practice set in one long evening block', 'focus_session', 'evening', 120, MIDTERM, 'accepted', 'partial', 'partly_worked', 'too_difficult')],
    blocks: [midtermStudy('19:00', 50, 'Network Flow'), gaming('20:00', 60)],
    coach: {
      primary: action('Finish the remaining Network Flow problems in a shorter block', 'start_focus', MIDTERM, 'The long evening block was only partly carried out; the practice set is still part-way.', 45),
      strength: 'strong',
      not: ['Do not recommend the same two-hour evening block again.'],
    },
  },
]);

// ── 21. "Not now" is an answer for today ────────────────────────────────────
scenario('21_deferred_not_repeated', 'Deferred, not repeated', 'The user postponed a recommendation ("not now") → it comes back by itself tomorrow; nothing more for that priority today.', STUDENT, [
  { blocks: [assignmentWriting('10:00', 70, 'indexing'), midtermStudy('14:00', 60, 'Dynamic Programming', true)], coach: ordinary(ASSIGNMENT) },
  {
    probe: true,
    history: [seed('Complete the indexing write-up before lunch', 'close_open_loop', 'morning', null, ASSIGNMENT, 'deferred')],
    blocks: [midtermStudy('11:00', 90, 'Graph Algorithms', true), gaming('20:00', 60)],
    coach: {
      primary: null,
      strength: 'none',
      reason: 'The one open item was postponed by the user and will be offered again by itself; the other priority reached a stopping point.',
      not: ['Do not recommend the indexing section again on the day it was postponed.'],
    },
  },
]);

// ── 22. Too difficult → a smaller step ──────────────────────────────────────
scenario('22_too_difficult_made_smaller', 'Too difficult, made smaller', 'A two-hour block was accepted and not done because it was too much → the next offer must be smaller or name the blocker.', FOUNDER, [
  { blocks: [saasBuilding('09:00', 150, 'recurring invoices'), clientDelivered('13:30', 90, 'the CSV export')], coach: ordinary(SAAS) },
  {
    probe: true,
    history: [seed('Finish recurring invoices in one two-hour morning block', 'focus_session', 'morning', 120, SAAS, 'accepted', 'not_done', 'not_applicable', 'too_difficult')],
    blocks: [clientWork('09:00', 150, 'the audit report'), saasBuilding('13:30', 60, 'recurring invoices'), clientDelivered('15:00', 80, 'the audit report')],
    coach: {
      primary: action('Get the failing recurring-invoice tests passing in a short block', 'start_focus', SAAS, 'The two-hour block did not happen because it was too large; the feature is still unfinished with failing tests.', 45),
      strength: 'strong',
      not: ['Do not recommend the same two-hour block again.'],
    },
  },
]);

// ── Emit ────────────────────────────────────────────────────────────────────

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const iso = (date, m) => `${date}T${hhmm(m)}:00${OFFSET}`;
const dateOf = (index) => {
  const d = new Date(Date.UTC(2026, 10, 2 + index)); // Mon 2 Nov 2026 onward
  return d.toISOString().slice(0, 10);
};

let written = 0;
for (const s of scenarios) {
  const dir = path.join(here, s.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let eventId = 0;

  s.days.forEach((day, index) => {
    const date = dateOf(index);
    const raw_events = [];
    const activities = [];
    let cursor = 0;
    day.blocks.forEach((b, blockIndex) => {
      const start = Math.max(toMinutes(b.at), cursor);
      const end = start + b.minutes;
      const ids = [];
      for (let t = start, w = 0; t < end; w++) {
        const next = Math.min(end, t + b.slice);
        const window = b.windows[w % b.windows.length];
        raw_events.push({ id: ++eventId, watcher: 'desktop', started_at: iso(date, t), ended_at: iso(date, next), ...window, payload: null });
        ids.push(eventId);
        t = next;
      }
      cursor = end;
      if (b.title.trim().split(/\s+/).length > 7) throw new Error(`${s.id}: ground-truth title is long enough to trip the answer-key tripwire: "${b.title}"`);
      activities.push({
        id: `gt-${String(index + 1).padStart(2, '0')}-${String(blockIndex + 1).padStart(2, '0')}`,
        started_at: hhmm(start),
        ended_at: hhmm(end),
        title: b.title,
        summary: b.summary,
        event_ids: ids,
        ...b.labels,
      });
    });

    const first = toMinutes(activities[0].started_at);
    const last = toMinutes(activities[activities.length - 1].ended_at);
    const active = activities.reduce((sum, a) => sum + toMinutes(a.ended_at) - toMinutes(a.started_at), 0);
    let longestGap = 0;
    for (let i = 1; i < activities.length; i++) longestGap = Math.max(longestGap, toMinutes(activities[i].started_at) - toMinutes(activities[i - 1].ended_at));

    const minutesFor = (priority) => activities.filter((a) => a.area === priority).reduce((sum, a) => sum + toMinutes(a.ended_at) - toMinutes(a.started_at), 0);
    const coach = day.coach;
    const strength = coach.strength;
    const file = {
      persona: s.persona,
      day: {
        day_number: index + 1,
        date,
        day_type: `${s.id}${day.probe ? '__probe' : ''}`,
        circumstances: [s.tests],
        laptop_usage: { first_seen: hhmm(first), last_seen: hhmm(last), approx_active_hours: Math.round((active / 60) * 10) / 10, longest_unobserved_gap_minutes: longestGap },
      },
      raw_events,
      ground_truth: { activities, unobserved_periods: [] },
      expected_reflection: {
        period: 'day',
        key_observations: [...new Set(activities.map((a) => a.title))].slice(0, 5),
        priority_alignment: s.persona.priorities.map((priority) => {
          const minutes = minutesFor(priority);
          return { priority, assessment: minutes >= 90 ? 'strong progress' : minutes >= 20 ? 'some progress' : 'no substantial progress observed today' };
        }),
        important_uncertainty: [],
        possible_next_step: coach.primary ? coach.primary.title : 'No next step is needed today.',
      },
      expected_coach_outcome: {
        primary_action: coach.primary,
        secondary_action: coach.secondary ?? null,
        things_not_to_do: coach.not ?? [],
        action_opportunity: {
          should_exist: strength === 'strong',
          strength,
          reason: coach.reason ?? coach.primary?.reason ?? 'Nothing in the day calls for a next action.',
          priority: coach.primary?.target ?? null,
          type: coach.primary?.action_type ?? null,
        },
        ...(coach.scenario ? { execution_scenario: { reason_code: null, ...coach.scenario } } : {}),
      },
      evaluation_objectives: { coach_scenario: { id: s.id, title: s.title, tests: s.tests, probe: day.probe === true } },
      ...(day.history ? { coach_history: day.history } : {}),
    };
    fs.writeFileSync(path.join(dir, `reflect_day_${String(index + 1).padStart(2, '0')}.json`), `${JSON.stringify(file, null, 2)}\n`);
    written++;
  });
}
console.log(`wrote ${scenarios.length} scenario(s), ${written} day file(s)`);
