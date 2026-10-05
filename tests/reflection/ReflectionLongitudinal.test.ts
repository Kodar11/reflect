import { describe, it, expect } from 'vitest';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { ReflectionHistory } from '../../src/reflection/ReflectionHistory';
import { continuityOf, identityKeyOf, insightPattern, insightSubject, type PriorInsight } from '../../src/reflection/ReflectionIdentity';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG, type Metric, type ReflectionActivity, type ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';
import { validateReflectionOutput } from '../../src/reflection/ReflectionValidator';
import { modelChat } from '../coach/helpers';
import { TAXONOMY, activity, focusSession, iso, local, makeReflectionHarness, modelInsight, modelReflection, seedThreads, type HarnessOptions } from './helpers';

/**
 * Reflection across time: what vanished, what was carried, what closed, what
 * was already said — and that corrections, history and regeneration hold
 * together. One user throughout: a founder with a SaaS of their own and
 * freelance client work on the side.
 *
 * Oct 5 2026 is a Monday. W41 = Oct 5–11, W42 = Oct 12–18, W43 = Oct 19–25.
 */

const saas = (day: number, hhmm = '09:00', minutes = 120, o: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, { title: 'Build SaaS billing page', thread: 'SaaS', ...o });
const client = (day: number, hhmm = '13:00', minutes = 60, o: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, { title: 'Client dashboard fixes', thread: 'Freelance', ...o });
const learning = (day: number, hhmm = '16:00', minutes = 60) =>
  activity(day, hhmm, minutes, { title: 'Study database indexing', thread: 'Database learning', contextId: 'learning', intentId: 'intent_research', qualityId: 'quality_routine' });

const W41 = [5, 6, 7, 8, 9];
const W42 = [12, 13, 14, 15, 16];
const week41 = periodContaining('week', local(7));
const week42 = periodContaining('week', local(14));
const dayOf = (d: number) => periodContaining('day', local(d, '12:00'));

function founder(options: HarnessOptions & { activities: ReflectionActivity[] }) {
  const h = makeReflectionHarness({ now: local(19, '09:00'), priorities: ['Launch my SaaS', 'Freelance client work'], ...options });
  const [pSaas, pFree] = h.service.syncPriorities();
  const link = () => seedThreads(h.repo, h.activities, { SaaS: pSaas.id, Freelance: pFree.id });
  link();
  const dataset = (period: ReflectionPeriod, coveredUntil = period.end) => h.metrics.computeDataset(period, coveredUntil, h.service.syncPriorities());
  /** Generate the closed day `d` the morning after it. */
  const reflectOnDay = async (d: number, ...responses: unknown[]) => {
    h.setNow(local(d + 1, '08:00'));
    h.gemini.push(...responses);
    return h.service.generate(dayOf(d), { trigger: 'scheduled' });
  };
  return { ...h, saasId: pSaas.id, freeId: pFree.id, link, dataset, reflectOnDay };
}

/** SaaS and client work every weekday of W41; only client work in W42. */
const saasThenNothing = () => [
  ...W41.flatMap((d) => [saas(d), client(d)]),
  learning(5),
  learning(7),
  learning(9),
  ...W42.flatMap((d) => [client(d, '09:00', 180)]),
];

// ─────────────────────────────────────────────────────────────────────────────

describe('historical comparison — over the union of both periods', () => {
  it('2. sees work that vanished: a period is compared with what the previous one contained, not only with itself', async () => {
    const h = founder({ activities: saasThenNothing() });
    const { metrics, changes } = await h.dataset(week42);

    // The SaaS priority is still stated, so its absence is a measured zero…
    expect(metrics[`priority.${h.saasId}.minutes`].value).toBe(0);
    expect(metrics[`prev.priority.${h.saasId}.minutes`].display).toBe('10h');
    // …and a project outside any priority, absent this week, is NOT silently dropped.
    expect(metrics['thread.database-learning.minutes']).toMatchObject({ value: 0 });
    expect(metrics['prev.thread.database-learning.minutes'].display).toBe('3h');
    expect(metrics['delta.thread.database-learning.minutes'].display).toBe('-3h (-100%)');

    // The disappearance is classified by the backend, with the numbers it rests on.
    expect(changes).toContainEqual(expect.objectContaining({ entity: 'priority', key: h.saasId, change: 'vanished', previousMinutes: 600, nowMinutes: 0, explained: null }));
    expect(changes).toContainEqual(expect.objectContaining({ entity: 'thread', label: 'Database learning', change: 'vanished' }));
    expect(metrics[`change.priority.${h.saasId}`]).toMatchObject({
      value: 'vanished',
      display: 'no longer present: 10h in the previous week, 0m now',
      priorityId: h.saasId,
      // Where to look: the week that still held it.
      range: { start: week41.start, end: week41.end },
    });
    // What took its place is seen too — once, as the priority, not again as its project.
    expect(changes).toContainEqual(expect.objectContaining({ entity: 'priority', key: h.freeId, change: 'increased' }));
    expect(changes.filter((c) => c.entity === 'thread').map((c) => c.label)).toEqual(['Database learning']);
  });

  it('2b. ordinary fluctuation is not a change, and nothing is claimed without a comparable period or mid-period', async () => {
    // 2h vs 2h20m of SaaS: a difference, not a change.
    const steady = founder({ activities: [...W41.flatMap((d) => [saas(d), client(d)]), ...W42.flatMap((d) => [saas(d, '09:00', 140), client(d)])] });
    expect((await steady.dataset(week42)).changes).toEqual([]);

    // The first tracked week has nothing to be compared with.
    expect((await steady.dataset(week41)).changes).toEqual([]);

    // A week still running: its totals are not compared with a finished week.
    const running = founder({ activities: [...W41.flatMap((d) => [saas(d), client(d)]), client(12, '09:00', 180), client(13, '09:00', 180)], now: local(13, '18:00') });
    const partial = await running.dataset(week42, local(13, '18:00').toISOString());
    expect(partial.changes).toEqual([]);
    expect(Object.keys(partial.metrics).filter((k) => k.startsWith('change.'))).toEqual([]);
  });

  it('2c. for a single day, alternating between projects is not a disappearance — breaking a habit is', async () => {
    // SaaS on Mon/Wed/Fri, client work on Tue/Thu: every day one of them is "gone" compared with yesterday.
    const alternating = founder({ activities: [saas(5), client(6, '09:00', 120), saas(7), client(8, '09:00', 120), saas(9)], now: local(9, '08:00') });
    const thursday = await alternating.dataset(dayOf(8));
    expect(thursday.metrics[`prev.priority.${alternating.saasId}.minutes`].display).toBe('2h'); // the comparison is still there to cite
    expect(thursday.changes).toEqual([]); // …but nothing "vanished", and nothing "came back"

    // SaaS every day for a week, then a Monday without it: that is a habit broken —
    // measured against the tracked days, although the calendar day before (Sunday) held nothing.
    const habit = founder({ activities: [...W41.map((d) => saas(d)), ...W41.map((d) => client(d)), client(12, '09:00', 180)], now: local(13, '09:00') });
    const broken = await habit.dataset(dayOf(12));
    expect(broken.hasPreviousComparison).toBe(false);
    expect(broken.changes).toEqual([expect.objectContaining({ entity: 'priority', key: habit.saasId, change: 'vanished', presentIn: 5, outOf: 5, previousMinutes: 120 })]);
    expect(broken.metrics[`change.priority.${habit.saasId}`]).toMatchObject({
      label: 'Change in “Launch my SaaS” vs your recent tracked days',
      display: 'no longer present: worked on 5 of the previous 5 tracked days (2h on such a day), 0m today',
    });
  });

  it('3. completed work disappears as completed — never as neglected, and never as still open', async () => {
    const h = founder({ activities: saasThenNothing() });
    h.setNow(local(11, '12:00')); // Sunday of W41: the user ships and marks it done
    h.service.setPriorityStatus(h.saasId, 'completed');
    h.setNow(local(19, '09:00'));

    const { metrics, changes, carried, trajectories, priorities } = await h.dataset(week42);
    expect(priorities.map((p) => p.id)).toEqual([h.freeId]); // it did not apply during W42
    expect(changes).toContainEqual(expect.objectContaining({ entity: 'priority', key: h.saasId, change: 'vanished', explained: 'completed' }));
    expect(metrics[`change.priority.${h.saasId}`].display).toBe('no longer present: 10h in the previous week, 0m now; you marked this priority completed');
    expect(trajectories!.find((t) => t.key === `p:${h.saasId}`)).toMatchObject({ status: 'completed' });
    // It closed last week; this week it is neither open nor news.
    expect(carried!.filter((c) => c.key === `p:${h.saasId}`)).toEqual([]);
    expect(metrics['carry.open_count']).toBeUndefined();
  });

  it('6. an abandoned priority is the user\'s decision, not a failure', async () => {
    const h = founder({ activities: saasThenNothing() });
    h.setNow(local(11, '12:00'));
    h.profiles.updateProfile({ priorities: ['Freelance client work'] }); // SaaS removed from the profile
    h.service.notifyDataChanged({ kind: 'profile' });
    h.setNow(local(19, '09:00'));

    const { changes, trajectories, carried } = await h.dataset(week42);
    expect(changes).toContainEqual(expect.objectContaining({ key: h.saasId, change: 'vanished', explained: 'dropped' }));
    expect(trajectories!.find((t) => t.key === `p:${h.saasId}`)!.status).toBe('dropped');
    expect(carried!.some((c) => c.status === 'open')).toBe(false);
  });
});

describe('weekday-aware baselines', () => {
  /** Heavy Mondays (4h), light other weekdays (1h), from `firstMonday` up to Mon Oct 26. */
  const heavyMondays = (firstMonday: number) => {
    const out: ReflectionActivity[] = [];
    for (let monday = firstMonday; monday <= 26; monday += 7) {
      out.push(saas(monday, '09:00', 240));
      if (monday < 26) for (let d = monday + 1; d <= monday + 4; d++) out.push(client(d));
    }
    return out;
  };

  it('16. compares a Monday with earlier Mondays, not with the days that happened to precede it', async () => {
    const h = founder({ activities: heavyMondays(-2), now: local(27, '09:00') }); // from Mon Sep 28
    const { metrics, notes } = await h.dataset(dayOf(26));

    expect(metrics['time.tracked_minutes'].display).toBe('4h');
    // Against "the previous 14 days" this Monday looks unusually long…
    expect(metrics['baseline.time.tracked_minutes'].display).toBe('1h 36m');
    // …against the user's own Mondays it is exactly a normal one.
    expect(metrics['weekday.time.tracked_minutes']).toMatchObject({
      display: '4h',
      label: 'Total tracked time — your average over the previous 4 Mondays',
      group: 'comparison',
    });
    expect(notes.join(' ')).not.toMatch(/Not enough earlier Mondays/);
  });

  it('17. says so when there are too few earlier same weekdays — a baseline is never manufactured', async () => {
    const h = founder({ activities: heavyMondays(19), now: local(27, '09:00') }); // one earlier Monday only
    const { metrics, notes } = await h.dataset(dayOf(26));
    expect(Object.keys(metrics).filter((k) => k.startsWith('weekday.'))).toEqual([]);
    // The plain baseline exists (five earlier days hold data) — the two are independent.
    expect(metrics['baseline.time.tracked_minutes'].display).toBe('1h 36m');
    expect(notes).toContain('Not enough earlier Mondays with data yet (1 of the 3 needed) to compare this day with your usual Monday.');
  });
});

describe('carry-forward — what is unresolved, what is simply ongoing, what closed', () => {
  /** SaaS on Mon + Tue, then only client work for the rest of W41. */
  const started = () => [saas(5), client(5), saas(6), client(6), ...[7, 8, 9].map((d) => client(d, '09:00', 180))];

  it('7 + 9. work left for three tracked days is carried as open; work done every day is not carried at all', async () => {
    const h = founder({ activities: started(), now: local(10, '09:00') });
    const { carried, trajectories, metrics } = await h.dataset(dayOf(9));

    expect(trajectories!.map((t) => [t.label, t.status, t.idleTrackedDays])).toEqual([
      ['Freelance client work', 'ongoing', 0],
      ['Launch my SaaS', 'stalled', 3],
    ]);
    // Five days of freelance work is work in progress — not an open loop.
    expect(carried).toEqual([
      {
        key: `p:${h.saasId}`,
        title: 'Launch my SaaS',
        priorityId: h.saasId,
        thread: null,
        status: 'open',
        since: '2026-10-07',
        idleTrackedDays: 3,
        timesRaised: 0,
        lastWorked: { start: dayOf(6).start, end: dayOf(6).end },
      },
    ]);
    expect(metrics[`carry.p.${h.saasId}`]).toMatchObject({
      value: 'open',
      display: 'still open — no work on it for 3 tracked days, last worked Tue, Oct 6',
      priorityId: h.saasId,
      range: { start: dayOf(6).start, end: dayOf(6).end },
    });
    expect(metrics['carry.open_count'].value).toBe(1);
    expect(metrics[`trajectory.p.${h.saasId}.idle_days`]).toMatchObject({ value: 3, label: 'Tracked days since you last worked on “Launch my SaaS” (Tue, Oct 6)' });
  });

  it('8. completing it closes the carry-forward — reported once, with its history kept, then gone', async () => {
    const h = founder({ activities: [...started(), client(12, '09:00', 180)], now: local(9, '18:00') });
    h.service.setPriorityStatus(h.saasId, 'completed'); // Friday evening
    h.setNow(local(13, '09:00'));

    const friday = await h.dataset(dayOf(9));
    expect(friday.carried).toMatchObject([{ key: `p:${h.saasId}`, status: 'completed' }]);
    expect(friday.metrics[`carry.p.${h.saasId}`].display).toBe('closed — marked completed by you');
    expect(friday.metrics['carry.open_count'].value).toBe(0);

    // The following Monday it is no longer surfaced; what happened is still on record.
    const monday = await h.dataset(dayOf(12));
    expect(monday.carried).toEqual([]);
    expect(monday.trajectories!.find((t) => t.key === `p:${h.saasId}`)).toMatchObject({ status: 'completed', activeDays: 2 });
    expect(h.repo.listPriorities().find((p) => p.id === h.saasId)!.history!.map((e) => e.type)).toEqual(['stated', 'completed']);
  });

  it('22b. what came before tracking began is not "missing": it was never observable', async () => {
    // Tracking begins on Wed Oct 7. The week, the month and the year all started earlier.
    const h = founder({ activities: [7, 8, 9].flatMap((d) => [saas(d), client(d)]), now: local(12, '09:00') });
    const week = await h.dataset(week41);
    expect(week.metrics['coverage.tracked_days'].display).toBe('3 of 5'); // Wed–Sun, not Mon–Sun
    expect(week.notes.join(' ')).toContain('Nothing was recorded on Sat, Oct 10, Sun, Oct 11.');
    expect(week.notes.join(' ')).not.toMatch(/Mon, Oct 5|Tue, Oct 6/);
    expect(week.subPeriods!.map((b) => b.label)).toEqual(['Wed, Oct 7', 'Thu, Oct 8', 'Fri, Oct 9', 'Sat, Oct 10', 'Sun, Oct 11']);
  });

  it('22. unobserved days are missing data: they neither count as idle days nor as days without work', async () => {
    // W42: SaaS on Mon + Tue, nothing recorded Wed/Thu (tracker off), client work on Fri.
    const h = founder({ activities: [...W41.flatMap((d) => [saas(d), client(d)]), saas(12), saas(13), client(16, '09:00', 180)] });
    const { trajectories, carried, notes, metrics, subPeriods } = await h.dataset(week42);

    // One tracked day without SaaS — not three. Nothing is open.
    expect(trajectories!.find((t) => t.key === `p:${h.saasId}`)).toMatchObject({ status: 'ongoing', idleTrackedDays: 1 });
    expect(carried).toEqual([]);
    expect(metrics['coverage.tracked_days'].display).toBe('3 of 7');
    expect(notes).toContain(
      'Nothing was recorded on Wed, Oct 14, Thu, Oct 15, Sat, Oct 17, Sun, Oct 18. Those days are unobserved — missing data, not idle time. Do not describe them as days without work.',
    );
    // In the week's own structure the gap is "nothing", not "0 minutes".
    expect(subPeriods!.map((b) => b.trackedMinutes)).toEqual([120, 120, null, null, 180, null, null]);
    expect(metrics['series.2026-10-14.tracked_minutes']).toBeUndefined();
  });
});

describe('priority history — state changes keep their meaning', () => {
  it('4. a paused priority leaves a gap that reactivating does not paper over', async () => {
    const h = founder({ activities: W41.flatMap((d) => [saas(d), client(d)]), now: local(7, '12:00') });
    h.service.setPriorityStatus(h.saasId, 'paused'); // Wednesday noon
    h.setNow(local(9, '08:00'));
    h.service.setPriorityStatus(h.saasId, 'active'); // Friday morning
    h.setNow(local(12, '09:00'));

    const priority = h.repo.listPriorities().find((p) => p.id === h.saasId)!;
    expect(priority.intervals).toEqual([
      { from: iso(1), until: iso(7, '12:00') },
      { from: iso(9, '08:00'), until: null },
    ]);
    expect(priority.history!.map((e) => e.type)).toEqual(['stated', 'paused', 'reactivated']);

    // Thursday's SaaS work happened while the priority was paused: not counted toward it.
    const thursday = await h.dataset(dayOf(8));
    expect(thursday.priorities.map((p) => p.id)).toEqual([h.freeId]);
    expect(thursday.activities.find((a) => a.thread === 'SaaS')!.priorityId).toBeNull();
    expect(thursday.trajectories!.find((t) => t.key === `p:${h.saasId}`)!.status).toBe('paused');
    // Four days of it across the week — not five.
    expect((await h.dataset(week41)).metrics[`priority.${h.saasId}.minutes`].display).toBe('8h');
    // And from Friday it applies again.
    expect((await h.dataset(dayOf(9))).activities.find((a) => a.thread === 'SaaS')!.priorityId).toBe(h.saasId);
  });

  it('5. rewording a priority keeps its identity, its links and its past', async () => {
    const h = founder({ activities: [...W41, ...W42].flatMap((d) => [saas(d), client(d)]) });
    h.profiles.updateProfile({ priorities: ['Launch my SaaS beta', 'Freelance client work'] });
    h.service.notifyDataChanged({ kind: 'profile' });

    const priorities = h.repo.listPriorities();
    expect(priorities.map((p) => [p.id, p.text, p.status])).toEqual([
      [h.saasId, 'Launch my SaaS beta', 'active'],
      [h.freeId, 'Freelance client work', 'active'],
    ]);
    expect(priorities[0].history!.at(-1)).toMatchObject({ type: 'renamed', text: 'Launch my SaaS beta', previousText: 'Launch my SaaS' });
    expect(priorities[0].intervals).toEqual([{ from: iso(1), until: null }]); // one unbroken stretch

    // Work done under the old wording still counts toward it, under the new one.
    const { metrics } = await h.dataset(week42);
    expect(metrics[`priority.${h.saasId}.minutes`]).toMatchObject({ display: '10h', label: 'Time linked to the priority “Launch my SaaS beta”' });
    expect(metrics[`prev.priority.${h.saasId}.minutes`].display).toBe('10h');

    // A different priority is still a different priority.
    h.profiles.updateProfile({ priorities: ['Learn Rust', 'Freelance client work'] });
    h.service.notifyDataChanged({ kind: 'profile' });
    expect(h.repo.listPriorities().map((p) => [p.text, p.status])).toEqual([
      ['Launch my SaaS beta', 'archived'],
      ['Freelance client work', 'active'],
      ['Learn Rust', 'active'],
    ]);
  });
});

describe('the five-day trajectory', () => {
  // Day 1 SaaS starts · Day 2 continues · Day 3 displaced by freelance · Day 4 none · Day 5 resumes.
  const fiveDays = () => [saas(5), saas(6), client(6), client(7, '09:00', 240), client(8, '09:00', 240), saas(9), client(9)];

  it('is one trajectory, read differently on each day — not five disconnected summaries', async () => {
    const h = founder({ activities: fiveDays(), now: local(12, '09:00') });
    const saasOn = async (d: number) => {
      const data = await h.dataset(dayOf(d));
      return { ...data.trajectories!.find((t) => t.key === `p:${h.saasId}`)!, carried: data.carried!.filter((c) => c.key === `p:${h.saasId}`).map((c) => c.status), display: data.metrics[`trajectory.p.${h.saasId}`].display };
    };

    expect(await saasOn(5)).toMatchObject({ status: 'new', activeDays: 1, carried: [] });
    expect(await saasOn(6)).toMatchObject({ status: 'ongoing', activeDays: 2, carried: [] });
    // One day off is a day off.
    expect(await saasOn(7)).toMatchObject({ status: 'ongoing', idleTrackedDays: 1, carried: [] });
    // Two tracked days of other work: it has been displaced.
    expect(await saasOn(8)).toMatchObject({ status: 'stalled', idleTrackedDays: 2, carried: ['open'] });
    const friday = await saasOn(9);
    expect(friday).toMatchObject({ status: 'resumed', idleTrackedDays: 0, activeDays: 3, trackedDays: 5 });
    expect(friday.display).toBe('resumed after a gap — worked Mon, Oct 5 and Tue, Oct 6; not Wed, Oct 7 or Thu, Oct 8; worked Fri, Oct 9 (3 of 5 tracked days)');

    // The week sees the same arc as a whole.
    const week = await h.dataset(week41);
    expect(week.metrics[`trajectory.p.${h.saasId}`].value).toBe('resumed');
    expect(week.metrics[`priority.${h.saasId}.active_days`].value).toBe(3);
    expect(week.subPeriods!.slice(0, 5).map((b) => b.top[0]?.label)).toEqual(['Launch my SaaS', 'Launch my SaaS', 'Freelance client work', 'Freelance client work', 'Launch my SaaS']);
  });
});

describe('what counts as a body of work', () => {
  it('a project outside any priority has a trajectory; a mere category does not', async () => {
    // "Database learning" is a project the user works on. Un-named browsing only carries its Context.
    const feeds = (d: number) => activity(d, '20:00', 45, { title: 'Scroll feeds', contextId: 'browsing', areaId: 'area_leisure', intentId: 'intent_consume', qualityId: 'quality_distracting', thread: null });
    const h = founder({ activities: [5, 6, 7, 8, 9].flatMap((d) => [client(d), feeds(d), ...(d <= 6 ? [learning(d)] : [])]), now: local(10, '09:00') });
    const { trajectories, metrics } = await h.dataset(dayOf(9));
    expect(trajectories!.map((t) => [t.key, t.status])).toEqual([
      [`p:${h.freeId}`, 'ongoing'],
      ['t:database-learning', 'stalled'],
    ]);
    // The time itself is still measured — it is just not something that can be "left open".
    expect(metrics['thread.browsing.minutes'].display).toBe('45m');
    expect(metrics['trajectory.t.browsing']).toBeUndefined();
    // And a stalled side project is not carried as open unless a reflection raised it: only stated priorities are.
    expect((await h.dataset(dayOf(9))).carried).toEqual([]);
  });
});

describe('insight identity, novelty and continuity', () => {
  const metric = (key: string, extra: Partial<Metric>): Metric => ({ key, label: key, value: 0, unit: 'minutes', display: '', group: 'priority', ...extra });

  it('18a. the same subject pointing the same way is one pattern, whatever the wording, type or metrics', () => {
    // "This week SaaS received less attention."
    const lessAttention = [metric('delta.priority.p1.minutes', { value: -300, priorityId: 'p1', group: 'comparison' })];
    // "Your SaaS work fell behind again."
    const fellBehind = [metric('carry.p.p1', { value: 'open', unit: 'text', priorityId: 'p1', group: 'history' })];

    const a = insightSubject(lessAttention, [], []);
    const b = insightSubject(fellBehind, [], ['p1']);
    expect(identityKeyOf(a, insightPattern('change_over_time', lessAttention, a), ['delta.priority.p1.minutes'])).toBe('p:p1|lagging');
    expect(identityKeyOf(b, insightPattern('open_loop', fellBehind, b), ['carry.p.p1'])).toBe('p:p1|lagging');

    // Progress on the same priority is a different pattern; so is the same pattern on another priority.
    const progress = [metric('priority.p1.minutes', { value: 240, priorityId: 'p1' })];
    expect(identityKeyOf(a, insightPattern('progress', progress, a), [])).toBe('p:p1|advancing');
    const other = insightSubject([metric('carry.p.p2', { value: 'open', unit: 'text', priorityId: 'p2' })], [], []);
    expect(other.subjectKey).toBe('p:p2');
  });

  it('18a2. "time went across your priorities" is one statement however it is put — and is not repeated day after day', async () => {
    const leads = (d: number) => activity(d, '15:00', 45, { title: 'Write freelance proposals', thread: 'Leads' });
    const h = makeReflectionHarness({
      activities: [5, 6, 7, 8].flatMap((d) => [saas(d), client(d), leads(d)]),
      now: local(9, '08:00'),
      priorities: ['Launch my SaaS', 'Freelance client work', 'Find new leads'],
    });
    const [a, b, c] = h.service.syncPriorities();
    seedThreads(h.repo, h.activities, { SaaS: a.id, Freelance: b.id, Leads: c.id });
    const spread = (title: string, metricKeys: string[]) =>
      modelInsight({ type: 'priority_alignment', title, observation: 'Your tracked time went toward each stated priority.', interpretation: 'All of them received attention.', metricKeys, priorityIds: [a.id, b.id, c.id] });
    const day = (d: number, insights: unknown[]) => modelReflection(periodContaining('day', local(d, '12:00')), { headline: 'A balanced day.', insights });
    const generate = async (d: number, ...responses: unknown[]) => {
      h.setNow(local(d + 1, '08:00'));
      h.gemini.push(...responses);
      return h.service.generate(periodContaining('day', local(d, '12:00')), { trigger: 'scheduled' });
    };
    const saved = (d: number) => h.repo.getCurrentReport('day', periodContaining('day', local(d, '12:00')).key)!.insights;

    // Different words, different measurements — the same subject: the priorities as a whole.
    await generate(5, day(5, [spread('Time distributed across your priorities', [`priority.${a.id}.minutes`, `priority.${b.id}.minutes`, `priority.${c.id}.minutes`])]));
    await generate(6, day(6, [spread('All three priorities received attention', [`priority.${a.id}.share`, 'priority.linked_minutes'])]));
    expect(saved(5)[0]).toMatchObject({ subjectKey: 'p:*', identityKey: 'p:*|alignment', continuity: 'new', priorityId: null });
    expect(saved(6)[0]).toMatchObject({ identityKey: 'p:*|alignment', continuity: 'continuing' });

    // The third time, with nothing changed, it is refused; the day is written without it.
    expect(await generate(7, day(7, [spread('Attention spread over every priority', [`priority.${c.id}.minutes`])]), day(7, []))).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(saved(7)).toEqual([]);
  });

  it('18b. continuity is decided from what was said before and how its size moved', () => {
    const said = (periodsBack: number, magnitude: number | null, identityKey = 'p:p1|lagging'): PriorInsight => ({
      periodsBack, periodKey: `d-${periodsBack}`, identityKey, subjectKey: 'p:p1', magnitude, title: 't', type: 'open_loop', feedback: null,
    });
    const lagging = (magnitude: number | null) => ({ identityKey: 'p:p1|lagging', subjectKey: 'p:p1', pattern: 'lagging' as const, magnitude });

    expect(continuityOf(lagging(2), [])).toEqual({ state: 'new', timesBefore: 0 });
    expect(continuityOf(lagging(3), [said(1, 2)])).toEqual({ state: 'continuing', timesBefore: 1 });
    expect(continuityOf(lagging(6), [said(1, 3), said(2, 2)])).toEqual({ state: 'strengthening', timesBefore: 2 }); // idle twice as long
    expect(continuityOf(lagging(2), [said(1, 6)])).toMatchObject({ state: 'weakening' });
    expect(continuityOf(lagging(4), [said(3, 3)])).toMatchObject({ state: 'recurred' }); // said, then silent, now back
    // It was lagging; now it is advancing (or closed): the earlier concern no longer holds.
    expect(continuityOf({ identityKey: 'p:p1|advancing', subjectKey: 'p:p1', pattern: 'advancing', magnitude: 120 }, [said(1, 4)])).toMatchObject({ state: 'resolved' });
    expect(continuityOf({ identityKey: 'p:p1|closed', subjectKey: 'p:p1', pattern: 'closed', magnitude: null }, [said(2, 4)])).toMatchObject({ state: 'resolved' });
  });

  it('18c. across real reports: new → continuing → not repeated unchanged → back → resolved', async () => {
    // SaaS on Mon + Tue; only client work until it is picked up again the Thursday after.
    const h = founder({
      activities: [saas(5), client(5), saas(6), client(6), ...[7, 8, 9, 12, 13, 14].map((d) => client(d, '09:00', 180)), saas(15), client(15)],
      now: local(9, '08:00'),
    });
    const stillOpen = () =>
      modelInsight({
        type: 'open_loop',
        title: 'Your SaaS work is still open',
        observation: 'No work was linked to your SaaS priority on the latest tracked days.',
        interpretation: 'The billing work you started has not been picked up since.',
        metricKeys: [`carry.p.${h.saasId}`, `trajectory.p.${h.saasId}.idle_days`],
        priorityIds: [h.saasId],
      });
    const report = (d: number, insights: unknown[]) => modelReflection(dayOf(d), { headline: 'Client work filled the day.', insights });
    const saved = (d: number) => h.repo.getCurrentReport('day', dayOf(d).key)!;

    // Thursday: said for the first time.
    await h.reflectOnDay(8, report(8, [stillOpen()]));
    expect(saved(8).insights[0]).toMatchObject({ identityKey: `p:${h.saasId}|lagging`, subjectKey: `p:${h.saasId}`, priorityId: h.saasId, continuity: 'new', magnitude: 2 });

    // Friday: still true, said once before — allowed, and labelled as continuing.
    await h.reflectOnDay(9, report(9, [stillOpen()]));
    expect(saved(9).insights[0]).toMatchObject({ continuity: 'continuing', magnitude: 3 });

    // Monday: nothing about it has changed and it was said twice already. The
    // model tries a third time; Reflect refuses, and the day is written without it.
    const before = h.gemini.requests.length;
    expect(await h.reflectOnDay(12, report(12, [stillOpen()]), report(12, []))).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.gemini.requests[before].prompt).toContain('PREVIOUSLY SURFACED');
    expect(h.gemini.requests[before].prompt).toContain('"title":"Your SaaS work is still open","timesSurfaced":2,"repeat":"only with a comparison that shows what changed — otherwise leave it out"');
    expect(h.gemini.requests[before + 1].prompt).toContain('already surfaced in 2 recent reports and has not changed');
    expect(saved(12).insights).toEqual([]);
    // It is still carried — as structure, raised twice — just not repeated as prose.
    expect(saved(12).dataSnapshot!.carried).toMatchObject([{ key: `p:${h.saasId}`, status: 'open', idleTrackedDays: 4, timesRaised: 2 }]);

    // Wednesday: idle for twice as long as when it was last said. It may be said
    // again — as something that grew, not as something that went away and came back.
    await h.reflectOnDay(14, report(14, [stillOpen()]));
    expect(saved(14).insights[0]).toMatchObject({ continuity: 'strengthening', magnitude: 6 });

    // Thursday: the SaaS work is picked up again. The earlier concern is resolved.
    const resumed = modelInsight({
      type: 'progress',
      title: 'You returned to your SaaS work',
      observation: 'The billing work was picked up again today.',
      interpretation: 'What had been left open since last week moved forward.',
      metricKeys: [`trajectory.p.${h.saasId}`],
      priorityIds: [h.saasId],
    });
    await h.reflectOnDay(15, modelReflection(dayOf(15), { headline: 'You picked the SaaS work back up.', insights: [resumed] }));
    expect(saved(15).insights[0]).toMatchObject({ identityKey: `p:${h.saasId}|advancing`, continuity: 'resolved' });
    expect(saved(15).dataSnapshot!.carried).toMatchObject([{ key: `p:${h.saasId}`, status: 'progressing' }]);
    // "Picked up again" is news once. The day after, it is simply work in progress.
    h.activities.push(saas(16), client(16));
    h.link();
    h.setNow(local(17, '08:00'));
    expect((await h.dataset(dayOf(16))).carried).toEqual([]);

    // History answers "what was said about this priority?" without reading any prose.
    const history = new ReflectionHistory(h.repo);
    expect(history.getSubjectHistory('day', `p:${h.saasId}`).map((r) => [r.period.key, r.continuity])).toEqual([
      ['2026-10-15', 'resolved'],
      ['2026-10-14', 'strengthening'],
      ['2026-10-09', 'continuing'],
      ['2026-10-08', 'new'],
    ]);
    expect(history.getRecurringPatterns('day')).toMatchObject([{ signature: `p:${h.saasId}|lagging`, occurrences: 3 }]);
  });
});

describe('priority / thread association', () => {
  it('10. an insight\'s priority and project come from the evidence the backend resolved — never from an id the model wrote', async () => {
    const h = founder({ activities: [...W41, ...W42].flatMap((d) => [saas(d), client(d)]) });
    const data = await h.dataset(week42);
    const check = (insight: Record<string, unknown>) =>
      validateReflectionOutput(modelReflection(week42, { headline: 'A steady week.', insights: [insight] }), {
        period: week42,
        metrics: data.metrics,
        activityByRef: new Map([['a1', data.activities.find((a) => a.thread === 'Freelance')!]]),
        priorities: data.priorities,
        maxInsights: 5,
        periodLabel: 'Last week Oct 12 – Oct 18',
      });

    // Citing the project's time is enough: the project and the priority it serves are attached by the backend.
    const byThread = check(modelInsight({ title: 'SaaS moved forward', observation: 'Your SaaS work received steady time.', metricKeys: ['thread.saas.minutes'] }));
    expect(byThread.ok && byThread.reflection.insights[0]).toMatchObject({ subjectKey: `p:${h.saasId}`, priorityId: h.saasId, thread: 'SaaS' });

    // Citing an activity attaches what that activity is linked to.
    const byActivity = check(modelInsight({ title: 'Client fixes continued', observation: 'The dashboard fixes continued.', metricKeys: [], activityRefs: ['a1'] }));
    expect(byActivity.ok && byActivity.reflection.insights[0]).toMatchObject({ priorityId: h.freeId, thread: 'Freelance' });

    // An invented priority id does not corrupt the report: the insight is rejected, nothing is stored under it.
    const invented = check(modelInsight({ metricKeys: ['time.tracked_minutes'], priorityIds: ['pr-made-up'] }));
    expect(invented.ok).toBe(false);
    expect(!invented.ok && invented.errors.join(' ')).toContain('priority "pr-made-up" does not exist');
    expect(!invented.ok && invented.salvaged).toBeNull();
  });
});

describe('corrections and feedback', () => {
  const twoWeeks = () => [...W41, ...W42].flatMap((d) => [saas(d), client(d)]);
  const aboutSaas = (id: string) =>
    modelInsight({
      type: 'priority_alignment',
      title: 'Your SaaS priority received steady time',
      observation: 'Time went toward your SaaS priority on every working day.',
      interpretation: 'What you said matters and where your time went lined up.',
      metricKeys: [`priority.${id}.active_days`],
      priorityIds: [id],
    });
  const weekly = (insights: unknown[]) => modelReflection(week42, { headline: 'A steady week.', insights });
  const evidenceOf = (a: ReflectionActivity) => ({ activityId: a.id, period: { start: a.startedAt, end: a.endedAt } });

  it('11. a user correction survives re-annotation and later priorities', async () => {
    const news = activity(12, '15:00', 45, { title: 'Read SaaS competitor news' });
    const nextDay = [saas(13), activity(13, '15:00', 45, { title: 'Read SaaS competitor news' })];
    const h = makeReflectionHarness({ activities: [saas(12), news, ...nextDay], now: local(13, '08:00'), priorities: ['Launch my SaaS'], realAnnotator: true });
    const [pSaas] = h.service.syncPriorities();
    const day = dayOf(12);
    const linkedTo = async () => (await h.metrics.loadActivities(day.start, day.end, h.service.syncPriorities())).find((a) => a.title === news.title)!;

    // The model links the reading to the SaaS priority.
    h.gemini.push(
      { items: [{ ref: 'i1', thread: 'SaaS', priorityId: pSaas.id }, { ref: 'i2', thread: 'SaaS', priorityId: pSaas.id }] },
      modelReflection(day, { headline: 'A SaaS day.', insights: [] }),
    );
    await h.service.generate(day, { trigger: 'scheduled' });
    expect(await linkedTo()).toMatchObject({ priorityId: pSaas.id, priorityLinkSource: 'model' });

    // "That was not work on my SaaS." — corrected through the same store the annotator writes to.
    expect(await h.service.correctActivityLink({ evidence: evidenceOf(news), priorityId: null })).toBe(true);
    expect(await linkedTo()).toMatchObject({ priorityId: null, thread: 'SaaS' });
    expect(h.repo.getAnnotations(['read saas competitor news|coding'])[0]).toMatchObject({ source: 'user', priorityId: null });

    // A new priority is stated (before the next day's work): the annotator
    // would normally ask about every signature again, for that priority.
    h.profiles.updateProfile({ priorities: ['Launch my SaaS', 'Understand the market'] });
    h.service.notifyDataChanged({ kind: 'profile' });
    h.setNow(local(14, '08:00'));
    h.gemini.push(
      { items: [{ ref: 'i1', thread: 'Rebranded', priorityId: null }] }, // only the un-corrected signature is asked about
      modelReflection(dayOf(13), { headline: 'A SaaS day.', insights: [] }),
    );
    expect(await h.service.generate(dayOf(13), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    const linkingPrompt = h.gemini.requests.at(-2)!.prompt;
    expect(linkingPrompt).toContain('STATED PRIORITIES');
    expect(linkingPrompt).toContain('Build SaaS billing page');
    expect(linkingPrompt).not.toContain('Read SaaS competitor news');
    // The correction stands — even against a model write aimed straight at it, and against the keyword fallback.
    expect(h.repo.upsertAnnotations([{ signature: 'read saas competitor news|coding', thread: 'SaaS', priorityId: pSaas.id, checkedPriorityIds: [pSaas.id], source: 'model' }], iso(13))).toEqual([]);
    expect(await linkedTo()).toMatchObject({ priorityId: null });
    const tuesday = await h.metrics.loadActivities(dayOf(13).start, dayOf(13).end, h.service.syncPriorities());
    expect(tuesday.map((a) => [a.title, a.priorityId, a.priorityLinkSource])).toEqual([
      ['Build SaaS billing page', pSaas.id, 'model'],
      ['Read SaaS competitor news', null, null],
    ]);
    // And what the model had already decided for the other activity was not thrown away by being asked again.
    expect(h.repo.getAnnotations(['build saas billing page|coding'])[0]).toMatchObject({ thread: 'SaaS', priorityId: pSaas.id, source: 'model' });
  });

  it('12. an insight marked "not accurate" is not regenerated on the same evidence — and is open again once the evidence is corrected', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(weekly([aboutSaas(h.saasId)]));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const disputed = h.repo.getCurrentReport('week', week42.key)!.insights[0];
    expect(h.service.submitFeedback(disputed.id, 'inaccurate')).toBe(true);

    // What produced it can be looked up: the linked activities, and who linked them.
    // (This insight cites a measurement; its basis is the priority's linked time.)
    expect(h.repo.listFeedback(iso(1))[0]).toMatchObject({ identityKey: `p:${h.saasId}|alignment`, subjectKey: `p:${h.saasId}`, periodKey: week42.key });

    // Regenerating on unchanged evidence: the same claim is refused, the model is told why, and the report is written without it.
    h.setNow(local(19, '10:00'));
    h.gemini.push(weekly([aboutSaas(h.saasId)]), weekly([]));
    const again = await h.service.generate(week42, { trigger: 'scheduled' });
    expect(again).toMatchObject({ status: 'succeeded', attempts: 2, insightCount: 0 });
    const [first, retry] = h.gemini.requests.slice(-2);
    expect(first.prompt).toContain('DISPUTED BY THE USER\n{"title":"Your SaaS priority received steady time","userSaid":"not accurate"}');
    expect(retry.prompt).toContain('you marked this same claim "not accurate" and the evidence behind it has not changed');

    // The user corrects the underlying link: SaaS billing work was not work on that priority.
    expect(await h.service.correctActivityLink({ evidence: evidenceOf(h.activities.find((a) => a.thread === 'SaaS' && a.startedAt >= week42.start)!), priorityId: null })).toBe(true);
    expect((await h.dataset(week42)).metrics[`priority.${h.saasId}.minutes`].value).toBe(0);
    // On the corrected evidence a claim about that priority may be made again.
    h.setNow(local(19, '11:00'));
    h.gemini.push(weekly([aboutSaas(h.saasId)]));
    expect(await h.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 1 });
  });

  it('12b. "not useful" stops the same thing from being said again while nothing about it moved', async () => {
    const h = founder({ activities: [...twoWeeks(), ...[19, 20, 21, 22, 23].flatMap((d) => [saas(d), client(d)])], now: local(26, '09:00') });
    h.gemini.push(weekly([aboutSaas(h.saasId)]));
    await h.service.generate(week42, { trigger: 'scheduled' });
    h.service.submitFeedback(h.repo.getCurrentReport('week', week42.key)!.insights[0].id, 'not_useful');

    const week43 = shiftPeriod(week42, 1);
    h.gemini.push(modelReflection(week43, { headline: 'A steady week.', insights: [aboutSaas(h.saasId)] }));
    // Quietly left out — no retry, no error: the report is simply written without it.
    expect(await h.service.generate(week43, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 0 });
  });

  it('13. a closed report is regenerated when what it was written from changed — "up to date" is checked, not assumed', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(weekly([aboutSaas(h.saasId)]));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const original = h.repo.getCurrentReport('week', week42.key)!;
    const calls = h.gemini.requests.length;

    // Nothing changed: a refresh is answered truthfully, without a model call.
    h.setNow(local(19, '12:00'));
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'skipped', reason: 'up_to_date' });
    expect(h.gemini.requests.length).toBe(calls);
    expect((await h.service.getView('week', iso(14))).refreshBlockedReason).toBe('up_to_date');

    // A link is corrected. The closed report no longer describes its week.
    await h.service.correctActivityLink({ evidence: evidenceOf(h.activities.find((a) => a.thread === 'SaaS' && a.startedAt >= week42.start)!), priorityId: null });
    const view = await h.service.getView('week', iso(14));
    expect(view.report).toMatchObject({ id: original.id, status: 'stale', staleReason: 'links_changed' });
    expect(view.canRefresh).toBe(true);

    h.gemini.push(weekly([]));
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
    expect(h.repo.getReportById(original.id)).toMatchObject({ status: 'superseded', headline: original.headline });
    expect((await h.service.getView('week', iso(14))).report!.status).toBe('fresh');
  });

  it('13b. a report written by an earlier version of the reasoning may be rewritten on request — but is not rewritten unasked', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(weekly([]));
    await h.service.generate(week42, { trigger: 'scheduled' });
    h.repo.reports.find((r) => r.status === 'fresh')!.promptVersion = 'reflect-reflection-v2';
    h.setNow(local(19, '09:30'));

    const view = await h.service.getView('week', iso(14));
    expect(view.report).toMatchObject({ status: 'fresh', outdated: true });
    expect(view).toMatchObject({ canRefresh: true, refreshBlockedReason: null });
    expect((await h.service.pendingScheduledPeriods()).map((p) => p.key)).not.toContain(week42.key);
  });

  it('14. a failed regeneration leaves the previous report exactly as it was', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(weekly([aboutSaas(h.saasId)]));
    await h.service.generate(week42, { trigger: 'scheduled' });
    await h.service.correctActivityLink({ evidence: evidenceOf(h.activities.find((a) => a.thread === 'SaaS' && a.startedAt >= week42.start)!), priorityId: null });
    const stale = (await h.service.getView('week', iso(14))).report!;
    expect(stale.status).toBe('stale');

    const offline = new GeminiError('network', 'offline', true);
    h.gemini.push(offline, offline, offline);
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'network', attempts: 3 });

    const view = await h.service.getView('week', iso(14));
    expect(view.report).toEqual(stale); // same id, same headline, same insights, same evidence
    expect(view.generation).toMatchObject({ state: 'failed', errorCategory: 'network' });
    expect(h.repo.listCurrentReports('week', 10).map((r) => r.id)).toEqual([stale.id]);
  });

  it('24. a Focus session added to a reflected day makes that day\'s report stale', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(modelReflection(dayOf(16), { headline: 'A steady day.', insights: [] }));
    await h.service.generate(dayOf(16), { trigger: 'scheduled' });

    const session = focusSession(16, '09:00', 50);
    h.focusSessions.push(session);
    h.service.notifyDataChanged({ kind: 'focus', range: { start: session.startedAt!, end: session.endedAt! } });
    expect((await h.service.getView('day', iso(16, '12:00'))).report).toMatchObject({ status: 'stale', staleReason: 'focus_changed' });
    // Another day's report is untouched.
    expect(h.repo.listCurrentReports('day', 10).filter((r) => r.status === 'stale')).toHaveLength(1);
  });

  it('25. the Coach reads carried work as structure, and a correction reaches it at once', async () => {
    // SaaS on Mon + Tue. A client call on Thursday was really about SaaS pricing.
    const call = client(8, '15:00', 90, { title: 'Call about SaaS pricing tiers' });
    const h = founder({
      activities: [saas(5), client(5), saas(6), client(6), client(7, '09:00', 180), client(8, '09:00', 120), call, client(9, '09:00', 180)],
      now: local(10, '09:00'),
      coach: true,
    });
    const history = new ReflectionHistory(h.repo, { metrics: h.metrics, now: () => local(10, '09:00') });
    expect(await history.getCarriedWork()).toMatchObject([{ key: `p:${h.saasId}`, status: 'open', idleTrackedDays: 3 }]);

    h.gemini.push(modelChat({ reply: 'Your SaaS work has not been picked up since Tuesday.' }));
    await h.coach.chat('What is still open?');
    const prompt = h.gemini.requests.at(-1)!.prompt;
    expect(prompt).toContain("HOW THE USER'S WORK MOVED ACROSS RECENT DAYS");
    expect(prompt).toContain('- Carried work — “Launch my SaaS”: still open — no work on it for 3 tracked days, last worked Tue, Oct 6');
    expect(prompt).toContain('- How “Freelance client work” moved across your tracked days: ongoing');

    // The user corrects the link: that call was SaaS work.
    expect(await h.service.correctActivityLink({ evidence: evidenceOf(call), priorityId: h.saasId, thread: 'SaaS' })).toBe(true);
    // One tracked day without it is a day off: nothing is open any more.
    expect(await history.getCarriedWork()).toEqual([]);
    h.gemini.push(modelChat({ reply: 'Nothing is open right now.' }));
    await h.coach.chat('And now?');
    expect(h.gemini.requests.at(-1)!.prompt).not.toContain('Carried work — “Launch my SaaS”');
    expect(h.gemini.requests.at(-1)!.prompt).toContain('- How “Launch my SaaS” moved across your tracked days: ongoing');
  });
});

describe('each horizon does its own job', () => {
  /** Four working weeks: Oct 5 – Oct 30. */
  const october = () => [5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30].flatMap((d) => [saas(d), client(d)]);
  const month = periodContaining('month', local(15));
  const year = periodContaining('year', local(15));
  const nothing = (period: ReflectionPeriod, headline: string) => modelReflection(period, { headline, insights: [] });

  it('19. Today vs Week: a day is given its activities; a week is given its days — and a single day cannot claim a habit', async () => {
    const h = founder({ activities: [...W41, ...W42].flatMap((d) => [saas(d), client(d)]) });
    h.gemini.push(nothing(dayOf(16), 'A steady day.'), nothing(week42, 'A steady week.'));
    await h.service.generate(dayOf(16), { trigger: 'scheduled' });
    await h.service.generate(week42, { trigger: 'scheduled' });
    const [dayPrompt, weekPrompt] = h.gemini.requests.map((r) => r.prompt);

    expect(dayPrompt).toContain('Your job is the SHAPE OF ONE DAY');
    expect(dayPrompt).toContain('ACTIVITIES (2, chronological');
    expect(dayPrompt).not.toContain('DAYS OF THIS WEEK');
    expect(dayPrompt).toContain('"sameWeekday"'); // explained, even when not yet available

    expect(weekPrompt).toContain('Your job is what REPEATS and what SHIFTED across the days of this week');
    expect(weekPrompt).toContain('DAYS OF THIS WEEK');
    // A week refers to its individual days — including what was already concluded about one of them.
    expect(weekPrompt).toContain('{"label":"Fri, Oct 16","tracked":"3h","focused":"3h","activeDays":1,"main":["Launch my SaaS (2h)","Freelance client work (1h)"],"reflection":"A steady day."}');

    // One day cannot show a habit: such a claim needs evidence from other days.
    const data = await h.dataset(dayOf(16));
    const habit = (metricKeys: string[]) =>
      validateReflectionOutput(
        modelReflection(dayOf(16), { headline: 'A steady day.', insights: [modelInsight({ type: 'recurring_behavior', title: 'You keep returning to the SaaS', observation: 'The SaaS work came first again.', metricKeys })] }),
        { period: dayOf(16), metrics: data.metrics, activityByRef: new Map(), priorities: data.priorities, maxInsights: 4, periodLabel: 'Fri, Oct 16' },
      );
    const alone = habit([`priority.${h.saasId}.minutes`]);
    expect(!alone.ok && alone.errors.join(' ')).toContain('a recurring_behavior insight about a single day must cite evidence from other days');
    expect(habit([`priority.${h.saasId}.minutes`, `recent.priority.${h.saasId}.active_days`]).ok).toBe(true);
  });

  it('20. Week vs Month: a month is synthesized from its weeks — structure, not a pile of sessions', async () => {
    const h = founder({ activities: october(), now: new Date(2026, 10, 2, 9, 0) });
    const weeks = [0, 1, 2, 3].map((i) => shiftPeriod(week41, i));
    const ordinal = ['First', 'Second', 'Third', 'Fourth'];
    h.gemini.push(...weeks.map((w, i) => nothing(w, `${ordinal[i]} week: SaaS first, client work after.`)), nothing(month, 'October went to the SaaS.'));
    for (const w of weeks) await h.service.generate(w, { trigger: 'scheduled' });
    await h.service.generate(month, { trigger: 'scheduled' });
    const prompt = h.gemini.requests.at(-1)!.prompt;

    expect(prompt).toContain('Your job is DIRECTION across the weeks of this month');
    expect(prompt).toContain('WEEKS OF THIS MONTH');
    expect(prompt).toContain('{"label":"Oct 5–Oct 11","tracked":"15h","focused":"15h","activeDays":5,"main":["Launch my SaaS (10h)","Freelance client work (5h)"],"reflection":"First week: SaaS first, client work after."}');
    // No single sessions — and none stored with the report either.
    expect(prompt).not.toContain('ACTIVITIES');
    const report = h.repo.getCurrentReport('month', month.key)!;
    expect(report.dataSnapshot!.activities).toEqual([]);

    // The month's numbers are exactly its days added up: 20 days × 3h.
    expect(report.metricsSnapshot!['time.tracked_minutes'].display).toBe('60h');
    expect(report.metricsSnapshot!['days.active'].value).toBe(20);
    expect(report.metricsSnapshot![`priority.${h.saasId}.minutes`].display).toBe('40h');
    expect(report.metricsSnapshot![`series.w2.priority.${h.saasId}.minutes`]).toMatchObject({ display: '10h', label: 'Time linked to the priority “Launch my SaaS” — Oct 5–Oct 11' });
    let weekTotal = 0;
    for (const w of weeks) weekTotal += (await h.metrics.computeCore(w, w.end, h.service.syncPriorities())).metrics['time.tracked_minutes'].value as number;
    expect(report.metricsSnapshot!['time.tracked_minutes'].value).toBe(weekTotal);
  });

  it('21. Month vs Year: a year is read from its months and the history of the priorities — without touching raw activity again', async () => {
    const h = founder({ activities: october(), now: local(30, '18:00') });
    h.service.setPriorityStatus(h.saasId, 'completed'); // shipped on Oct 30
    h.setNow(new Date(2027, 0, 1, 0, 2));
    h.gemini.push(nothing(month, 'October went to the SaaS.'), nothing(year, 'A year that ended with the SaaS shipped.'));
    await h.service.generate(month, { trigger: 'scheduled' });
    await h.service.generate(year, { trigger: 'scheduled' });
    const prompt = h.gemini.requests.at(-1)!.prompt;

    expect(prompt).toContain('Your job is the LONG ARC across the months of this year');
    expect(prompt).toContain('MONTHS OF THIS YEAR');
    expect(prompt).toContain('{"label":"October","tracked":"60h","focused":"60h","activeDays":20,"main":["Launch my SaaS (40h)","Freelance client work (20h)"],"reflection":"October went to the SaaS."}');
    // Months in which nothing was recorded are missing — not months of zero work.
    expect(prompt).toContain('{"label":"November","tracked":"nothing recorded","focused":null,"activeDays":0,"main":[],"reflection":null}');
    expect(prompt).toContain('PRIORITY HISTORY (what the user did with their stated priorities — their decisions, never failures)\n- Fri, Oct 30 — you marked completed “Launch my SaaS”');
    expect(prompt).not.toContain('ACTIVITIES');
    expect(prompt).not.toContain('DAYS OF THIS WEEK');

    // After a restart the year is read from the persisted ledger: not one day is derived from the timeline again.
    let derived = 0;
    const restarted = new ReflectionMetricsService(
      {
        getActivities: () => {
          derived++;
          return [];
        },
        focus: { getSessionsByRange: () => [], getInterruptions: () => [], getBlockedAttempts: () => [] },
        taxonomy: () => TAXONOMY,
        firstEventAt: () => iso(5, '09:00'),
      },
      h.repo,
      { config: DEFAULT_REFLECTION_CONFIG, now: () => new Date(2027, 0, 1, 0, 2), yieldToEventLoop: async () => {} },
    );
    const core = await restarted.computeCore(year, year.end, h.service.syncPriorities());
    expect(core.metrics['time.tracked_minutes'].display).toBe('60h');
    expect(core.metrics['series.2026-10.tracked_minutes'].display).toBe('60h');
    expect(derived).toBe(0);
  });

  it('23. a timeline edit reaches the months built on the ledger', async () => {
    const h = founder({ activities: october(), now: new Date(2026, 10, 2, 9, 0) });
    const tracked = async () => (await h.metrics.computeCore(month, month.end, h.service.syncPriorities())).metrics['time.tracked_minutes'].display;
    expect(await tracked()).toBe('60h');

    // The user deletes Tuesday's SaaS block on the Timeline.
    h.activities.splice(h.activities.findIndex((a) => a.thread === 'SaaS' && a.startedAt === iso(6, '09:00')), 1);
    h.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(6, '09:00'), end: iso(6, '11:00') } });
    expect(await tracked()).toBe('58h');
    // Only the edited day was derived again.
    expect(h.dayLoads.filter((t) => t === Date.parse(dayOf(6).start))).toHaveLength(2);
    expect(h.dayLoads.filter((t) => t === Date.parse(dayOf(7).start))).toHaveLength(1);
  });
});

describe('period availability and backfill', () => {
  /** Six working weeks: Mon Sep 7 – Fri Oct 16. */
  const sixWeeks = () => {
    const out: ReflectionActivity[] = [];
    for (let monday = -23; monday <= 12; monday += 7) for (let d = monday; d <= monday + 4; d++) out.push(saas(d), client(d));
    return out;
  };
  const keys = (periods: ReflectionPeriod[]) => periods.map((p) => `${p.type}:${p.key}`);

  it('15. past periods with enough data can be listed and reflected on; a long absence is caught up in bounded steps', async () => {
    const h = founder({ activities: sixWeeks() });

    // Every week since tracking began, with what was observed in it — none has a report yet.
    const { available } = await h.service.listAvailablePeriods('week');
    expect(available.map((a) => [a.period.key, a.status])).toEqual([
      ['2026-W43', 'unobserved'], // the running week: nothing recorded yet — not "an empty week"
      ['2026-W42', 'available'],
      ['2026-W41', 'available'],
      ['2026-W40', 'available'],
      ['2026-W39', 'available'],
      ['2026-W38', 'available'],
      ['2026-W37', 'available'],
    ]);

    // One cycle never writes more than a handful of reports: the most recent first.
    const firstCycle = await h.service.pendingScheduledPeriods();
    expect(firstCycle).toHaveLength(DEFAULT_REFLECTION_CONFIG.maxScheduledPerCycle);
    expect(keys(firstCycle)).toEqual(['day:2026-10-14', 'day:2026-10-15', 'day:2026-10-16', 'day:2026-10-17', 'day:2026-10-18', 'week:2026-W42']);

    // Without the cap, everything missed is found: six weeks, the closed month, the recent days — and the running month.
    const everything = founder({ activities: sixWeeks(), config: { maxScheduledPerCycle: 99 } });
    const all = keys(await everything.service.pendingScheduledPeriods());
    expect(all.filter((k) => k.startsWith('week:'))).toEqual(['week:2026-W37', 'week:2026-W38', 'week:2026-W39', 'week:2026-W40', 'week:2026-W41', 'week:2026-W42']);
    expect(all).toContain('month:2026-09');
    expect(all).toContain('month:2026-10'); // still running: read "so far"
    expect(all.filter((k) => k.startsWith('day:'))).toHaveLength(DEFAULT_REFLECTION_CONFIG.backlog.day);
    // Oldest first, a larger period after the smaller ones that end with it.
    expect(all.indexOf('week:2026-W37')).toBeLessThan(all.indexOf('month:2026-09'));
    expect(all.indexOf('day:2026-10-18')).toBeLessThan(all.indexOf('week:2026-W42'));

    // A week far in the past is generated on request, from its own data.
    const week38 = periodContaining('week', local(-14));
    h.gemini.push(modelReflection(week38, { headline: 'An early week.', insights: [] }));
    expect(await h.service.generate(week38, { trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
    expect((await h.service.listAvailablePeriods('week')).available.find((a) => a.period.key === '2026-W38')!.status).toBe('reported');
  });

  it('15b. a running week is read "so far" once it holds enough — and not rewritten every hour', async () => {
    const h = founder({ activities: [...W41.flatMap((d) => [saas(d), client(d)]), saas(12), client(12), saas(13), client(13)], now: local(13, '18:00'), config: { backlog: { day: 0, week: 0, month: 0, year: 0 } } });
    expect(keys(await h.service.pendingScheduledPeriods())).toEqual(['week:2026-W42', 'month:2026-10']);

    h.gemini.push(modelReflection(week42, { headline: 'The week so far.', insights: [] }), modelReflection(periodContaining('month', local(13)), { headline: 'The month so far.', insights: [] }));
    for (const p of await h.service.pendingScheduledPeriods()) await h.service.generate(p, { trigger: 'scheduled' });
    expect(h.repo.getCurrentReport('week', week42.key)!.dataSnapshot!.isPartial).toBe(true);

    // An hour later, the next day: nothing. Three days later the week is read again.
    h.setNow(local(13, '19:00'));
    expect(keys(await h.service.pendingScheduledPeriods())).not.toContain('week:2026-W42');
    h.setNow(local(14, '19:00'));
    expect(keys(await h.service.pendingScheduledPeriods())).not.toContain('week:2026-W42');
    h.setNow(local(16, '19:00'));
    expect(keys(await h.service.pendingScheduledPeriods())).toContain('week:2026-W42');
  });
});

describe('generation safety', () => {
  const twoWeeks = () => [...W41, ...W42].flatMap((d) => [saas(d), client(d)]);

  it('26. the same period computed twice gives the same facts, and the ledger does not grow', async () => {
    const h = founder({ activities: twoWeeks() });
    const first = await h.dataset(week42);
    const rows = h.repo.getDayFacts(iso(1), iso(31));
    const second = await h.dataset(week42);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.carried).toEqual(first.carried);
    expect(second.basis).toEqual(first.basis);
    expect(h.repo.getDayFacts(iso(1), iso(31))).toEqual(rows);

    // Two requests for the same report at once are one generation and one report.
    h.gemini.push(modelReflection(week42, { headline: 'A steady week.', insights: [] }));
    const [a, b] = await Promise.all([h.service.generate(week42, { trigger: 'scheduled' }), h.service.generate(week42, { trigger: 'scheduled' })]);
    expect(a).toEqual(b);
    expect(h.repo.listCurrentReports('week', 10)).toHaveLength(1);
  });

  it('27. a retry after a transient failure leaves exactly one report and nothing half-written', async () => {
    const h = founder({ activities: twoWeeks() });
    h.gemini.push(new GeminiError('network', 'offline', true), modelReflection(week42, { headline: 'A steady week.', insights: [] }));
    expect(await h.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.sleeps).toEqual([1000]);
    expect(h.repo.reports.filter((r) => r.period.key === week42.key).map((r) => r.status)).toEqual(['fresh']);
    expect(h.repo.getCurrentReport('week', week42.key)!.attemptCount).toBe(2);
  });
});

describe('evidence', () => {
  it('28. evidence is anchored to raw events and finds its block again after the timeline is regrouped', async () => {
    const morning = saas(12, '09:00', 120, { id: 's-101-4', eventIds: [101, 102, 103, 104] });
    const h = founder({ activities: [...W41.flatMap((d) => [saas(d), client(d)]), morning, client(12)], now: local(13, '09:00') });
    h.gemini.push(
      modelReflection(dayOf(12), {
        headline: 'The SaaS came first.',
        insights: [modelInsight({ title: 'The SaaS came first', observation: 'You began the day on the billing page.', metricKeys: [], activityRefs: ['a1'] })],
      }),
    );
    await h.service.generate(dayOf(12), { trigger: 'scheduled' });
    const evidence = h.repo.getCurrentReport('day', dayOf(12).key)!.insights[0].evidence[0];
    expect(evidence).toMatchObject({ kind: 'activity', activityId: 's-101-4', eventIds: [101, 102, 103, 104], priorityId: h.saasId, thread: 'SaaS' });
    expect(await h.service.resolveEvidence(evidence)).toMatchObject({ activityId: 's-101-4' });

    // Sessionization changes: the same events now sit in two differently-named blocks.
    const index = h.activities.indexOf(morning);
    h.activities.splice(
      index,
      1,
      saas(12, '09:00', 90, { id: 's-101-3', eventIds: [101, 102, 103] }),
      saas(12, '10:30', 30, { id: 's-104-1', eventIds: [104] }),
    );
    h.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(12, '09:00'), end: iso(12, '11:00') } });

    // The old id is gone, the stored report is untouched — and its evidence still lands on the block holding most of those events.
    expect(h.repo.getCurrentReport('day', dayOf(12).key)!.insights[0].evidence[0]).toEqual(evidence);
    expect(await h.service.resolveEvidence(evidence)).toEqual({ activityId: 's-101-3', start: iso(12, '09:00'), end: iso(12, '10:30') });

    // Evidence written before events were recorded falls back to its time window, deterministically.
    expect(await h.service.resolveEvidence({ activityId: 's-old-id', period: { start: iso(12, '10:20'), end: iso(12, '11:00') } })).toMatchObject({ activityId: 's-104-1' });
    // Nothing to go on: no guess.
    expect(await h.service.resolveEvidence({ activityId: 's-old-id' })).toBeNull();
  });
});
