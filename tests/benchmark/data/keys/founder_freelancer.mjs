// Founder / freelancer — work streams for the existing key.
// The founder files already state their targets as two work streams ("Own SaaS", "Freelance") and already carry
// `action_opportunity` and `execution_scenario`; nothing about the day's expectations is changed here. This module
// only names those streams in the registry every persona uses, so the founder is scored by the same stream-and-
// evidence rules as the other five instead of by a founder-only word list in the evaluator.

export const streams = {
  'Own SaaS': {
    title: "The founder's own SaaS product",
    kind: 'work',
    aliases: ['saas', 'mvp', 'product', 'beta', 'onboarding', 'dashboard', 'launch', 'billing', 'activation', 'tester', 'landing page', 'own app'],
  },
  Freelance: {
    title: 'Freelance: the existing client and new leads',
    kind: 'work',
    aliases: ['client', 'freelance', 'lead', 'prospect', 'proposal', 'outreach', 'linkedin', 'contract', 'invoice', 'discovery call', 'estimate', 'scope', 'deliverable', 'handoff'],
  },
  Plan: { title: 'General planning', kind: 'work', aliases: [] },
  Learning: { title: 'General learning', kind: 'work', aliases: [] },
};

export const priorities = {
  'Own SaaS': ['Ship the SaaS MVP'],
  Freelance: ['Complete existing client work', 'Generate new freelance leads'],
};

/** Activities keep their `area`, which already is the stream key. */
export const streamOf = null;
export const profile = {};
export const closed = {};
/** `keep`: targets become `target_stream` as they stand; opportunity and scenario are left exactly as they are. */
export const coach = 'keep';
