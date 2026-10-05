import { describe, it, expect } from 'vitest';
import { buildCoachContext, renderCoachSection, staleOpenLoops, type CoachContext } from '../../src/coach/CoachContext';
import { REASON_LABELS } from '../../src/coach/CoachEffectiveness';
import { DEFAULT_COACH_CONFIG, type CoachAction, type CoachMemory } from '../../src/coach/CoachModels';
import {
  OPPORTUNITY_RULES,
  candidateSignals,
  detectOpportunities,
  openEvidenceOf,
  orderSignals,
  renderOpportunities,
  wasDelivered,
  withRecord,
  workStateOf,
  type CoachOpportunity,
  type OpportunityInput,
} from '../../src/coach/CoachOpportunities';
import { COACH_PROMPT_VERSION, buildCoachResponseSchema, buildDailyCoachParts } from '../../src/coach/CoachPrompt';
import { buildSituations, mainItem, renderSituations, type SituationDay } from '../../src/coach/CoachSituation';
import { validateDailyCoach } from '../../src/coach/CoachValidator';
import type { Metric, MetricSet, MetricUnit } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { createEvidenceToolkit } from '../../src/reflection/ReflectionValidator';
import { activity, iso, local } from '../reflection/helpers';
import { coachAction, memory, modelAction, modelCoach, notDone, worked } from './helpers';

/**
 * Opportunity recall: recognising the days on which one next move would matter
 * — without becoming a Coach that always has something to say.
 *
 * Every test here pins a cause found in the 30-day benchmark and the scenario
 * set, where the Coach had the evidence and still said nothing useful:
 *
 *   - an activity read as a state      "Drafting the proposal" counted as "explicitly unfinished", every day
 *   - the last glance read as the work twenty minutes on the roadmap outranked two hours on the dashboard
 *   - a signal with no memory          the clearest line of the day was the one already suggested and done —
 *                                      the model proposed it, the validator refused it, and the day got nothing
 *   - an inference that never lapsed   "the proposal remains open", written once, argued for it for three weeks
 *   - a finished step read as done     a priority with no time for days, the time going to nothing the user named
 *   - a refinement refused as a repeat the one form the record asks for after "partly worked"
 *   - a refusal with nowhere to go     "not this" sent the model back to the same sentence
 *   - a refusal that invited silence   "name the item, or return no action" — the model had the right target, was
 *                                      refused for its wording, and returned no action (the first live run's main loss)
 *   - a changed attempt refused        after "did not help", the same item at another time was a "repeat"
 *   - a kept action lost in retries    the last attempt's empty subset replaced an earlier attempt's valid action
 *
 * and, for each, the neighbouring case that must stay silent.
 */

const NOW = local(12, '22:05');
const day = periodContaining('day', local(12));
const SAAS = { id: 'pr-saas', text: 'Ship the SaaS MVP' };
const LEADS = { id: 'pr-leads', text: 'Generate new freelance leads' };
const CLIENT = { id: 'pr-client', text: 'Complete existing client work' };

const metric = (key: string, value: number | string, unit: MetricUnit, display: string, extra: Partial<Metric> = {}): Metric => ({ key, label: key, value, unit, display, group: 'time', ...extra });
const minutes = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`);
function dayMetrics(linked: Record<string, number>, tracked: number, extra: Metric[] = []): MetricSet {
  const out: MetricSet = { 'time.tracked_minutes': metric('time.tracked_minutes', tracked, 'minutes', minutes(tracked)) };
  for (const [id, n] of Object.entries(linked)) {
    if (n > 0) out[`priority.${id}.minutes`] = metric(`priority.${id}.minutes`, n, 'minutes', minutes(n), { priorityId: id });
  }
  for (const m of extra) out[m.key] = m;
  return out;
}
const input = (over: Partial<OpportunityInput>): OpportunityInput => ({ activities: [], metrics: {}, priorities: [SAAS, LEADS], memories: [], ...over });
const recordOf = (signals: CoachOpportunity[], actions: CoachAction[], priorities = [SAAS, LEADS, CLIENT]) =>
  withRecord(signals, { actions, priorities, nowIso: NOW.toISOString(), config: DEFAULT_COACH_CONFIG, reasonLabel: (code) => REASON_LABELS[code] });

// ── An activity is not a state ──────────────────────────────────────────────

describe('an activity is not a state', () => {
  it('"drafting", "debugging" and "investigating" say what was being done — not that it was left unfinished', () => {
    // The 30-day case: twenty minutes of outreach that read as "explicitly unfinished" every single day.
    expect(workStateOf({ title: 'Drafting freelance proposal', summary: 'The user was drafting a freelance proposal in Google Docs.' })).toBe('underway');
    expect(workStateOf({ title: 'Planning SaaS launch', summary: 'Drafted project and launch plans in Notion.' })).toBe('underway');
    expect(workStateOf({ title: 'Investigating the authentication API issue', summary: null })).toBe('underway');
    expect(workStateOf({ title: 'Working on the client project and troubleshooting', summary: 'Continued the payment integration.' })).toBe('underway');
    // An instruction to write something is not a draft lying around; "bug fixing" is an activity too.
    expect(workStateOf({ title: 'Draft the weekly client update', summary: null })).toBe('unknown');
    expect(workStateOf({ title: 'Client project bug fixing and staging verification', summary: 'Edited checkout.ts and tested on the staging site.' })).toBe('unknown');
  });

  it('a STATEMENT that something is unfinished still reads as open', () => {
    expect(workStateOf({ title: 'Recurring invoices', summary: 'Updated the draft pull request; 2 tests were failing.' })).toBe('open');
    expect(workStateOf({ title: 'Weekly newsletter', summary: 'Worked on the Newsletter #48 draft in Google Docs.' })).toBe('open');
    expect(workStateOf({ title: 'Monthly invoicing', summary: 'Checked the invoices in FreshBooks, leaving 2 drafts ready.' })).toBe('open');
    expect(workStateOf({ title: 'Network Flow practice set', summary: 'Practice set: 4 of 9 solved.' })).toBe('open');
    expect(workStateOf({ title: 'Drafting the budget justification', summary: 'Wrote part of it.' })).toBe('open');
    expect(workStateOf({ title: 'Grant application', summary: 'The budget section is still a draft.' })).toBe('open');
  });

  it('the words of an open state, saying the opposite, are not one', () => {
    expect(workStateOf({ title: 'Running the assignment tests', summary: 'pytest: 0 failed, 7 passed.' })).toBe('unknown');
    expect(workStateOf({ title: 'Network Flow practice set', summary: 'Practice set: 9 of 9 solved.' })).toBe('unknown');
    expect(workStateOf({ title: 'Checking the build', summary: 'The build ran with no errors.' })).toBe('unknown');
  });

  it('names the words that say so, and tells a hand-over from the end of a step', () => {
    expect(openEvidenceOf({ title: 'Recurring invoices', summary: 'Ran the suite. Two of the chart tests were still failing at the end.' })).toBe('Two of the chart tests were still failing at the end');
    expect(openEvidenceOf({ title: 'Debugging the failing index test', summary: null })).toBe('Debugging the failing index test');
    expect(openEvidenceOf({ title: 'Drafting freelance proposal', summary: 'Was drafting it.' })).toBeNull();
    expect(wasDelivered({ title: 'Submitting Assignment 3', summary: 'Submitted on the course site.' })).toBe(true);
    expect(wasDelivered({ title: 'Completed the graph algorithms practice set', summary: 'Finished every problem.' })).toBe(false);
  });

  it('early-stage work reads as unfinished — less plainly than a statement that it is', () => {
    // The first live run showed the cost of calling it merely "possible": "drafted the report" was the only trace
    // of "left as a draft", and the Coach stayed silent. What keeps it from becoming a daily nudge is the record
    // (see "routine" below), not a weaker reading of the day.
    const drafting = (n: number) => activity(n, '14:00', 30, { title: 'Drafting freelance proposal', summary: 'Drafting a proposal in Google Docs.', priorityId: 'pr-leads', thread: 'Freelance Outreach' });
    const failing = activity(12, '16:00', 30, { title: 'Recurring invoices', summary: 'Two tests were still failing.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    const earlier = (n: number): SituationDay => ({ dayKey: `2026-10-${String(n).padStart(2, '0')}`, dayLabel: `Oct ${n}`, activities: [drafting(n)] });
    const today = [drafting(12), failing];
    const metrics = dayMetrics({ 'pr-leads': 30, 'pr-saas': 30 }, 240);
    const signalsAfter = (recentDays: SituationDay[]) => {
      const situations = buildSituations({ priorities: [SAAS, LEADS], activities: today, metrics, recentDays, actions: [] });
      return detectOpportunities(input({ activities: today, metrics, situations }));
    };
    const [stated, early] = signalsAfter([]).filter((s) => s.kind === 'left_off');
    expect(stated).toMatchObject({ strength: 'clear', item: 'Recurring invoices', confidence: 0.75 });
    expect(early).toMatchObject({ strength: 'clear', item: 'Drafting freelance proposal', confidence: 0.6 });
    expect(early.summary).toContain('described as work at an early stage (a draft, a fix or an investigation under way), not as finished');
    // The same early-stage item the next day is carried over, clearly.
    expect(signalsAfter([earlier(11)]).find((s) => s.kind === 'carried_over')).toMatchObject({ strength: 'clear', days: 2, priorityId: 'pr-leads' });
  });

  it('the same main piece of work for three days without a finish is a pattern — two days of it are ordinary work', () => {
    const building = (n: number) => activity(n, '10:00', 150, { title: 'Developing the SaaS dashboard', summary: 'Coded dashboard components and ran the build.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    const earlier = (n: number, shipped = false): SituationDay => ({
      dayKey: `2026-10-${String(n).padStart(2, '0')}`,
      dayLabel: `Oct ${n}`,
      activities: [shipped ? activity(n, '10:00', 150, { title: 'Developing the SaaS dashboard', summary: 'Merged and deployed the dashboard.', priorityId: 'pr-saas', thread: 'SaaS MVP' }) : building(n)],
    });
    const today = [building(12)];
    const metrics = dayMetrics({ 'pr-saas': 150 }, 300);
    const carried = (recentDays: SituationDay[]) => {
      const situations = buildSituations({ priorities: [SAAS], activities: today, metrics, recentDays, actions: [] });
      return detectOpportunities(input({ activities: today, metrics, priorities: [SAAS], situations })).find((s) => s.kind === 'carried_over');
    };
    expect(carried([earlier(11)])).toMatchObject({ strength: 'possible', days: 2 });
    const third = carried([earlier(11), earlier(10)])!;
    expect(third).toMatchObject({ strength: 'clear', days: OPPORTUNITY_RULES.persistentDays, item: 'Developing the SaaS dashboard' });
    expect(carried([earlier(11), earlier(10), earlier(9)])!.confidence).toBeGreaterThan(third.confidence);
    // Work that reaches its finishes is not carried over, however many days it runs — the "already on track" case.
    expect(carried([earlier(11, true), earlier(10, true)])).toBeUndefined();
    const shippedToday = [activity(12, '10:00', 150, { title: 'Developing the SaaS dashboard', summary: 'Merged and deployed the dashboard.', priorityId: 'pr-saas', thread: 'SaaS MVP' })];
    const situations = buildSituations({ priorities: [SAAS], activities: shippedToday, metrics, recentDays: [earlier(11), earlier(10)], actions: [] });
    expect(detectOpportunities(input({ activities: shippedToday, metrics, priorities: [SAAS], situations }))).toEqual([]);
  });
});

// ── The main piece of work, not the last glance ─────────────────────────────

describe('where a priority stands is its main piece of work, not the last thing touched', () => {
  const dashboard1 = activity(12, '18:10', 95, { title: 'Designing and implementing SaaS dashboard', summary: 'Coded the dashboard interface and ran the build.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
  const dashboard2 = activity(12, '20:30', 50, { title: 'Designing and implementing SaaS dashboard', summary: 'Resumed coding the dashboard interface.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
  const roadmap = activity(12, '21:21', 21, { title: 'Reviewing SaaS product roadmap', summary: 'Checked the SaaS Roadmap in Notion to plan next steps.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
  const metrics = dayMetrics({ 'pr-saas': 166 }, 320);

  it('twenty minutes on the roadmap after two hours on the dashboard leave the dashboard mid-way', () => {
    expect(mainItem([dashboard1, dashboard2, roadmap], SAAS.text)).toMatchObject({ title: 'Designing and implementing SaaS dashboard', minutes: 145, sessions: 2, activityId: dashboard2.id, state: 'unknown' });
    const [signal] = detectOpportunities(input({ activities: [dashboard1, dashboard2, roadmap], metrics, priorities: [SAAS] }));
    expect(signal).toMatchObject({ kind: 'left_off', strength: 'possible', item: 'Designing and implementing SaaS dashboard', activityIds: [dashboard2.id, roadmap.id] });
    expect(signal.summary).toContain('was mainly “Designing and implementing SaaS dashboard” (2h 25m in 2 sessions)');
    expect(signal.summary).toContain('The last thing touched was “Reviewing SaaS product roadmap”');
    // The board shows both, so the model can still see what came last.
    const situations = buildSituations({ priorities: [SAAS], activities: [dashboard1, dashboard2, roadmap], metrics, recentDays: [], actions: [] });
    const board = renderSituations(situations, metrics, () => null);
    expect(board).toContain('"mainWork":"“Designing and implementing SaaS dashboard” (2h 25m in 2 sessions) — nothing states whether it was finished"');
    expect(board).toContain('"lastStoodAt":"“Reviewing SaaS product roadmap”');
  });

  it('a last activity that says outright it is unfinished is where the day stands, however short', () => {
    const failing = activity(12, '21:21', 20, { title: 'Dashboard chart tests', summary: 'Two chart tests were still failing.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    expect(mainItem([dashboard1, dashboard2, failing], SAAS.text)).toMatchObject({ title: 'Dashboard chart tests', state: 'open' });
    const [signal] = detectOpportunities(input({ activities: [dashboard1, dashboard2, failing], metrics, priorities: [SAAS] }));
    expect(signal).toMatchObject({ kind: 'left_off', strength: 'clear', item: 'Dashboard chart tests' });
    expect(signal.summary).toContain('(“Two chart tests were still failing”)');
  });

  it('a day that ended on a finish has no loose end — whatever took the time before it', () => {
    const shipped = activity(12, '21:30', 15, { title: 'Deploying the dashboard', summary: 'Merged and deployed to production.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    expect(mainItem([dashboard1, dashboard2, shipped], SAAS.text)).toMatchObject({ state: 'stopping_point', title: 'Deploying the dashboard' });
    expect(detectOpportunities(input({ activities: [dashboard1, dashboard2, shipped], metrics, priorities: [SAAS] }))).toEqual([]);
    // Work begun AFTER a finish is the new open tail.
    const next = activity(12, '21:50', 30, { title: 'Starting the export feature', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    expect(mainItem([dashboard1, shipped, next], SAAS.text)).toMatchObject({ title: 'Starting the export feature', minutes: 30 });
  });

  it('the same main piece of work across days is carried over, even when each day ended on a glance at something else', () => {
    const earlier = (n: number): SituationDay => ({
      dayKey: `2026-10-${String(n).padStart(2, '0')}`,
      dayLabel: `Oct ${n}`,
      activities: [
        activity(n, '18:00', 120, { title: 'Developing SaaS dashboard component', priorityId: 'pr-saas', thread: 'SaaS MVP' }),
        activity(n, '21:00', 15, { title: 'Reviewing SaaS product roadmap', priorityId: 'pr-saas', thread: 'SaaS MVP' }),
      ],
    });
    const situations = buildSituations({ priorities: [SAAS], activities: [dashboard1, dashboard2, roadmap], metrics, recentDays: [earlier(11), earlier(10)], actions: [] });
    expect(situations[0].carriedOver).toMatchObject({ days: 3, item: 'Designing and implementing SaaS dashboard', state: 'unknown' });
    expect(situations[0].recent[0]).toMatchObject({ endedOn: 'Developing SaaS dashboard component' });
  });
});

// ── What the record already says about a signal ─────────────────────────────

describe('a signal is read against the record of what was already suggested', () => {
  const proposal: CoachOpportunity = {
    kind: 'carried_over',
    strength: 'clear',
    confidence: 0.75,
    priorityId: 'pr-leads',
    thread: 'Freelance Outreach',
    summary: '“Drafting freelance proposal” has been the last work toward “Generate new freelance leads” on 3 tracked days in a row without reading as finished.',
    metricKeys: ['priority.pr-leads.minutes'],
    activityIds: ['a4'],
    fits: ['close_open_loop'],
    item: 'Drafting freelance proposal',
    days: 3,
  };
  const onLeads = (over: Partial<CoachAction>) => ({ priorityId: 'pr-leads', thread: 'Freelance Outreach', targetKey: 'p:pr-leads', actionType: 'close_open_loop' as const, focusMinutes: 30, ...over });
  const standing = (actions: CoachAction[], signal: CoachOpportunity = proposal) => recordOf([signal], actions)[0].record;

  it('with nothing in the record, the signal stands as measured', () => {
    expect(recordOf([proposal], [])[0]).toEqual(proposal);
    // An action about another priority, or long forgotten, is not about this.
    expect(standing([worked(11, { title: 'Finish the dashboard chart tests', priorityId: 'pr-saas', targetKey: 'p:pr-saas' })])).toBeUndefined();
  });

  it('suggested and carried out a day ago: that it still reads as in progress is not new evidence', () => {
    const done = worked(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs' }));
    expect(standing([done])).toMatchObject({ standing: 'acted_on', settled: true, attempts: 1, lastTitle: 'Finish drafting the freelance proposal in Google Docs' });
    // After the few days in which a repeat would be noise, it is a candidate again.
    expect(standing([worked(7, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs' }))])).toBeUndefined();
  });

  it('suggested and carried out repeatedly: ongoing work the user already handles — the 30-day fixation', () => {
    const history = [worked(6, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs' })), worked(10, onLeads({ title: 'Complete the remaining sections of the freelance proposal in Google Docs' }))];
    const record = standing(history)!;
    expect(record).toMatchObject({ standing: 'routine', settled: true, attempts: 2 });
    expect(record.note).toContain('Suggested 2 times');
    expect(record.note).toContain('ongoing work the user already handles');
    expect(candidateSignals(recordOf([proposal], history))).toEqual([]);
  });

  it('carried out and only partly helped: stays a candidate, for a refinement', () => {
    const partly = worked(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', outcome: 'partly_worked' }));
    expect(standing([partly])).toMatchObject({ standing: 'partly_helped', settled: false });
    expect(standing([partly])!.note).toContain('only a refinement');
  });

  it('tried and did not help, or not carried out: stays a candidate — the strategy changes, the problem is not forgotten', () => {
    const failed = worked(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', outcome: 'did_not_work', reasonCode: 'bad_timing' }));
    expect(standing([failed])).toMatchObject({ standing: 'did_not_help', settled: false });
    expect(standing([failed])!.note).toContain('did not help (bad timing)');
    const tooBig = notDone(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', reasonCode: 'too_difficult' }));
    expect(standing([tooBig])).toMatchObject({ standing: 'did_not_help', settled: false });
    expect(standing([tooBig])!.note).toContain('only a clearly smaller step is worth offering');
  });

  it('could not happen for an outside reason: the step is exactly as worth offering as it was', () => {
    const interrupted = notDone(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', reasonCode: 'external_constraint' }));
    expect(standing([interrupted])).toMatchObject({ standing: 'could_not_happen', settled: false });
    expect(standing([interrupted])!.note).toContain('Offering that step again is right');
  });

  it('offered and never answered: covered while nothing is clearer — a candidate again, in a different form, once it is', () => {
    const unanswered = coachAction(onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', status: 'expired', originDayKey: '2026-10-11', createdAt: iso(11, '22:00'), closedAt: iso(12, '12:00'), updatedAt: iso(12, '12:00') }));
    const weak = { ...proposal, strength: 'possible' as const, confidence: 0.45 };
    expect(standing([unanswered], weak)).toMatchObject({ standing: 'unanswered', settled: true });
    const renewed = standing([unanswered])!;
    expect(renewed).toMatchObject({ standing: 'unanswered', settled: false });
    expect(renewed.note).toContain('offer it again only in a different form — a protected block before other work starts');
  });

  it('on the list, postponed or rejected: not a candidate today', () => {
    expect(standing([coachAction(onLeads({ title: 'Finish drafting the freelance proposal', status: 'suggested' }))])).toMatchObject({ standing: 'on_the_list', settled: true });
    // "Not now" is an answer for the whole target, whatever the postponed suggestion named.
    expect(standing([coachAction(onLeads({ title: 'Send three outreach messages', status: 'snoozed', snoozedUntil: iso(13, '00:00') }))])).toMatchObject({ standing: 'postponed', settled: true });
    const rejected = (reasonCode: CoachAction['reasonCode'], title: string) => coachAction(onLeads({ title, status: 'rejected', reasonCode, rejectedAt: iso(11, '22:10'), updatedAt: iso(11, '22:10') }));
    expect(standing([rejected('bad_timing', 'Finish drafting the freelance proposal')])).toMatchObject({ standing: 'rejected', settled: true });
    // "Not relevant" closes the whole target; another reason closes only what was rejected.
    expect(standing([rejected('not_relevant', 'Send three outreach messages')])).toMatchObject({ standing: 'rejected', settled: true });
    expect(standing([rejected('bad_timing', 'Send three outreach messages')])).toBeUndefined();
  });

  it('a different item of the same priority is not covered by what was done about another', () => {
    const dashboard: CoachOpportunity = { ...proposal, priorityId: 'pr-saas', thread: 'SaaS MVP', item: 'Developing SaaS dashboard component' };
    // Sharing a word for the KIND of thing ("component"), or the tool it lives in, does not make two items one.
    expect(standing([worked(11, { title: 'Complete the remaining onboarding component implementation in VS Code', priorityId: 'pr-saas', thread: 'SaaS MVP', targetKey: 'p:pr-saas' })], dashboard)).toBeUndefined();
    const messages: CoachOpportunity = { ...proposal, item: 'Drafting outreach messages' };
    expect(standing([worked(11, onLeads({ title: 'Finish the freelance proposal in Google Docs' }))], { ...messages, summary: 'x' })).toBeUndefined();
    // The same item under a different verb and with the tool named is still the same item.
    expect(standing([worked(11, { title: 'Review the remaining items on the SaaS Roadmap in Notion and select the next feature to build', priorityId: 'pr-saas', thread: 'SaaS MVP', targetKey: 'p:pr-saas' })], { ...dashboard, item: 'Reviewing SaaS product roadmap' })).toMatchObject({ standing: 'acted_on' });
  });

  it('a signal about the priority as a whole is not used up by work on one of its items', () => {
    const displaced: CoachOpportunity = { ...proposal, kind: 'displaced_priority', item: null, thread: null, days: 3, summary: '“Generate new freelance leads” got no linked time today.' };
    const history = [worked(6, onLeads({ title: 'Finish drafting the freelance proposal' })), worked(10, onLeads({ title: 'Finish the freelance proposal' }))];
    // The priority went without time AGAIN after those were done: that is new evidence, not a repeat.
    expect(standing(history, displaced)).toBeUndefined();
    // …but a suggestion already waiting for an answer still covers it.
    expect(standing([coachAction(onLeads({ title: 'Protect a block for lead generation', actionType: 'protect_priority', status: 'suggested' }))], displaced)).toMatchObject({ standing: 'on_the_list', settled: true });
  });

  it('what the record covers goes last, and is shown to the model as covered — never as a candidate', () => {
    const dashboard: CoachOpportunity = { ...proposal, kind: 'left_off', strength: 'possible', confidence: 0.4, priorityId: 'pr-saas', thread: 'SaaS MVP', item: 'Designing and implementing SaaS dashboard', summary: 'Work toward “Ship the SaaS MVP” was mainly the dashboard.', days: 1 };
    const history = [worked(6, onLeads({ title: 'Finish drafting the freelance proposal' })), worked(10, onLeads({ title: 'Finish the freelance proposal' }))];
    const ordered = orderSignals(recordOf([proposal, dashboard], history));
    // The clearest measurement of the day is no longer first: it is the one the user has already heard.
    expect(ordered.map((s) => s.item)).toEqual(['Designing and implementing SaaS dashboard', 'Drafting freelance proposal']);
    const text = renderOpportunities(ordered, () => null);
    expect(text.indexOf('"item":"Designing and implementing SaaS dashboard"')).toBeLessThan(text.indexOf('ALREADY COVERED BY THE RECORD'));
    expect(text.indexOf('ALREADY COVERED BY THE RECORD')).toBeLessThan(text.indexOf('"item":"Drafting freelance proposal"'));
    expect(text).toContain('NOT candidates');
    // Covered and nothing else: "nothing new", which is not the same as "nothing measured" — and still silence.
    const onlyCovered = renderOpportunities(orderSignals(recordOf([proposal], history)), () => null);
    expect(onlyCovered).toContain('Nothing new measured today: everything Reflect measured is already covered by the record');
    expect(onlyCovered).toContain('the right answer is no action');
    expect(onlyCovered).not.toContain('"strength"');
  });

  it('a kept signal carries the record as a note, and what it is about', () => {
    const partly = worked(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', outcome: 'partly_worked' }));
    const text = renderOpportunities(recordOf([proposal], [partly]), () => null);
    expect(text).toContain('"item":"Drafting freelance proposal"');
    expect(text).toContain('"days":3');
    expect(text).toContain('"record":"“Finish drafting the freelance proposal in Google Docs” was carried out on Sun, Oct 11 and the user said it partly helped');
  });
});

// ── Intention and observed attention ────────────────────────────────────────

describe('a stated priority with no time while the time goes to nothing the user named', () => {
  const MIDTERM = { id: 'pr-algo', text: 'Prepare for the algorithms midterm' };
  const ASSIGNMENT = { id: 'pr-db', text: 'Finish the database systems assignment' };
  const hobby = (n: number) => activity(n, '10:00', 180, { title: 'Hobby game mod', summary: 'Built and tested a shader for a game mod.', priorityId: null, thread: null });
  const hobbyDay = (n: number): SituationDay => ({ dayKey: `2026-10-${String(n).padStart(2, '0')}`, dayLabel: `Oct ${n}`, activities: [hobby(n)] });
  const studyDay = (n: number, title: string, summary: string, priorityId: string): SituationDay => ({ dayKey: `2026-10-${String(n).padStart(2, '0')}`, dayLabel: `Oct ${n}`, activities: [activity(n, '10:00', 120, { title, summary, priorityId })] });
  const recent = (id: string, days: number, of: number) => [
    metric('recent.active_days', of, 'count', String(of)),
    metric(`recent.priority.${id}.active_days`, days, 'count', `${days} of ${of}`, { priorityId: id }),
    metric(`recent.priority.${id}.last_day`, 'Fri, Oct 9', 'text', 'Fri, Oct 9', { priorityId: id }),
  ];
  const today = [hobby(12)];
  const metrics = dayMetrics({}, 180, [...recent('pr-algo', 1, 3), ...recent('pr-db', 1, 3), metric('priority.unlinked_minutes', 180, 'minutes', '3h 0m')]);
  const finishedStep = { title: 'Completed the graph algorithms practice set', summary: 'Finished every problem and checked the answers.', dayLabel: 'Fri, Oct 9' };
  const signalFor = (recentDays: SituationDay[], lastKnown: Record<string, { title: string; summary: string | null; dayLabel: string }>, priorityId = 'pr-algo') => {
    const situations = buildSituations({ priorities: [MIDTERM, ASSIGNMENT], activities: today, metrics, recentDays, actions: [] });
    return detectOpportunities(input({ activities: today, metrics, priorities: [MIDTERM, ASSIGNMENT], situations, lastKnown })).find((s) => s.kind === 'displaced_priority' && s.priorityId === priorityId)!;
  };

  it('three tracked days of it is a question for the user — even though the last step of that priority was finished', () => {
    const earlier = [hobbyDay(11), hobbyDay(10), studyDay(9, 'Completed the graph algorithms practice set', 'Finished every problem.', 'pr-algo')];
    const situations = buildSituations({ priorities: [MIDTERM, ASSIGNMENT], activities: today, metrics, recentDays: earlier, actions: [] });
    expect(situations[0]).toMatchObject({ untouchedStreak: 3, elsewhereStreak: 3 });
    const signal = signalFor(earlier, { 'pr-algo': finishedStep });
    expect(signal).toMatchObject({ strength: 'clear', days: 3, ask: true });
    // A question, not a prescription: only the user can say which is current.
    expect(signal.fits[0]).toBe('clarify_priority');
    expect(signal.summary).toContain('On 3 of those days most of the tracked time was linked to none of the stated priorities');
    expect(signal.summary).toContain('only the user can say which');
    expect(signal.summary).not.toContain('it may simply be done');
    expect(renderSituations(situations, metrics, () => null)).toContain('on 3 of them most tracked time was linked to none of the stated priorities');
  });

  it('two such days are not yet a pattern, and work that was handed over stays "it may simply be done"', () => {
    const twoDays = [hobbyDay(11), studyDay(10, 'Completed the graph algorithms practice set', 'Finished every problem.', 'pr-algo')];
    expect(signalFor(twoDays, { 'pr-algo': finishedStep })).toMatchObject({ strength: 'possible', fits: ['clarify_priority'] });
    expect(signalFor(twoDays, { 'pr-algo': finishedStep }).ask).toBeUndefined();
    // Submitted is submitted, however long the quiet lasts and wherever the time went.
    const earlier = [hobbyDay(11), hobbyDay(10), studyDay(9, 'Submitting Assignment 3', 'Submitted on the course site.', 'pr-db')];
    const submitted = signalFor(earlier, { 'pr-db': { title: 'Submitting Assignment 3', summary: 'Submitted on the course site.', dayLabel: 'Fri, Oct 9' } }, 'pr-db');
    expect(submitted).toMatchObject({ strength: 'possible', fits: ['clarify_priority'] });
    expect(submitted.summary).toContain('it may simply be done; only the user can say');
  });

  it('time that went to ANOTHER stated priority is not attention elsewhere: a finished priority going quiet stays quiet', () => {
    const other = (n: number): SituationDay => ({ dayKey: `2026-10-${n}`, dayLabel: `Oct ${n}`, activities: [activity(n, '09:00', 200, { title: 'Database assignment queries', priorityId: 'pr-db' })] });
    const working = [activity(12, '09:00', 200, { title: 'Database assignment queries', priorityId: 'pr-db' })];
    const workMetrics = dayMetrics({ 'pr-db': 200 }, 220, [...recent('pr-algo', 1, 3), metric('priority.unlinked_minutes', 20, 'minutes', '20m')]);
    const situations = buildSituations({ priorities: [MIDTERM, ASSIGNMENT], activities: working, metrics: workMetrics, recentDays: [other(11), other(10), studyDay(9, 'Completed the graph algorithms practice set', 'Finished every problem.', 'pr-algo')], actions: [] });
    expect(situations[0]).toMatchObject({ untouchedStreak: 3, elsewhereStreak: 0 });
    const signal = detectOpportunities(input({ activities: working, metrics: workMetrics, priorities: [MIDTERM, ASSIGNMENT], situations, lastKnown: { 'pr-algo': finishedStep } })).find((s) => s.kind === 'displaced_priority')!;
    expect(signal).toMatchObject({ strength: 'possible', fits: ['clarify_priority'] });
    expect(signal.summary).toContain('it may simply be done');
  });
});

// ── The validator: record-based refusals, and where they send the model ─────

describe('the validator and the record', () => {
  const PRIORITIES = [SAAS, LEADS];
  const metrics: MetricSet = {
    'priority.pr-saas.minutes': metric('priority.pr-saas.minutes', 166, 'minutes', '2h 46m', { priorityId: 'pr-saas' }),
    'priority.pr-leads.minutes': metric('priority.pr-leads.minutes', 40, 'minutes', '40m', { priorityId: 'pr-leads' }),
  };
  const dashboard = activity(12, '18:10', 145, { title: 'Designing and implementing SaaS dashboard', summary: 'Coded the dashboard interface and ran the build.', priorityId: 'pr-saas', thread: 'SaaS MVP' });
  const drafting = activity(12, '14:00', 21, { title: 'Drafting freelance proposal', summary: 'Drafting a freelance proposal in Google Docs.', priorityId: 'pr-leads', thread: 'Freelance Outreach' });
  const evidence = createEvidenceToolkit({ metrics, activityByRef: new Map([['a1', dashboard], ['a2', drafting]]), priorities: PRIORITIES, periodLabel: 'Today Mon, Oct 12' });
  const signal = (over: Partial<CoachOpportunity>): CoachOpportunity => ({ kind: 'left_off', strength: 'possible', confidence: 0.4, priorityId: 'pr-saas', thread: 'SaaS MVP', summary: 's', metricKeys: ['priority.pr-saas.minutes'], activityIds: [dashboard.id], fits: ['close_open_loop'], days: 1, ...over });
  const dashboardSignal = signal({ item: 'Designing and implementing SaaS dashboard' });
  const proposalSignal = signal({ kind: 'carried_over', strength: 'clear', confidence: 0.75, priorityId: 'pr-leads', thread: 'Freelance Outreach', item: 'Drafting freelance proposal', days: 3, metricKeys: ['priority.pr-leads.minutes'], activityIds: [drafting.id] });
  const context = (options: { actions?: CoachAction[]; memories?: CoachMemory[]; opportunities?: CoachOpportunity[] } = {}): CoachContext =>
    buildCoachContext({
      now: NOW,
      reportDay: day,
      actions: options.actions ?? [],
      memories: options.memories ?? [],
      messages: [],
      priorities: PRIORITIES,
      knownThreads: ['SaaS MVP', 'Freelance Outreach'],
      config: DEFAULT_COACH_CONFIG,
      opportunities: options.opportunities ?? [],
      activityRefOf: (id) => (id === dashboard.id ? 'a1' : id === drafting.id ? 'a2' : null),
    });
  const leadsAction = (over: Record<string, unknown> = {}) =>
    modelAction({ title: 'Finish drafting the freelance proposal in Google Docs', rationale: 'The proposal was being drafted when the block ended.', actionType: 'close_open_loop', focusMinutes: 30, focusTask: 'Freelance proposal', priorityId: 'pr-leads', thread: 'Freelance Outreach', metricKeys: ['priority.pr-leads.minutes'], activityRefs: ['a2'], ...over });
  const onLeads = (over: Partial<CoachAction>) => ({ priorityId: 'pr-leads', thread: 'Freelance Outreach', targetKey: 'p:pr-leads', actionType: 'close_open_loop' as const, focusMinutes: 30, title: 'Finish drafting the freelance proposal in Google Docs', ...over });
  const daily = (coach: Record<string, unknown>, ctx: CoachContext) => validateDailyCoach({ raw: modelCoach(coach), context: ctx, evidence });

  it('a repeat of something just carried out is refused — and the refusal names what else is open', () => {
    const ctx = context({ actions: [worked(11, onLeads({}))], opportunities: [proposalSignal, dashboardSignal] });
    const result = daily({ actions: [leadsAction()] }, ctx);
    expect(result.coach.actions).toEqual([]);
    expect(result.errors[0]).toContain('the user already carried out “Finish drafting the freelance proposal in Google Docs”');
    // Somewhere to go: the other priority's candidate, by name.
    expect(result.errors[0]).toContain('Still measured as open today: “Designing and implementing SaaS dashboard” (Ship the SaaS MVP)');
    // And an honest "nowhere" when the record covers everything that was measured.
    const nothingElse = daily({ actions: [leadsAction()] }, context({ actions: [worked(11, onLeads({}))], opportunities: [proposalSignal] }));
    expect(nothingElse.errors[0]).toContain('Nothing else was measured as open today: return no action and give the reason');
  });

  it('the model is shown the covered item as covered, before it is asked anything', () => {
    const history = [worked(6, onLeads({})), worked(10, onLeads({ title: 'Complete the remaining sections of the freelance proposal in Google Docs' }))];
    const ctx = context({ actions: history, opportunities: [proposalSignal, dashboardSignal] });
    // (What just happened to the earlier suggestion is a signal of its own; the measured ones are what is checked here.)
    expect(ctx.opportunities.filter((s) => s.kind !== 'tried_before').map((s) => [s.item, s.record?.standing ?? null])).toEqual([
      ['Designing and implementing SaaS dashboard', null],
      ['Drafting freelance proposal', 'routine'],
    ]);
    const text = renderCoachSection(ctx);
    expect(text).toContain('ALREADY COVERED BY THE RECORD');
    expect(text).toContain('this reads as ongoing work the user already handles');
  });

  it('after "partly worked", the refinement the record asks for is not refused as a repeat', () => {
    const partly = worked(11, onLeads({ outcome: 'partly_worked', daypart: 'evening', focusMinutes: 120, strategyKey: 'close_open_loop|evening|long' }));
    const ctx = context({ actions: [partly], opportunities: [proposalSignal] });
    expect(ctx.followups.map((f) => f.ref)).toEqual(['k1']);
    // Smaller, tied to the action it refines: accepted, although the title is nearly the same.
    const refined = daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in a shorter block', focusMinutes: 30, daypart: 'evening', adaptsActionRef: 'k1', actionRefs: ['k1'] })] }, ctx);
    expect(refined.coach.actions).toHaveLength(1);
    expect(refined.coach.actions[0].parentActionId).toBe(partly.id);
    // The same shape again is a repeat, and so is a "refinement" that does not say what it refines.
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in a shorter block', focusMinutes: 120, daypart: 'evening', adaptsActionRef: 'k1', actionRefs: ['k1'] })] }, ctx).coach.actions).toEqual([]);
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in a shorter block', focusMinutes: 30, daypart: 'evening' })] }, ctx).coach.actions).toEqual([]);
    // After "it worked" there is nothing to refine: the same thing again stays a repeat.
    const helped = context({ actions: [worked(11, onLeads({ daypart: 'evening', focusMinutes: 120, strategyKey: 'close_open_loop|evening|long' }))], opportunities: [proposalSignal] });
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in a shorter block', focusMinutes: 30, daypart: 'evening', adaptsActionRef: 'k1', actionRefs: ['k1'] })] }, helped).coach.actions).toEqual([]);
  });

  it('never answered + clearer evidence today: the opportunity is renewed — an unanswered suggestion never silences it', () => {
    const unanswered = coachAction(onLeads({ status: 'expired', daypart: 'morning', strategyKey: 'close_open_loop|morning|short', originDayKey: '2026-10-11', createdAt: iso(11, '22:00'), closedAt: iso(12, '12:00'), updatedAt: iso(12, '12:00') }));
    const clearer = context({ actions: [unanswered], opportunities: [proposalSignal] });
    // The signal stays a candidate, and says which forms a re-offer may take.
    expect(clearer.opportunities[0].record).toMatchObject({ standing: 'unanswered', settled: false });
    expect(clearer.opportunities[0].record!.note).toContain('offer it again only in a different form');
    // A different form, a rewording, and — because refusing it was tried and refused exactly the action a
    // three-day displacement called for — even the same words: none is suppressed while the evidence is clearer.
    expect(daily({ actions: [leadsAction({ title: 'Protect the first half hour of the morning for the freelance proposal', actionType: 'protect_priority', focusMinutes: null, focusTask: null })] }, clearer).coach.actions).toHaveLength(1);
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal document in Google Docs' })] }, clearer).coach.actions).toHaveLength(1);
    expect(daily({ actions: [leadsAction()] }, clearer).coach.actions).toHaveLength(1);
    // With nothing clearer measured, the unanswered suggestion is simply not sent again.
    const same = context({ actions: [unanswered], opportunities: [{ ...proposalSignal, strength: 'possible', confidence: 0.45 }] });
    expect(same.opportunities[0].record).toMatchObject({ standing: 'unanswered', settled: true });
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal document in Google Docs' })] }, same).errors[0]).toContain('was suggested recently and never taken up');
  });

  it('after "did not help", the same item approached differently is a changed strategy — not a repeat', () => {
    const failed = worked(11, onLeads({ title: 'Finish drafting the freelance proposal in Google Docs', outcome: 'did_not_work', reasonCode: 'bad_timing', daypart: 'morning', strategyKey: 'close_open_loop|morning|short' }));
    const ctx = context({ actions: [failed], opportunities: [proposalSignal] });
    expect(ctx.opportunities.find((s) => s.kind === 'carried_over')?.record).toMatchObject({ standing: 'did_not_help', settled: false });
    // Another time of day, the same item, nearly the same words: this is what the record asks for.
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in the afternoon', actionType: 'change_timing', daypart: 'afternoon', focusMinutes: null, focusTask: null })] }, ctx).coach.actions).toHaveLength(1);
    // The same shape again is refused, and so is the same time of day in another guise.
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs again' })] }, ctx).coach.actions).toEqual([]);
    expect(daily({ actions: [leadsAction({ title: 'Finish drafting the freelance proposal in Google Docs in one block', actionType: 'focus_session', focusMinutes: 60 })] }, ctx).errors.join(' ')).toContain('because of bad timing');
  });

  it('a refusal about wording hands over the day\'s own words — and does not invite withdrawing a move that was found', () => {
    const ctx = buildCoachContext({
      now: NOW,
      reportDay: day,
      actions: [],
      memories: [],
      messages: [],
      priorities: PRIORITIES,
      knownThreads: ['SaaS MVP', 'Freelance Outreach'],
      config: DEFAULT_COACH_CONFIG,
      opportunities: [dashboardSignal],
      activityRefOf: (id) => (id === dashboard.id ? 'a1' : null),
      evidenceText: `${dashboard.title} ${dashboard.summary}`,
      workByPriority: { 'pr-saas': ['“Designing and implementing SaaS dashboard — Coded the dashboard interface and ran the build.”'] },
    });
    const reading = (state: string, item: string | null) => ({ matters: 'm', moved: 'm', patterns: 'none', candidates: [{ priorityId: 'pr-saas', state, item, nextMove: null, changes: null }], tried: 'nothing yet', candidate: 'c', verdict: 'act' });
    const saasAction = (over: Record<string, unknown>) => modelAction({ rationale: 'The dashboard was coded and built today, and nothing says it was finished.', actionType: 'focus_session', focusMinutes: 60, focusTask: null, priorityId: 'pr-saas', thread: 'SaaS MVP', metricKeys: ['priority.pr-saas.minutes'], activityRefs: ['a1'], ...over });
    // "Continue X": right target, wrong words. The model read something open there, so it is told to reword.
    const carryOn = daily({ decision: reading('open_item', 'the dashboard interface'), actions: [saasAction({ title: 'Continue implementing the SaaS dashboard in VS Code' })] }, ctx);
    expect(carryOn.coach.actions).toEqual([]);
    expect(carryOn.errors[0]).toContain('says to carry on, not what to finish');
    expect(carryOn.errors[0]).toContain("Today's record for it reads: “Designing and implementing SaaS dashboard — Coded the dashboard interface and ran the build.” — take the name of the piece from there");
    expect(carryOn.errors[0]).toContain('A move you found is reworded, not withdrawn over how it was phrased');
    // Naming the priority instead of the piece gets the same help.
    const project = daily({ decision: reading('open_item', 'the dashboard interface'), actions: [saasAction({ title: 'Use a morning block on the SaaS MVP', actionType: 'close_open_loop', focusMinutes: null })] }, ctx);
    expect(project.errors[0]).toContain('names the priority “Ship the SaaS MVP”, not a next action');
    expect(project.errors[0]).toContain('take the name of the piece from there');
    // The reworded move passes: it names the piece and the point to reach.
    expect(daily({ decision: reading('open_item', 'the dashboard interface'), actions: [saasAction({ title: 'Bring the dashboard interface to a passing build' })] }, ctx).coach.actions).toHaveLength(1);
    // Where the model did NOT read anything open and nothing clear was measured, silence stays the honest way out.
    const unsure = daily({ decision: reading('unclear', null), actions: [saasAction({ title: 'Continue implementing the SaaS dashboard in VS Code' })] }, ctx);
    expect(unsure.errors.join(' ')).not.toContain('reworded, not withdrawn');
    expect(unsure.errors.join(' ')).toContain('or return no action if nothing specific is open');
  });

  it('where only the user can say, the Coach asks: a prescription for a priority Reflect cannot place is refused', () => {
    const adrift = signal({ kind: 'displaced_priority', strength: 'clear', confidence: 0.9, priorityId: 'pr-leads', thread: null, item: null, days: 3, ask: true, metricKeys: ['priority.pr-leads.minutes'], activityIds: [], fits: ['clarify_priority', 'protect_priority'] });
    const ctx = context({ opportunities: [adrift] });
    expect(renderCoachSection(ctx)).toContain('"answer":"a question to the user (clarify_priority) — not a prescription"');
    const reading = (state: string) => ({ matters: 'm', moved: 'm', patterns: 'three days without it', candidates: [{ priorityId: 'pr-leads', state, item: null, nextMove: null, changes: null }], tried: 'nothing yet', candidate: 'c', verdict: 'act' });
    // Telling the user what to work on would be a guess about a priority that may no longer be current.
    const prescribed = daily({ decision: reading('displaced'), actions: [leadsAction({ title: 'Use one 45-minute Focus block to write three outreach messages', actionType: 'focus_session', focusMinutes: 45, activityRefs: [] })] }, ctx);
    expect(prescribed.coach.actions).toEqual([]);
    expect(prescribed.errors.join(' ')).toContain('Do not prescribe what to do for it: ask the user which it is');
    // The question is accepted — also when the model read the priority as finished, which is exactly what it cannot know.
    const question = { title: 'Decide whether generating freelance leads is still current; if it is, keep one block for it', actionType: 'clarify_priority', focusMinutes: null, focusTask: null, activityRefs: [], rationale: 'It has had no time for three tracked days while the time went elsewhere.' };
    for (const state of ['displaced', 'at_stopping_point', 'unclear']) expect(daily({ decision: reading(state), actions: [leadsAction(question)] }, ctx).coach.actions, state).toHaveLength(1);
    // Without that signal nothing changes: a question about a priority that is plainly progressing is still refused.
    expect(daily({ decision: reading('progressing'), actions: [leadsAction(question)] }, context({ opportunities: [dashboardSignal] })).coach.actions).toEqual([]);
  });

  it('an open loop the Coach inferred does not argue for itself for ever', () => {
    const inferred = (createdAt: string, text = 'Freelance proposal document in Google Docs remains open.') => memory(text, { kind: 'open_loop', source: 'coach', targetKey: 'p:pr-leads', createdAt, updatedAt: createdAt });
    const fresh = inferred(iso(11, '22:00'));
    const stale = (memories: CoachMemory[], actions: CoachAction[] = []) => staleOpenLoops(memories, actions, NOW.toISOString(), DEFAULT_COACH_CONFIG).map((m) => m.id);
    // Yesterday's reading still speaks; one from two weeks ago does not.
    expect(stale([fresh])).toEqual([]);
    const old = inferred(iso(1, '22:00'));
    expect(stale([old])).toEqual([old.id]);
    // An action about the same thing, suggested since, tracks it: the memory is not kept beside it.
    expect(stale([inferred(iso(9, '22:00'))], [worked(10, onLeads({}))])).toHaveLength(1);
    expect(stale([fresh], [worked(10, onLeads({}))])).toEqual([]); // suggested BEFORE the memory was written
    // What the USER said was left open is theirs: it never lapses here.
    expect(stale([memory('The client proposal was drafted and not sent.', { kind: 'open_loop', source: 'user', createdAt: iso(1, '22:00') })])).toEqual([]);
    // Lapsed inferences are kept out of the prompt, and handed over to be closed with the day's report.
    const ctx = context({ memories: [old, fresh] });
    expect(ctx.memories.map((m) => m.memory.id)).toEqual([fresh.id]);
    expect(ctx.staleMemoryIds).toEqual([old.id]);
    expect(renderCoachSection(ctx)).toContain("the Coach's own earlier reading — context to check against today's activities, never by itself evidence that something is still open");
  });
});

// ── The reasoning the model is asked for ────────────────────────────────────

describe('the questions the Coach is asked before it may answer', () => {
  const parts = buildDailyCoachParts(
    buildCoachContext({ now: NOW, reportDay: day, actions: [], memories: [], messages: [], priorities: [SAAS, LEADS], knownThreads: [], config: DEFAULT_COACH_CONFIG, opportunities: [] }),
  );

  it('asks, in order: intended, happened, patterns across days, what is unresolved per priority, what a step would change, what was tried', () => {
    const text = parts.systemInstruction;
    const order = ['1. matters — what this user INTENDED', '2. moved — what actually HAPPENED', '3. patterns — what has HELD ACROSS DAYS', '4. candidates — ONE entry for EVERY stated priority', '5. tried —', '6. candidate —', '7. verdict —'].map((s) => text.indexOf(s));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('changes: what that step would change that will not simply happen anyway');
    expect(text).toContain('One day is a circumstance; the same thing on consecutive tracked days is a pattern');
    expect(COACH_PROMPT_VERSION).toBe('reflect-coach-v4');
  });

  it('says when an intervention is worth making — and, as plainly, when it is not', () => {
    const text = parts.systemInstruction;
    expect(text).toContain('An action earns its place only when it would plausibly change what happens next.');
    expect(text).toContain('Switching matters only when it is attached to something that did not get done');
    expect(text).toContain('ask which is current (clarify_priority) instead of prescribing');
    expect(text).toContain('the main thread of every recent day, moving steadily and reaching its finishes: the user will continue it without being told');
    expect(text).toContain('one protected block that brings THAT item to a finish the user would recognise');
    expect(text).toContain('a priority that merely received fewer minutes than another one');
    // The clearest signal is not the most important one, and the record limits the form.
    expect(text).toContain('The clearest signal is not the most important one.');
    expect(text).toContain('ALREADY COVERED BY THE RECORD lists what was measured today and is NOT a candidate');
    // Nothing that held the Coach back before was loosened.
    expect(text).toContain('Never produce an action to fill a quota. Never produce none merely because the day was generally fine.');
    expect(text).toContain('A PROJECT IS NOT A NEXT ACTION');
  });

  it('the schema carries the two new answers, and still tolerates a response without them', () => {
    const schema = buildCoachResponseSchema(['pr-saas']) as { properties: { decision: { required: string[]; properties: { candidates: { items: { required: string[] } } } } } };
    expect(schema.properties.decision.required).toContain('patterns');
    expect(schema.properties.decision.properties.candidates.items.required).toEqual(['priorityId', 'state', 'item', 'nextMove', 'changes']);
  });
});
