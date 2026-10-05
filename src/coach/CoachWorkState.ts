import type { ReflectionActivity } from '../reflection/ReflectionModels.js';

/**
 * How a piece of work reads at the moment it was last touched. Pure.
 *
 * Everything here is read from how Reflect itself described an activity (its
 * title and one-sentence summary) — never from raw window titles, and never
 * as more than a hint: the Coach still decides what, if anything, follows.
 */

/**
 * Where a piece of work stood when it was last touched, read from how Reflect
 * itself described the activity. A hint only, and deliberately strict about
 * what counts as open:
 *
 *   open            the description states that it is unfinished — a failing
 *                   test, a draft, "4 of 9 solved", blocked, waiting, not sent
 *   underway        the description is of work that is by nature mid-way
 *                   ("drafting", "debugging", "investigating"), with nothing
 *                   said about how it ended: an activity, not a state
 *   stopping_point  it says the work was sent, submitted, merged, deployed…
 *   unknown         an ordinary activity verb ("developing", "studying",
 *                   "reviewing") says what was done, not whether it is done
 */
export type WorkState = 'open' | 'underway' | 'stopping_point' | 'unknown';

const STOPPING_POINT =
  /\b(sen[td]|sending|submi(t|tted|tting|ssion)|deploy(ed|ing|ment)?|releas(e|ed|ing)|ship(ped|ping)|merg(e|ed|ing)|publish(ed|ing)?|deliver(ed|ing|y)|finish(ed|ing)|complet(ed|ing|ion)|finali[sz](ed|ing)|clos(ed|ing)|resolv(ed|ing)|invoiced|approved|accepted|launch(ed|ing)|wrapp(ed|ing) up|signed off|hand(ed)?[- ]?off)\b/i;
/** The subset of finishes that hand the work to someone else — after which going quiet is completion. */
const DELIVERED =
  /\b(sen[td]|sending|submi(t|tted|tting|ssion)|deploy(ed|ing|ment)?|releas(e|ed|ing)|ship(ped|ping)|merg(e|ed|ing)|publish(ed|ing)?|deliver(ed|ing|y)|invoiced|approved|accepted|launch(ed|ing)|signed off|hand(ed)?[- ]?off)\b/i;
/** A statement about the STATE of the work: it says, in so many words, that something is unfinished. */
const EXPLICITLY_OPEN =
  /\b(drafts?|fail(s|ed|ing|ures?)?|errors?|broken|bugs?|in progress|unfinished|incomplete|not (yet )?(finished|submitted|sent|done|complete|resolved|merged|answered)|still (open|failing|pending|under way|unresolved|a draft|in draft|unattempted|unanswered|waiting)|pending|blocked|waiting (on|for)|awaiting|to be continued|partway|part-way|halfway|half-done|remaining|left (open|unfinished)|work in progress|wip|todo|unresolved|unsent|unanswered|unattempted|overdue|due (today|tomorrow)|(part|half) of (it|the|this|that))\b/i;
/** A verb for work that is by its nature mid-way. It says what was being done — not how it ended. */
const EARLY_STAGE = /\b(drafting|drafted|debug(s|ging|ged)?|troubleshoot\w*|investigat\w+|diagnos\w+)\b/i;
/** "0 failed", "no errors", "bug fixing": the words of an open state, saying the opposite or naming an activity. */
const NOT_A_STATE = /\b((0|no|zero|without( any)?) (failed|failing|failures?|errors?|bugs?)|bug[- ]?fix\w*)\b/gi;
const PARTIAL_COUNT = /\b(\d+) of (\d+)\b/g;

/** Whether the text states that something is unfinished ("still failing", "2 drafts", "4 of 9 solved"). */
function statesOpen(text: string): boolean {
  const cleaned = text.replace(NOT_A_STATE, ' ');
  if (EXPLICITLY_OPEN.test(cleaned)) return true;
  for (const match of cleaned.matchAll(PARTIAL_COUNT)) if (Number(match[1]) < Number(match[2])) return true;
  return false;
}

export function workStateOf(activity: Pick<ReflectionActivity, 'title' | 'summary'>): WorkState {
  const summary = activity.summary ?? '';
  // "Draft the client update" is an instruction to write one, not a statement that a draft is lying around.
  const title = activity.title.replace(/^\s*drafts?\b/i, ' ');
  // What the summary says about how it ended outranks the title's verb.
  if (statesOpen(summary)) return 'open';
  if (STOPPING_POINT.test(activity.title) || STOPPING_POINT.test(summary)) return statesOpen(title) && !STOPPING_POINT.test(summary) ? 'open' : 'stopping_point';
  if (statesOpen(title)) return 'open';
  return EARLY_STAGE.test(`${activity.title} ${summary}`) ? 'underway' : 'unknown';
}

/** Whether the work was handed over (sent, submitted, deployed, published…) rather than merely brought to the end of a step. */
export function wasDelivered(activity: Pick<ReflectionActivity, 'title' | 'summary'>): boolean {
  return DELIVERED.test(activity.title) || DELIVERED.test(activity.summary ?? '');
}

/**
 * The words of the description that say the work is unfinished — the clause
 * of the summary (or the title) holding the statement. Null when nothing says so.
 */
export function openEvidenceOf(activity: Pick<ReflectionActivity, 'title' | 'summary'>): string | null {
  for (const clause of (activity.summary ?? '').split(/(?<=[.;!?])\s+|;\s*/)) {
    const text = clause.trim().replace(/[.;]+$/, '');
    if (text && statesOpen(text)) return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  }
  return statesOpen(activity.title.replace(/^\s*drafts?\b/i, ' ')) ? activity.title : null;
}
