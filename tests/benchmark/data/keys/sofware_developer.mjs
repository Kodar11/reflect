// Software developer — work streams, dated profile changes and the stream-level coach key.
// Source of truth for these annotations; `build.mjs` applies them to the day files.

export const streams = {
  billing_api: { title: 'Workspace billing settings API change (through release)', kind: 'work', aliases: ['billing'] },
  webhook_reliability: { title: 'Intermittent webhook processing issue (PLAT-497)', kind: 'work', aliases: ['webhook', 'retry-path', 'retry path', 'plat-497'] },
  workspace_performance: { title: 'Workspace API latency / database performance regression', kind: 'work', aliases: ['workspace', 'latency', 'database performance'] },
  account_export: { title: 'Account export API (PLAT-512)', kind: 'work', aliases: ['account export', 'export', 'plat-512'] },
  admin_audit: { title: 'Admin action audit trail (PLAT-531)', kind: 'work', aliases: ['audit', 'plat-531'] },
  code_review: { title: "Reviewing teammates' pull requests and QA follow-up", kind: 'work', aliases: ['teammate', "teammate's pull request", 'code review'] },
  platform_ops: { title: 'Standups, team coordination and routine platform health checks', kind: 'work', aliases: ['standup', 'platform health', 'health check'] },
};

const P = {
  billing: 'Ship the billing settings API change',
  webhook: 'Understand and fix the recurring webhook processing issue',
  reviews: "Keep the team's pending pull requests moving",
  latency: 'Fix the workspace API latency regression',
  exportApi: 'Build the account export API',
  audit: 'Add an audit trail for admin actions',
};

export const priorities = {
  billing_api: [P.billing],
  webhook_reliability: [P.webhook],
  workspace_performance: [P.latency],
  account_export: [P.exportApi],
  admin_audit: [P.audit],
  code_review: [P.reviews],
};

export function streamOf(text, day) {
  if (/^(team communication|team|team_coordination|platform_operations) \|/.test(text)) return 'platform_ops';
  if (/^(code review|team_maintenance) \|/.test(text)) return 'code_review';
  if (/^engineering_delivery \|/.test(text)) return /teammate|qa /.test(text) ? 'code_review' : day <= 25 ? 'account_export' : 'admin_audit';
  if (/^billing/.test(text)) return 'billing_api';
  if (/^(webhook|release_validation)/.test(text)) return 'webhook_reliability';
  if (/^(workspace|database_performance)/.test(text)) return 'workspace_performance';
  if (/^account_export/.test(text)) return 'account_export';
  if (/^admin_audit/.test(text)) return 'admin_audit';
  return null;
}

const end = (op, priority) => ({ at: 'end', op, priority });
const work = (...current_work) => ({ at: 'end', op: 'set_current_work', current_work });
const REVIEWS = "Reviewing a teammate's pull request";

export const profile = {
  3: [end('add', P.latency), work('Implementing an API change for workspace billing settings', 'Investigating an intermittent webhook processing issue', 'Fixing a workspace API latency regression', REVIEWS)],
  7: [end('complete', P.billing), work('Fixing a workspace API latency regression', 'Investigating an intermittent webhook processing issue', REVIEWS)],
  11: [end('complete', P.latency), work('Investigating an intermittent webhook processing issue', REVIEWS)],
  17: [end('complete', P.webhook), end('remove', P.billing), end('add', P.exportApi), work('Building an account export API', REVIEWS)],
  26: [end('complete', P.exportApi), end('remove', P.latency), end('add', P.audit), work('Adding an audit trail for admin actions', REVIEWS)],
};

export const closed = {
  billing_api: [[8, 30]],
  workspace_performance: [[12, 30]],
  webhook_reliability: [[18, 30]],
  account_export: [[26, 30]],
};

export const coach = {
  1: ['billing_api', 'webhook_reliability', 'strong'],
  2: ['billing_api', null, 'strong'],
  3: ['billing_api', 'workspace_performance', 'strong'],
  4: ['billing_api', 'workspace_performance', 'strong'],
  5: ['billing_api', 'workspace_performance', 'strong'],
  6: ['billing_api', 'workspace_performance', 'strong'],
  7: ['billing_api', 'webhook_reliability', 'strong'],
  8: ['workspace_performance', 'webhook_reliability', 'strong'],
  9: ['workspace_performance', null, 'moderate', 'The change is deployed under controlled measurement; the key\'s own next step is to let the observation window run.'],
  10: ['workspace_performance', 'webhook_reliability', 'strong'],
  11: ['workspace_performance', 'webhook_reliability', 'strong'],
  12: ['webhook_reliability', null, 'strong'],
  13: ['webhook_reliability', null, 'strong'],
  14: ['webhook_reliability', null, 'strong'],
  15: [null, null, 'none', 'The webhook change is released and what remains is evidence gathering: "let the change accumulate enough production data for a closure decision". There is nothing to do before that data exists.'],
  16: ['webhook_reliability', null, 'strong'],
  17: ['account_export', 'webhook_reliability', 'strong'],
  18: ['account_export', null, 'strong'],
  19: ['account_export', null, 'strong'],
  20: ['account_export', null, 'strong'],
  21: ['account_export', null, 'strong'],
  22: ['account_export', null, 'strong'],
  23: ['account_export', null, 'strong'],
  24: ['account_export', null, 'strong'],
  25: ['account_export', null, 'moderate', 'The feature has enough evidence to close; closing it is bookkeeping the engineer was already doing.'],
  26: ['admin_audit', null, 'strong'],
  27: ['admin_audit', null, 'strong'],
  28: ['admin_audit', null, 'strong'],
  29: ['admin_audit', null, 'strong'],
  30: ['admin_audit', null, 'strong'],
};
