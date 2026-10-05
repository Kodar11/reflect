import { describe, it, expect } from 'vitest';
import { OPPORTUNITY_RULES, detectOpportunities, orderSignals, outcomeSignals, renderOpportunities, workStateOf, type OpportunityInput } from '../../src/coach/CoachOpportunities';
import { buildSituations, type SituationDay } from '../../src/coach/CoachSituation';
import type { Metric, MetricSet, MetricUnit } from '../../src/reflection/ReflectionModels';
import { activity, iso } from '../reflection/helpers';
import { coachAction, memory, worked } from './helpers';

/**
 * Next-move signals: where an action COULD come from. Pure, deterministic,
 * and never a decision — these tests pin down when a signal is raised, and
 * just as much when it is not.
 */

const SAAS = { id: 'pr-saas', text: 'Ship the SaaS MVP' };
const CLIENT = { id: 'pr-client', text: 'Complete existing client work' };

const metric = (key: string, value: number | string, unit: MetricUnit, display: string, extra: Partial<Metric> = {}): Metric => ({
  key,
  label: key,
  value,
  unit,
  display,
  group: 'time',
  ...extra,
});
const set = (...metrics: Metric[]): MetricSet => Object.fromEntries(metrics.map((m) => [m.key, m]));
const minutes = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`);

/** A day with `saas` / `client` minutes linked, on top of `tracked` minutes in all. */
function dayMetrics(options: { tracked: number; saas?: number; client?: number; extra?: Metric[] }): MetricSet {
  const { tracked, saas = 0, client = 0 } = options;
  return set(
    metric('time.tracked_minutes', tracked, 'minutes', minutes(tracked)),
    ...(saas > 0 ? [metric('priority.pr-saas.minutes', saas, 'minutes', minutes(saas)), metric('priority.pr-saas.share', Math.round((saas / tracked) * 100), 'percent', `${Math.round((saas / tracked) * 100)}%`)] : []),
    ...(client > 0 ? [metric('priority.pr-client.minutes', client, 'minutes', minutes(client)), metric('priority.pr-client.share', Math.round((client / tracked) * 100), 'percent', `${Math.round((client / tracked) * 100)}%`)] : []),
    ...(options.extra ?? []),
  );
}

const input = (over: Partial<OpportunityInput>): OpportunityInput => ({ activities: [], metrics: {}, priorities: [SAAS, CLIENT], memories: [], ...over });
const kinds = (over: Partial<OpportunityInput>) => detectOpportunities(input(over)).map((s) => `${s.kind}:${s.strength}${s.priorityId ? `:${s.priorityId}` : ''}`);

describe('workStateOf — where a piece of work stood', () => {
  it('reads "explicitly unfinished" and "reached a stopping point" from how the activity was described', () => {
    expect(workStateOf({ title: 'Debugging the failing composite-index test', summary: null })).toBe('open');
    expect(workStateOf({ title: 'Drafting the budget justification', summary: 'Wrote part of it.' })).toBe('open');
    expect(workStateOf({ title: 'Client portal export job', summary: 'The export was still failing when the block ended.' })).toBe('open');
    expect(workStateOf({ title: 'Checking the assignment page', summary: 'The assignment is not submitted and is due tomorrow.' })).toBe('open');
    expect(workStateOf({ title: 'Implementing recurring invoices', summary: 'Completed the feature, merged the pull request and deployed it.' })).toBe('stopping_point');
    expect(workStateOf({ title: 'Final check and submission of Assignment 3', summary: null })).toBe('stopping_point');
    expect(workStateOf({ title: 'Publishing newsletter issue 48', summary: 'Published it to subscribers.' })).toBe('stopping_point');
    // A draft that the summary says was then sent is closed, not open.
    expect(workStateOf({ title: 'Drafting the weekly client update', summary: 'Wrote the update and sent it.' })).toBe('stopping_point');
  });

  it('an ordinary activity verb says what was done, not whether it is done', () => {
    for (const title of ['Developing and testing the SaaS dashboard component', 'Studying graph algorithms for the midterm', 'Reviewing lecture notes', 'Implementing the audit report filters', 'Project X sync engine']) {
      expect(workStateOf({ title, summary: null }), title).toBe('unknown');
    }
  });
});

describe('detectOpportunities — left off', () => {
  const tested = activity(12, '17:00', 60, { title: 'Debugging the SaaS dashboard component', summary: 'Two of the chart tests were still failing at the end.', thread: 'SaaS MVP', priorityId: 'pr-saas' });

  it('names where a priority stood when the day ended, and what to cite for it', () => {
    const [signal] = detectOpportunities(input({ activities: [tested], metrics: dayMetrics({ tracked: 300, saas: 180 }), priorities: [SAAS] }));
    expect(signal).toMatchObject({
      kind: 'left_off',
      strength: 'clear',
      priorityId: 'pr-saas',
      thread: 'SaaS MVP',
      metricKeys: ['priority.pr-saas.minutes'],
      activityIds: [tested.id],
    });
    expect(signal.summary).toContain('last stood at “Debugging the SaaS dashboard component”');
    expect(signal.summary).toContain('its description says it was not finished');
    expect(signal.fits).toContain('close_open_loop');
  });

  it('is only "possible" — and states evidence, not a verdict — when nothing says the work is unfinished', () => {
    const ongoing = activity(12, '17:00', 60, { title: 'Developing and testing the SaaS dashboard component', priorityId: 'pr-saas' });
    const [signal] = detectOpportunities(input({ activities: [ongoing], metrics: dayMetrics({ tracked: 300, saas: 180 }), priorities: [SAAS] }));
    expect(signal).toMatchObject({ kind: 'left_off', strength: 'possible' });
    expect(signal.summary).toContain('Nothing states whether it was finished.');
    // A signal is evidence: it carries how clearly it was measured, and no advice.
    expect(signal.confidence).toBeLessThan(0.5);
    expect(signal.summary).not.toMatch(/should|needs no advice|not a loose end/i);
    // Too brief a stretch to call anything.
    const glance = activity(12, '17:00', 3, { title: 'Debugging the dashboard', priorityId: 'pr-saas' });
    const earlier = activity(12, '09:00', 40, { title: 'Dashboard work', priorityId: 'pr-saas' });
    expect(kinds({ activities: [earlier, glance], metrics: dayMetrics({ tracked: 300, saas: 43 }), priorities: [SAAS] })).toEqual(['left_off:possible:pr-saas']);
  });

  it('raises nothing when the last piece of work reached a stopping point', () => {
    const shipped = activity(12, '17:00', 60, { title: 'Finishing and deploying invoice templates', summary: 'Merged and deployed to production.', priorityId: 'pr-saas' });
    expect(kinds({ activities: [shipped], metrics: dayMetrics({ tracked: 300, saas: 180 }), priorities: [SAAS] })).toEqual([]);
  });
});

describe('detectOpportunities — displaced priority', () => {
  const recent = (days: number, of = 5) => [
    metric('recent.active_days', of, 'count', String(of)),
    metric('recent.priority.pr-saas.active_days', days, 'count', `${days} of ${of}`, { priorityId: 'pr-saas' }),
    metric('recent.priority.pr-saas.last_day', 'Fri, Oct 9', 'text', 'Fri, Oct 9', { priorityId: 'pr-saas' }),
  ];

  it('one day without an actively worked priority is a circumstance: possible, never clear', () => {
    const signals = detectOpportunities(input({ metrics: dayMetrics({ tracked: 320, client: 300, extra: recent(4) }), priorities: [SAAS] }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'displaced_priority', strength: 'possible', priorityId: 'pr-saas' });
    expect(signals[0].summary).toBe('“Ship the SaaS MVP” got no linked time today; it was worked on 4 of 5 recent days (last on Fri, Oct 9). That is one day so far.');
    expect(signals[0].metricKeys).toEqual(['recent.priority.pr-saas.active_days', 'recent.priority.pr-saas.last_day', 'time.tracked_minutes']);
    expect(signals[0].fits).toEqual(['protect_priority', 'focus_session', 'clarify_priority']);
  });

  it('the same displacement on consecutive tracked days is a pattern: clear, and clearer the longer it lasts', () => {
    const clientDay = (day: number): SituationDay => ({
      dayKey: `2026-10-${String(day).padStart(2, '0')}`,
      dayLabel: `Oct ${day}`,
      activities: [activity(day, '09:00', 240, { title: 'Acme portal support', priorityId: 'pr-client' })],
    });
    const saasDay: SituationDay = { dayKey: '2026-10-09', dayLabel: 'Oct 9', activities: [activity(9, '09:00', 120, { title: 'Implementing recurring invoices', priorityId: 'pr-saas' })] };
    const metrics = dayMetrics({ tracked: 320, client: 300, extra: recent(2) });
    const today = [activity(12, '09:00', 300, { title: 'Acme portal support', priorityId: 'pr-client' })];
    const at = (recentDays: SituationDay[]) => {
      const situations = buildSituations({ priorities: [SAAS, CLIENT], activities: today, metrics, recentDays, actions: [] });
      return detectOpportunities(input({ activities: today, metrics, situations })).find((s) => s.kind === 'displaced_priority')!;
    };
    const first = at([saasDay]);
    expect(first).toMatchObject({ strength: 'possible' });
    const second = at([clientDay(11), saasDay]);
    expect(second).toMatchObject({ strength: 'clear' });
    expect(second.summary).toContain('That is 2 tracked days in a row without it.');
    const third = at([clientDay(11), clientDay(10), saasDay]);
    expect(third.summary).toContain('That is 3 tracked days in a row without it.');
    expect(third.confidence).toBeGreaterThan(second.confidence);
    expect(second.confidence).toBeGreaterThan(first.confidence);
  });

  it('is only possible when today was merely well below the priority\'s own average share', () => {
    const below = dayMetrics({
      tracked: 400,
      saas: 40,
      extra: [...recent(5), metric('baseline.priority.pr-saas.share', 45, 'percent', '45%', { priorityId: 'pr-saas' })],
    });
    expect(kinds({ metrics: below, priorities: [SAAS] })).toContain('displaced_priority:possible:pr-saas');
  });

  it('says nothing on the first day, on a thin day, or about a priority that had its usual share', () => {
    // No history: Reflect cannot know what "usual" is.
    expect(kinds({ metrics: dayMetrics({ tracked: 320, client: 300 }), priorities: [SAAS] })).toEqual([]);
    // Too little tracked to speak about shares.
    expect(kinds({ metrics: dayMetrics({ tracked: OPPORTUNITY_RULES.minTrackedMinutes - 1, extra: recent(4) }), priorities: [SAAS] })).toEqual([]);
    const usual = dayMetrics({ tracked: 400, saas: 170, extra: [...recent(5), metric('baseline.priority.pr-saas.share', 45, 'percent', '45%')] });
    expect(kinds({ metrics: usual, priorities: [SAAS] }).filter((k) => k.startsWith('displaced'))).toEqual([]);
  });

  it('a stated priority that has gone quiet raises the question of whether it is still current', () => {
    const quiet = (days: number, of: number) =>
      dayMetrics({ tracked: 300, client: 280, extra: [metric('recent.active_days', of, 'count', String(of)), metric('recent.priority.pr-saas.active_days', days, 'count', `${days} of ${of}`)] });
    // Displacement gets clearer the longer it lasts, not weaker: absent from the recent days is a measured fact.
    const [signal] = detectOpportunities(input({ metrics: quiet(0, 4), priorities: [SAAS] }));
    expect(signal).toMatchObject({ kind: 'displaced_priority', strength: 'clear' });
    expect(signal.fits[0]).toBe('clarify_priority');
    expect(signal.summary).toContain('either it needs a protected block, or it is no longer current — only the user can say which');
    expect(kinds({ metrics: quiet(1, 3), priorities: [SAAS] })).toEqual(['displaced_priority:clear:pr-saas']);
    // One day without it, and nothing known about where it stood: only "possible".
    expect(kinds({ metrics: quiet(1, 2), priorities: [SAAS] })).toEqual(['displaced_priority:possible:pr-saas']);
    // …unless it is known to have been left unfinished.
    expect(kinds({ metrics: quiet(1, 2), priorities: [SAAS], lastKnown: { 'pr-saas': { title: 'Implementing recurring invoices', summary: 'Two tests were still failing.', dayLabel: 'Mon' } } })).toEqual(['displaced_priority:clear:pr-saas']);
    // Never worked on at all in a short history: nothing to say yet.
    expect(kinds({ metrics: quiet(0, 2), priorities: [SAAS] })).toEqual([]);
  });

  it('tells "displaced" from "done": a priority whose last work was submitted is not something to protect time for', () => {
    const metrics = dayMetrics({ tracked: 320, client: 300, extra: recent(3) });
    const unfinished = detectOpportunities(input({ metrics, priorities: [SAAS], lastKnown: { 'pr-saas': { title: 'Implementing recurring invoices', summary: 'Two tests were still failing.', dayLabel: 'Fri, Oct 9' } } }));
    expect(unfinished[0]).toMatchObject({ strength: 'clear', fits: ['protect_priority', 'focus_session', 'clarify_priority'] });
    expect(unfinished[0].summary).toContain('It was left unfinished at “Implementing recurring invoices”.');

    const done = detectOpportunities(input({ metrics, priorities: [SAAS], lastKnown: { 'pr-saas': { title: 'Submitting Assignment 3', summary: 'All tests passed; submitted on the course site.', dayLabel: 'Fri, Oct 9' } } }));
    expect(done[0]).toMatchObject({ kind: 'displaced_priority', strength: 'possible', fits: ['clarify_priority'] });
    expect(done[0].summary).toContain('reads as finished — it may simply be done; only the user can say.');
  });
});

describe('detectOpportunities — momentum, fragmentation, load, unlinked time, open loops', () => {
  it('momentum is never more than "possible", and is the weakest signal there is', () => {
    const steady = activity(12, '09:00', 120, { title: 'Finishing and deploying tax settings', priorityId: 'pr-saas' });
    const signals = detectOpportunities(
      input({
        activities: [steady],
        metrics: dayMetrics({ tracked: 300, saas: 180, extra: [metric('recent.priority.pr-saas.active_days', 6, 'count', '6 of 7')] }),
        priorities: [SAAS],
      }),
    );
    expect(signals.map((s) => `${s.kind}:${s.strength}`)).toEqual(['momentum:possible']);
    expect(signals[0].summary).toBe('“Ship the SaaS MVP” had 3h 0m today and was worked on 6 of 7 recent days.');
    expect(signals[0].confidence).toBeLessThan(0.4);
    expect(signals[0].fits).toEqual(['continue_behavior', 'protect_priority']);
  });

  it('fragmentation is measured against the user\'s own norm', () => {
    const switching = (perHour: number, baseline: number | null) =>
      dayMetrics({
        tracked: 360,
        extra: [
          metric('behavior.switches_per_hour', perHour, 'per_hour', `${perHour} per hour`),
          metric('daypart.afternoon.switches', 14, 'count', '14'),
          ...(baseline === null ? [] : [metric('baseline.behavior.switches_per_hour', baseline, 'per_hour', `${baseline} per hour`)]),
        ],
      });
    expect(kinds({ metrics: switching(4, 0.8), priorities: [] })).toEqual(['fragmentation:clear']);
    // The same switching is normal for someone whose days always look like that.
    expect(kinds({ metrics: switching(4, 3.6), priorities: [] })).toEqual([]);
    // Without a baseline it can only be "possible".
    expect(kinds({ metrics: switching(4, null), priorities: [] })).toEqual(['fragmentation:possible']);
    expect(kinds({ metrics: switching(1.2, 0.4), priorities: [] })).toEqual([]);
    const [signal] = detectOpportunities(input({ metrics: switching(4, 0.8), priorities: [] }));
    expect(signal.summary).toBe("Today had 4 per hour context switches; this user's recent average is 0.8 per hour. The afternoon had the most (14).");
    expect(signal.fits[0]).toBe('reduce_fragmentation');
  });

  it('rest is only supported by a run of long days — one long day is not a signal', () => {
    const long = (recentLongDays: number) =>
      dayMetrics({
        tracked: 640,
        extra: Array.from({ length: recentLongDays }, (_, i) => metric(`recent.2026-10-0${i + 5}.tracked_minutes`, 630, 'minutes', '10h 30m')),
      });
    expect(kinds({ metrics: long(1), priorities: [] })).toEqual([]);
    expect(kinds({ metrics: long(3), priorities: [] })).toEqual(['sustained_load:possible']);
    expect(detectOpportunities(input({ metrics: long(3), priorities: [] }))[0].fits).toEqual(['rest']);
  });

  it('time linked to no stated priority is flagged as something Reflect cannot interpret', () => {
    const unlinked = dayMetrics({ tracked: 300, extra: [metric('priority.unlinked_minutes', 260, 'minutes', '4h 20m')] });
    const [signal] = detectOpportunities(input({ metrics: unlinked, priorities: [SAAS] }));
    expect(signal).toMatchObject({ kind: 'unlinked_time', strength: 'possible', fits: ['clarify_priority'] });
    expect(signal.summary).toContain('Reflect cannot tell which');
    // With no stated priorities there is nothing to be "unlinked" from.
    expect(kinds({ metrics: unlinked, priorities: [] })).toEqual([]);
  });

  it('raises an open loop the user stated while it is recent — never the Coach\'s own earlier inference', () => {
    const loop = memory('The client proposal was drafted and not sent.', { kind: 'open_loop', source: 'user', targetKey: 'p:pr-client', createdAt: iso(10, '22:00') });
    // What the Coach itself concluded yesterday is context, not a measurement: it must not argue for today's action.
    expect(detectOpportunities(input({ memories: [{ ...loop, source: 'coach' }], openLoopsSince: iso(8, '00:00') }))).toEqual([]);
    const fresh = detectOpportunities(input({ memories: [loop], openLoopsSince: iso(8, '00:00') }));
    expect(fresh).toMatchObject([{ kind: 'open_loop', priorityId: 'pr-client', fits: ['close_open_loop', 'drop'] }]);
    expect(detectOpportunities(input({ memories: [loop], openLoopsSince: iso(11, '00:00') }))).toEqual([]);
    // A constraint the user stated is memory, not an open loop.
    expect(detectOpportunities(input({ memories: [memory('Mornings are classes until 11')] }))).toEqual([]);
  });
});

describe('detectOpportunities — the whole day', () => {
  it('a day with nothing open, displaced or fragmented yields no signal at all', () => {
    const shipped = activity(12, '09:00', 150, { title: 'Finishing and deploying client portal links', summary: 'Merged and deployed.', priorityId: 'pr-saas' });
    const sent = activity(12, '13:30', 110, { title: 'Delivering the role permissions screen', summary: 'Deployed it and sent the weekly update.', priorityId: 'pr-client' });
    const metrics = dayMetrics({ tracked: 260, saas: 150, client: 110, extra: [metric('behavior.switches_per_hour', 0.3, 'per_hour', '0.3 per hour')] });
    expect(detectOpportunities(input({ activities: [shipped, sent], metrics }))).toEqual([]);
    expect(renderOpportunities([], () => null)).toContain('None measured today');
    expect(renderOpportunities([], () => null)).toContain('the right answer is no action');
  });

  it('tolerates missing data: no metrics, no activities, no priorities', () => {
    expect(detectOpportunities({ activities: [], metrics: {}, priorities: [], memories: [] })).toEqual([]);
    expect(detectOpportunities(input({ metrics: dayMetrics({ tracked: 0 }) }))).toEqual([]);
  });

  it('orders by how clearly each was measured, gives every priority its turn, caps the list, and is deterministic', () => {
    // (The description states the open state. "Debugging" alone names an activity — see "an activity is not a state".)
    const debugging = activity(12, '17:00', 60, { title: 'Debugging the export job', summary: 'The export was still failing at the end.', priorityId: 'pr-client' });
    const metrics = dayMetrics({
      tracked: 400,
      client: 380,
      extra: [
        metric('recent.active_days', 5, 'count', '5'),
        metric('recent.priority.pr-saas.active_days', 4, 'count', '4 of 5', { priorityId: 'pr-saas' }),
        metric('recent.priority.pr-client.active_days', 5, 'count', '5 of 5', { priorityId: 'pr-client' }),
        metric('behavior.switches_per_hour', 5, 'per_hour', '5 per hour'),
      ],
    });
    const run = () => detectOpportunities(input({ activities: [debugging], metrics }));
    // The unfinished work and the fragmentation come first; one day without the other priority is only "possible";
    // the client priority's second line (momentum) waits until every target has had one.
    expect(run().map((s) => `${s.kind}:${s.strength}`)).toEqual(['left_off:clear', 'fragmentation:possible', 'displaced_priority:possible', 'momentum:possible']);
    expect(run()).toEqual(run());
    expect(run().length).toBeLessThanOrEqual(OPPORTUNITY_RULES.maxSignals);
  });

  it('renders each signal with what to cite, using the day\'s own activity aliases', () => {
    const debugging = activity(12, '17:00', 60, { title: 'Debugging the export job', priorityId: 'pr-client' });
    const text = renderOpportunities(detectOpportunities(input({ activities: [debugging], metrics: dayMetrics({ tracked: 300, client: 200 }), priorities: [CLIENT] })), (id) => (id === debugging.id ? 'a7' : null));
    expect(text).toContain('a candidate to weigh, not an instruction');
    expect(text).toContain('"signal":"left_off"');
    expect(text).toContain('"cite":{"metricKeys":["priority.pr-client.minutes"],"activityRefs":["a7"]}');
    // The raw activity id never reaches the model.
    expect(text).not.toContain(debugging.id);
  });
});

describe('detectOpportunities — finished work going quiet is completion', () => {
  it('stays "it may simply be done" however many days pass, and never becomes a clear displacement', () => {
    const submitted: SituationDay = { dayKey: '2026-10-09', dayLabel: 'Oct 9', activities: [activity(9, '10:00', 40, { title: 'Submitting Assignment 3', summary: 'Submitted on the course site.', priorityId: 'pr-saas' })] };
    const other = (n: number): SituationDay => ({ dayKey: `2026-10-${n}`, dayLabel: `Oct ${n}`, activities: [activity(n, '09:00', 200, { title: 'Client portal support', priorityId: 'pr-client' })] });
    const today = [activity(12, '09:00', 300, { title: 'Client portal support', priorityId: 'pr-client' })];
    const metrics = dayMetrics({
      tracked: 320,
      client: 300,
      extra: [metric('recent.active_days', 3, 'count', '3'), metric('recent.priority.pr-saas.active_days', 1, 'count', '1 of 3', { priorityId: 'pr-saas' }), metric('recent.priority.pr-saas.last_day', 'Fri, Oct 9', 'text', 'Fri, Oct 9')],
    });
    const situations = buildSituations({ priorities: [SAAS, CLIENT], activities: today, metrics, recentDays: [other(11), other(10), submitted], actions: [] });
    expect(situations[0].untouchedStreak).toBe(3);
    const signal = detectOpportunities(
      input({ activities: today, metrics, situations, lastKnown: { 'pr-saas': { title: 'Submitting Assignment 3', summary: 'Submitted on the course site.', dayLabel: 'Fri, Oct 9' } } }),
    ).find((s) => s.kind === 'displaced_priority' && s.priorityId === 'pr-saas')!;
    expect(signal).toMatchObject({ strength: 'possible', fits: ['clarify_priority'] });
    expect(signal.summary).toContain('it may simply be done; only the user can say');
    expect(signal.summary).not.toContain('days in a row');
  });

  it('"Monthly invoicing" names a chore — it does not say anything was sent', () => {
    expect(workStateOf({ title: 'Monthly invoicing', summary: 'Prepared client invoices; 2 drafts, 0 sent.' })).toBe('open');
    expect(workStateOf({ title: 'Monthly invoicing', summary: 'Prepared client invoices.' })).toBe('unknown');
  });
});

describe('detectOpportunities — carried over, interleaving', () => {
  const day = (n: number, title: string, summary: string | null = null): SituationDay => ({
    dayKey: `2026-10-${String(n).padStart(2, '0')}`,
    dayLabel: `Oct ${n}`,
    activities: [activity(n, '17:00', 60, { title, summary, priorityId: 'pr-saas', thread: 'SaaS MVP' })],
  });
  const metrics = dayMetrics({ tracked: 300, saas: 180 });

  it('the same piece of work ending the day unfinished, day after day, is its own signal', () => {
    const today = [activity(12, '17:00', 60, { title: 'Investigating the authentication API issue', priorityId: 'pr-saas', thread: 'SaaS MVP' })];
    const situations = buildSituations({
      priorities: [SAAS],
      activities: today,
      metrics,
      recentDays: [day(11, 'Investigating authentication API errors'), day(10, 'Testing authentication API responses')],
      actions: [],
    });
    expect(situations[0].carriedOver).toMatchObject({ days: 3, item: 'Investigating the authentication API issue' });
    const signal = detectOpportunities(input({ activities: today, metrics, priorities: [SAAS], situations })).find((s) => s.kind === 'carried_over')!;
    expect(signal).toMatchObject({ strength: 'clear', priorityId: 'pr-saas', activityIds: [today[0].id] });
    expect(signal.summary).toBe('“Investigating the authentication API issue” has been the last work toward “Ship the SaaS MVP” on 3 tracked days in a row without reading as finished.');
    expect(signal.fits).toContain('change_approach');
  });

  it('is not raised when yesterday ended on something else, or on a finish', () => {
    const today = [activity(12, '17:00', 60, { title: 'Investigating the authentication API issue', priorityId: 'pr-saas' })];
    const carried = (recentDays: SituationDay[]) => buildSituations({ priorities: [SAAS], activities: today, metrics, recentDays, actions: [] })[0].carriedOver;
    expect(carried([day(11, 'Designing the dashboard layout')])).toBeNull();
    expect(carried([day(11, 'Authentication API issue', 'Fixed, merged and deployed.')])).toBeNull();
    expect(carried([])).toBeNull();
  });

  it('two activities spread over the same stretch are reported as interleaved — and as far as the record goes, no further', () => {
    const support = activity(12, '09:00', 92, { title: 'Client portal support', priorityId: 'pr-client', thread: 'Client Portal' });
    const invoices = activity(12, '09:10', 72, { title: 'Recurring invoices', priorityId: 'pr-saas', thread: 'SaaS MVP' });
    // Each one's span is far longer than the time spent in it.
    const spread = [
      { ...support, endedAt: iso(12, '11:44') },
      { ...invoices, endedAt: iso(12, '11:33') },
    ];
    const signal = detectOpportunities(input({ activities: spread, metrics: dayMetrics({ tracked: 164, saas: 72, client: 92 }) })).find((s) => s.kind === 'fragmentation')!;
    expect(signal).toMatchObject({ strength: 'possible', activityIds: [support.id, invoices.id] });
    expect(signal.summary).toContain('ran over the same stretch');
    expect(signal.summary).toContain('How finely it broke up is not recorded.');
    // Two solid blocks one after the other are not interleaved.
    const solid = [activity(12, '09:00', 90, { title: 'Client portal support', priorityId: 'pr-client' }), activity(12, '10:30', 70, { title: 'Recurring invoices', priorityId: 'pr-saas' })];
    expect(detectOpportunities(input({ activities: solid, metrics: dayMetrics({ tracked: 160, saas: 70, client: 90 }) })).filter((s) => s.kind === 'fragmentation')).toEqual([]);
  });
});

describe('signals are evidence — ordering and earlier outcomes', () => {
  it('no priority drops off the list because another produced more lines', () => {
    const base = { strength: 'possible' as const, thread: null, summary: 's', metricKeys: [], activityIds: [], fits: [] };
    const ordered = orderSignals([
      { ...base, kind: 'left_off', confidence: 0.75, priorityId: 'a' },
      { ...base, kind: 'carried_over', confidence: 0.7, priorityId: 'a' },
      { ...base, kind: 'momentum', confidence: 0.35, priorityId: 'a' },
      { ...base, kind: 'left_off', confidence: 0.4, priorityId: 'b' },
    ]);
    expect(ordered.map((s) => `${s.priorityId}:${s.kind}`)).toEqual(['a:left_off', 'b:left_off', 'a:carried_over', 'a:momentum']);
  });

  it('what happened to an earlier suggestion becomes a signal that keeps "could not happen" apart from "did not help"', () => {
    const label = (code: string) => code.replace('_', ' ');
    const helped = worked(11, { title: 'Finish the tax settings check', priorityId: 'pr-saas', targetKey: 'p:pr-saas' });
    const failed = worked(11, { title: 'Run a morning block on invoices', outcome: 'did_not_work', reasonCode: 'bad_timing', targetKey: 'p:pr-saas' });
    const blocked = coachAction({ title: 'Return to recurring invoices', status: 'closed', execution: 'not_done', executionSource: 'user', reasonCode: 'external_constraint', targetKey: 'p:pr-saas' });
    const rejected = coachAction({ title: 'Review lecture notes', status: 'rejected', reasonCode: 'not_relevant' });
    const signals = outcomeSignals(
      [helped, failed, blocked, rejected].map((action, i) => ({ ref: `k${i + 1}`, action })),
      label,
    );
    expect(signals.map((s) => [s.kind, s.actionRefs?.[0], s.priorityId])).toEqual([
      ['tried_before', 'k1', 'pr-saas'],
      ['tried_before', 'k2', 'pr-saas'],
      ['tried_before', 'k3', 'pr-saas'],
    ]);
    expect(signals[0].summary).toContain('whether there is anything new to use it ON is a separate question');
    expect(signals[1].summary).toContain('did not help (the reason given: bad timing)');
    expect(signals[1].fits).toEqual(['change_timing', 'change_approach', 'experiment']);
    // Circumstances prevented it: not a failed strategy, and nothing to "adapt".
    expect(signals[2].summary).toContain('That says nothing against the action');
    expect(signals[2].fits).toEqual(['protect_priority', 'focus_session', 'close_open_loop']);
    expect(renderOpportunities(signals, () => null)).toContain('"actionRefs":["k2"]');
  });
});
