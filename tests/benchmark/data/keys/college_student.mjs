// College student — work streams, dated profile changes and the stream-level coach key.
// Source of truth for these annotations; `build.mjs` applies them to the day files.

/** One stream per course deliverable family: the month moves from one course's task to the next. */
export const streams = {
  dbms: { title: 'DBMS coursework (assignment, mini-assignment, Practical 3)', kind: 'work', aliases: ['dbms', 'sql', 'mysql'] },
  operating_systems: { title: 'Operating Systems quiz preparation', kind: 'work', aliases: ['operating systems', 'os quiz', 'os revision', 'os weak'] },
  networks: { title: 'Computer Networks labs', kind: 'work', aliases: ['computer networks', 'networks lab', 'tcp'] },
  software_engineering: { title: 'Software Engineering mini-assignment and presentation', kind: 'work', aliases: ['software engineering', 'presentation', 'slides', 'use-case', 'rehearsal'] },
  theory_of_computation: { title: 'Theory of Computation tutorial', kind: 'work', aliases: ['theory of computation', 'toc tutorial', 'automata'] },
  data_structures: { title: 'Data Structures problem set and internal assessment', kind: 'work', aliases: ['data structures', 'problem set', 'graph', 'assessment', 'heap', 'spanning tree'] },
  semester_project: { title: 'Semester group project', kind: 'work', aliases: ['semester project', 'group project', 'project', 'parser', 'pagination'] },
  coursework_admin: { title: 'Course notices, inbox and schedule checks', kind: 'work', aliases: ['course notices', 'classroom'] },
  leisure: { title: 'Gaming, video and social time', kind: 'leisure', aliases: [] },
  personal: { title: 'Personal and offline time', kind: 'personal', aliases: [] },
};

/** Stated priorities each stream serves (texts as they stand in the profile at some point of the month). */
export const priorities = {
  dbms: ['Complete the DBMS assignment due later this week', 'Do the DBMS mini-assignment', 'Complete DBMS Practical 3', 'Keep up with coursework'],
  operating_systems: ['Prepare for the Operating Systems quiz', 'Keep up with coursework'],
  networks: ['Finish the Computer Networks lab', 'Finish Computer Networks Lab 4', 'Keep up with coursework'],
  software_engineering: ['Finish the Software Engineering mini-assignment', 'Prepare the Software Engineering presentation', 'Keep up with coursework'],
  theory_of_computation: ['Do the Theory of Computation tutorial', 'Keep up with coursework'],
  data_structures: ['Finish Data Structures Problem Set 4', 'Prepare for the Data Structures assessment', 'Keep up with coursework'],
  semester_project: ['Make progress on the semester group project'],
  coursework_admin: ['Keep up with coursework'],
};

/** Stream of one ground-truth activity. `text` is "area | title", lower-cased. */
export function streamOf(text, day, activity) {
  if (/\bleisure\b|gaming|entertainment|recreation|netflix|social time|personal time \(evening\)|evening personal time|mixed study-support browsing/.test(text)) return 'leisure';
  if (/^personal \||offline (social|break|lunch|sunday personal|weekend|personal|evening)|lunch|dinner|friend communication|travel and pre-assessment|post-assessment discussion/.test(text)) return 'personal';
  if (/semester[ _]project|project (pagination|message|status)/.test(text)) return 'semester_project';
  if (/dbms/.test(text)) return 'dbms';
  if (/operating systems/.test(text)) return 'operating_systems';
  if (/computer networks|networks lab/.test(text) || (day === 6 && /coursework submission and email check/.test(text))) return 'networks';
  if (/software engineering|presentation/.test(text)) return 'software_engineering';
  if (/theory of computation/.test(text)) return 'theory_of_computation';
  if (/data structures|graph|spanning-tree|revision-sheet|assessment|post-study review|offline (peer study|handwritten|mock-test)|final note check|peer review/.test(text)) return 'data_structures';
  if (/offline classes|classes and|college classes/.test(text)) return 'coursework_admin';
  if (/morning|course|academic|inbox|coursework/.test(text)) return 'coursework_admin';
  return null;
}

const P = {
  dbms1: 'Complete the DBMS assignment due later this week',
  os: 'Prepare for the Operating Systems quiz',
  net: 'Finish the Computer Networks lab',
  seMini: 'Finish the Software Engineering mini-assignment',
  dbmsMini: 'Do the DBMS mini-assignment',
  sePres: 'Prepare the Software Engineering presentation',
  dbmsPrac: 'Complete DBMS Practical 3',
  toc: 'Do the Theory of Computation tutorial',
  dsSet: 'Finish Data Structures Problem Set 4',
  dsTest: 'Prepare for the Data Structures assessment',
  net4: 'Finish Computer Networks Lab 4',
};
const end = (op, priority) => ({ at: 'end', op, priority });

/**
 * What the student changed in the priority list, on the evening of the day it happened: a deliverable submitted is
 * marked completed, a newly set task is added, and a finished one is cleared from the list a few days later.
 */
export const profile = {
  2: [end('complete', P.dbms1), end('add', P.os)],
  5: [end('complete', P.os), end('remove', P.dbms1), end('add', P.net)],
  6: [end('complete', P.net)],
  7: [end('remove', P.os), end('add', P.seMini)],
  8: [end('complete', P.seMini), end('remove', P.net), end('add', P.dbmsMini)],
  10: [end('complete', P.dbmsMini), end('remove', P.seMini), end('add', P.sePres)],
  14: [end('remove', P.dbmsMini), end('add', P.dbmsPrac)],
  16: [end('complete', P.dbmsPrac), end('complete', P.sePres), end('add', P.toc)],
  18: [end('complete', P.toc), end('remove', P.dbmsPrac), end('remove', P.sePres), end('add', P.dsSet)],
  21: [end('complete', P.dsSet), end('remove', P.toc), end('add', P.dsTest)],
  28: [end('complete', P.dsTest), end('remove', P.dsSet)],
  29: [end('add', P.net4)],
  30: [end('complete', P.net4)],
};

/** Days (inclusive) on which a stream's current deliverable is finished: a recommendation aimed there is aimed at closed work. */
export const closed = {
  dbms: [[3, 7], [11, 13], [17, 30]],
  operating_systems: [[6, 30]],
  networks: [[7, 28]],
  software_engineering: [[9, 9], [17, 30]],
  theory_of_computation: [[19, 30]],
  data_structures: [[28, 30]],
};

/**
 * Per day: [primary stream, secondary stream | null, strength, note].
 * Streams restate the existing key's targets; strength is "strong" unless the key's own move is conditional on
 * something Reflect cannot see or is explicitly a light continuation.
 */
export const coach = {
  1: ['dbms', 'semester_project', 'strong'],
  2: ['operating_systems', 'semester_project', 'strong'],
  3: ['operating_systems', 'semester_project', 'strong'],
  4: ['operating_systems', 'semester_project', 'strong'],
  5: ['networks', 'semester_project', 'strong'],
  6: ['semester_project', null, 'strong'],
  7: ['software_engineering', 'semester_project', 'strong'],
  8: ['dbms', 'semester_project', 'strong'],
  9: ['dbms', 'semester_project', 'strong'],
  10: ['software_engineering', 'semester_project', 'strong'],
  11: ['software_engineering', 'semester_project', 'strong'],
  12: ['software_engineering', null, 'moderate', 'The only open step depends on what an offline rehearsal surfaced; the laptop day was light. Nothing is missed by saying nothing.'],
  13: ['software_engineering', null, 'strong'],
  14: ['dbms', 'semester_project', 'strong'],
  15: ['dbms', 'semester_project', 'strong'],
  16: ['theory_of_computation', null, 'strong'],
  17: ['theory_of_computation', 'semester_project', 'strong'],
  18: ['data_structures', null, 'strong'],
  19: ['data_structures', null, 'moderate', 'A light Saturday: the problem set is open and moving, and continuing it is the obvious next thing with or without a nudge.'],
  20: ['data_structures', 'coursework_admin', 'strong'],
  21: ['data_structures', null, 'strong'],
  22: ['data_structures', 'semester_project', 'strong'],
  23: ['data_structures', null, 'strong'],
  24: ['data_structures', null, 'strong'],
  25: ['data_structures', null, 'strong'],
  26: ['data_structures', null, 'strong'],
  27: [null, null, 'none', 'The eve of the assessment after several rounds of practice and a mock test. The key\'s own advice is conditional on results Reflect cannot see ("only the concepts actually missed … otherwise stop adding material"); with no such evidence, staying silent is right.'],
  28: ['semester_project', null, 'strong'],
  29: ['networks', null, 'strong'],
  30: ['semester_project', null, 'strong'],
};
