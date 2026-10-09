// Graphic designer — work streams, dated profile changes and the stream-level coach key.
// Source of truth for these annotations; `build.mjs` applies them to the day files.

export const streams = {
  northstar_identity: { title: 'Northstar Coffee brand identity (through client handoff)', kind: 'work', aliases: ['coffee identity', 'coffee brand identity', 'northstar identity', 'northstar handoff', 'coffee brand review'] },
  portfolio: { title: 'Portfolio: the Northstar Coffee case study', kind: 'work', aliases: ['portfolio', 'case study'] },
  new_identity: { title: 'New client brand identity (brief through delivery)', kind: 'work', aliases: ['new identity', 'new client identity', 'new brand identity', 'identity directions', 'identity brief', 'identity direction'] },
  food_identity: { title: 'Food-business brand inquiry and identity', kind: 'work', aliases: ['food-business', 'food business', 'new inquiry', 'inquiry', 'proposal'] },
  social_campaign: { title: 'Recurring social media campaign for an existing client', kind: 'work', aliases: ['social campaign', 'social media campaign', 'campaign'] },
  client_admin: { title: 'Client messages, files and studio administration', kind: 'work', aliases: ['invoice', 'file organization'] },
  reference: { title: 'Reference browsing and tutorials with no single project', kind: 'work', aliases: [] },
  personal_practice: { title: 'Personal lettering, typography and exploration', kind: 'personal', aliases: [] },
};

const P = {
  coffee: 'Complete the coffee brand identity before the client review',
  social: 'Deliver the social media campaign assets on time',
  portfolio: 'Build a stronger portfolio with the coffee project',
  clients: 'Maintain existing freelance client relationships',
  newIdentity: 'Develop the brand identity for the new client',
  food: 'Scope and start the food-business brand identity',
};

export const priorities = {
  northstar_identity: [P.coffee],
  portfolio: [P.portfolio],
  new_identity: [P.newIdentity],
  food_identity: [P.food],
  social_campaign: [P.social],
  client_admin: [P.clients],
};

export function streamOf(text) {
  if (/^(null|unknown) \|/.test(text)) return null;
  if (/^(personal exploration|skill development) \|/.test(text)) return 'personal_practice';
  if (/^reference/.test(text)) return 'reference';
  if (/^portfolio \|/.test(text)) return 'portfolio';
  if (/^new client identity \||^freelance pipeline \|/.test(text)) return 'new_identity';
  if (/^new brand inquiry \|/.test(text)) return 'food_identity';
  if (/^social campaign \|/.test(text) || /social campaign/.test(text)) return 'social_campaign';
  if (/^northstar coffee \|/.test(text) || /northstar/.test(text)) return 'northstar_identity';
  if (/^(client work|administration|freelance) \|/.test(text)) return 'client_admin';
  return null;
}

const end = (op, priority) => ({ at: 'end', op, priority });
const work = (...current_work) => ({ at: 'end', op: 'set_current_work', current_work });
const CAMPAIGN = 'Preparing social media campaign assets for a client';
const CASE_STUDY = 'Building a personal portfolio case study';
const COMMS = 'Handling client communication and revisions';

export const profile = {
  5: [end('complete', P.coffee), work(CAMPAIGN, CASE_STUDY, COMMS)],
  7: [end('add', P.newIdentity), work('Developing a brand identity for a new client', CAMPAIGN, CASE_STUDY, COMMS)],
  19: [end('complete', P.newIdentity), end('remove', P.coffee), work(CAMPAIGN, CASE_STUDY, COMMS)],
  23: [end('add', P.food), work('Scoping a brand identity for a food business', CAMPAIGN, CASE_STUDY, COMMS)],
};

export const closed = {
  northstar_identity: [[6, 30]],
  new_identity: [[20, 30]],
};

/** [primary, secondary, strength, note, { acceptable, forbidden }] */
export const coach = {
  1: ['northstar_identity', null, 'strong'],
  2: ['northstar_identity', null, 'strong'],
  3: ['northstar_identity', 'portfolio', 'strong'],
  4: ['portfolio', null, 'strong'],
  5: ['portfolio', null, 'moderate', 'A lighter weekend day on which the case study was already moving; carrying on needs no prompt.'],
  6: ['portfolio', null, 'strong'],
  7: ['new_identity', 'portfolio', 'strong'],
  8: ['new_identity', null, 'strong'],
  9: ['new_identity', null, 'strong'],
  10: ['new_identity', 'portfolio', 'strong'],
  11: ['new_identity', null, 'strong'],
  12: ['new_identity', null, 'strong'],
  13: ['portfolio', null, 'strong'],
  14: ['new_identity', null, 'strong'],
  15: ['new_identity', null, 'strong'],
  16: ['new_identity', null, 'strong'],
  17: ['new_identity', null, 'strong'],
  18: ['new_identity', null, 'strong'],
  19: ['portfolio', null, 'strong'],
  20: ['portfolio', null, 'strong'],
  21: ['portfolio', null, 'strong'],
  22: ['portfolio', null, 'strong'],
  23: ['food_identity', null, 'strong'],
  24: [null, null, 'none', 'The inquiry is at the proposal stage and the key\'s own move is to pause concept work until scope and terms are confirmed. Pushing anything forward here is exactly what it warns against.'],
  25: [null, null, 'moderate', 'The commercial decision is still pending: hold the identity work. Bounded portfolio progress in the waiting time is the one useful alternative.', { acceptable: ['portfolio'], forbidden: ['food_identity'] }],
  26: ['food_identity', null, 'strong'],
  27: ['food_identity', null, 'strong'],
  28: [null, null, 'moderate', 'The identity is waiting on the client\'s response; another broad pass before it arrives is not called for. Other open work may reasonably be picked up.', { acceptable: ['portfolio', 'social_campaign'] }],
  29: [null, null, 'moderate', 'Still waiting on the client\'s response; other open work may reasonably be picked up.', { acceptable: ['portfolio', 'social_campaign'] }],
  30: ['portfolio', null, 'strong'],
};
