// Researcher — work streams, dated profile changes and the stream-level coach key.
// Source of truth for these annotations; `build.mjs` applies them to the day files.

export const streams = {
  main_experiment: { title: 'Uncertainty-estimation experiments and their evaluation protocol', kind: 'work', aliases: ['experiment', 'experiments', 'evaluation', 'generalization test', 'distribution-shift', 'protocol'] },
  manuscript: { title: 'Manuscript: drafting, collaborator review and submission', kind: 'work', aliases: ['manuscript', 'paper', 'draft', 'citation', 'submission', 'venue', 'results section'] },
  replication: { title: 'Replication study of a published calibration method', kind: 'work', aliases: ['replication', 'reproduction', 'reproduce'] },
  next_question: { title: 'Choosing the next research question', kind: 'work', aliases: ['next research question', 'research question', 'research direction', 'literature gap'] },
  prevalence_pilot: { title: 'Noisy-prevalence calibration pilot and its methods note', kind: 'work', aliases: ['pilot', 'prevalence', 'class-level', 'class-conditional', 'method comparison', 'methods note'] },
  research_admin: { title: 'Lab meetings, collaborator messages and research housekeeping', kind: 'work', aliases: ['lab meeting'] },
  learning: { title: 'Talks, seminars and topic-adjacent learning', kind: 'work', aliases: ['seminar', 'research talk'] },
  personal: { title: 'Unrelated browsing and personal time', kind: 'personal', aliases: [] },
};

const P = {
  experiments: 'Complete the next experiments for the uncertainty project',
  manuscript: 'Move the manuscript from notes to a coherent results section',
  fairness: 'Resolve whether the setup measures calibration fairly',
  replication: 'Complete the replication study before deciding to extend it',
  question: 'Choose the next research question to pursue',
  pilot: 'Run a small pilot on calibration under noisy prevalence',
  note: 'Write up the pilot as a short methods note',
};

export const priorities = {
  main_experiment: [P.experiments, P.fairness],
  manuscript: [P.manuscript],
  replication: [P.replication],
  next_question: [P.question],
  prevalence_pilot: [P.pilot, P.note],
};

export function streamOf(text, day) {
  if (/unrelated|^personal \||incidental (equipment|browsing)|product browsing|shipment|desk-setup|keyboard browsing|^mixed/.test(text)) return 'personal';
  if (day >= 23) return /learning|seminar/.test(text) ? 'learning' : 'prevalence_pilot';
  if (/^(learning|literature and learning|learning and|unrelated learning|research documentation and learning)|talk|seminar|supplementary/.test(text)) return 'learning';
  if (day >= 20 && /research planning|research directions|next research|literature review|research engineering|research ideas/.test(text) && !/replication/.test(text)) return 'next_question';
  if (/replication/.test(text) && !/^manuscript/.test(text)) return 'replication';
  if (day === 18 && /research planning/.test(text)) return 'replication';
  if (/manuscript|main paper|submission|^literature \||literature and manuscript|project planning/.test(text)) return 'manuscript';
  if (day === 10 && /literature review/.test(text)) return 'manuscript';
  if (/^collaboration/.test(text)) return 'research_admin';
  if (/main research project|methodology|research infrastructure|research software|literature review/.test(text)) return 'main_experiment';
  return null;
}

const end = (op, priority) => ({ at: 'end', op, priority });
const work = (...current_work) => ({ at: 'end', op: 'set_current_work', current_work });

export const profile = {
  5: [end('pause', P.replication)],
  9: [end('complete', P.fairness)],
  11: [end('complete', P.experiments), work('Writing the manuscript for the uncertainty project', 'Maintaining research code and experiment infrastructure')],
  18: [end('complete', P.manuscript), end('resume', P.replication), end('remove', P.fairness), work('Running a bounded replication of a calibration method', 'Maintaining research code and experiment infrastructure')],
  21: [end('complete', P.replication), end('remove', P.experiments), end('add', P.question), work('Choosing the next research direction', 'Maintaining research code and experiment infrastructure')],
  23: [end('complete', P.question), end('remove', P.manuscript), end('add', P.pilot), work('Running a pilot on calibration under noisy prevalence', 'Maintaining research code and experiment infrastructure')],
  29: [end('complete', P.pilot), end('remove', P.replication), end('add', P.note)],
};

export const closed = {
  main_experiment: [[12, 30]],
  replication: [[5, 17], [22, 30]],
  manuscript: [[19, 30]],
  next_question: [[24, 30]],
};

export const coach = {
  1: ['main_experiment', null, 'strong'],
  2: ['main_experiment', null, 'strong'],
  3: ['main_experiment', null, 'strong'],
  4: ['main_experiment', 'replication', 'strong'],
  5: ['main_experiment', null, 'strong'],
  6: ['main_experiment', null, 'moderate', 'A clean, focused day whose next step is one more run of the same comparison: continuing needs no prompt.'],
  7: ['main_experiment', null, 'strong'],
  8: ['main_experiment', 'manuscript', 'strong'],
  9: ['manuscript', 'main_experiment', 'strong'],
  10: ['main_experiment', 'manuscript', 'strong'],
  11: ['manuscript', null, 'strong'],
  12: ['manuscript', null, 'strong'],
  13: ['manuscript', null, 'strong'],
  14: [null, null, 'none', 'The consistency pass is complete and the draft is with the collaborator; the key\'s own move is to pause until that review returns. Nothing useful can be started before it does.'],
  15: ['manuscript', null, 'strong'],
  16: ['manuscript', null, 'strong'],
  17: ['manuscript', null, 'strong'],
  18: ['replication', null, 'strong'],
  19: ['replication', null, 'strong'],
  20: ['replication', 'next_question', 'strong'],
  21: ['next_question', null, 'strong'],
  22: ['next_question', null, 'strong'],
  23: ['prevalence_pilot', null, 'strong'],
  24: ['prevalence_pilot', null, 'strong'],
  25: ['prevalence_pilot', null, 'strong'],
  26: ['prevalence_pilot', null, 'strong'],
  27: ['prevalence_pilot', null, 'strong'],
  28: ['prevalence_pilot', null, 'strong'],
  29: ['prevalence_pilot', null, 'strong'],
  30: ['prevalence_pilot', null, 'strong'],
};
