// Content creator — work streams, dated profile changes and the stream-level coach key.
// Source of truth for these annotations; `build.mjs` applies them to the day files.

export const streams = {
  api_video: { title: 'Video: "Why APIs Feel Slow"', kind: 'work', aliases: ['apis feel slow', 'api video', 'api-performance', 'api performance'] },
  redis_video: { title: 'Video: Redis / caching follow-up', kind: 'work', aliases: ['redis', 'cache stampede'] },
  pg_indexes_video: { title: 'Video: PostgreSQL indexes', kind: 'work', aliases: ['postgresql indexes', 'indexes video', 'indexing video', 'query planner'] },
  pg_partial_video: { title: 'Video: PostgreSQL partial-index follow-up', kind: 'work', aliases: ['partial index', 'partial-index', 'partial indexes'] },
  indexing_mistakes_video: { title: 'Video: PostgreSQL indexing mistakes', kind: 'work', aliases: ['indexing mistakes', 'indexing-mistakes'] },
  background_jobs_video: { title: 'Video: background jobs / idempotency', kind: 'work', aliases: ['background jobs', 'background-jobs', 'idempotency'] },
  sponsorship: { title: 'Sponsor inquiries and the sponsored database-tool short', kind: 'work', aliases: ['sponsor', 'sponsored', 'sponsorship'] },
  next_video_planning: { title: 'Choosing and validating the next video', kind: 'work', aliases: ['next video', 'next project', 'backlog', 'composite-index', 'composite index', 'candidate topic'] },
  channel_ops: { title: 'Channel upkeep: inbox, comments, community, analytics', kind: 'work', aliases: ['analytics', 'comments', 'community', 'inbox'] },
  learning: { title: 'General technical and creator learning', kind: 'work', aliases: [] },
  leisure: { title: 'Entertainment and social browsing', kind: 'leisure', aliases: [] },
  personal: { title: 'Personal and offline time', kind: 'personal', aliases: [] },
};

const P = {
  video: 'Make measurable progress on the next big technical video',
  community: 'Keep audience/community maintenance lightweight',
  ideas: 'Keep idea collection and analytics from replacing production',
  sponsor: 'Deliver the sponsored database-tool short on time',
};

/** The standing priority "the next big technical video" is whichever video is in production. */
export const priorities = {
  api_video: [P.video],
  redis_video: [P.video],
  pg_indexes_video: [P.video],
  pg_partial_video: [P.video],
  indexing_mistakes_video: [P.video],
  background_jobs_video: [P.video],
  sponsorship: [P.sponsor],
  next_video_planning: [P.ideas, P.video],
  channel_ops: [P.community],
};

/** The video in production on each day (where a production step does not name its video). */
const videoOfDay = (day) =>
  day <= 5 ? 'api_video' : day <= 10 ? 'redis_video' : day <= 16 ? 'pg_indexes_video' : day <= 21 ? 'pg_partial_video' : day <= 25 ? 'indexing_mistakes_video' : 'background_jobs_video';

export function streamOf(text, day) {
  const area = text.split(' | ')[0];
  if (/^personal/.test(area)) return 'personal';
  if (/^leisure$|^learning_and_leisure$/.test(area) || /recreation|entertainment|general instagram browsing|social browsing only/.test(text)) return 'leisure';
  if (/^creator_learning$/.test(area)) return 'learning';
  if (/sponsor/.test(text)) return 'sponsorship';
  if (/redis|caching/.test(text)) return 'redis_video';
  if (/partial-index|partial index/.test(text)) return 'pg_partial_video';
  if (/indexing-mistakes|indexing mistakes/.test(text)) return 'indexing_mistakes_video';
  if (/background-jobs|background jobs|idempotency/.test(text)) return 'background_jobs_video';
  if (/composite-index|candidate|next-video|next-project|backlog|topic decision|possible (follow-up|next)|idea/.test(text) || /^(ideation|ideation_and_research|research_and_ideation|project_management_and_ideation|ideation_and_scripting|ideation_and_outlining|outlining_and_research)$/.test(area)) {
    return 'next_video_planning';
  }
  if (/^(creator_operations|analytics|community|communication)/.test(area) || /^(publishing_and_creator_operations|analytics_and_ideation)$/.test(area)) return 'channel_ops';
  if (/^publishing/.test(area) && /check|confirmation|status|inbox/.test(text)) return 'channel_ops';
  if (/script|record|edit|thumbnail|outlin|research|publish|production|project_management|packaging|design_and/.test(area)) return videoOfDay(day);
  return null;
}

const end = (op, priority) => ({ at: 'end', op, priority });
const CHANNEL = 'Maintaining the YouTube channel and audience responses';
const IDEAS = 'Collecting ideas for future backend-development videos';
const work = (first, ...more) => ({ at: 'end', op: 'set_current_work', current_work: [first, ...more, CHANNEL, IDEAS] });

/** The creator's three priorities are standing ones; what changes is the video in production, and one sponsored deliverable. */
export const profile = {
  6: [work('Developing a follow-up video on Redis and caching pitfalls')],
  11: [work('Developing a video on how PostgreSQL indexes work')],
  17: [work('Developing a follow-up video on PostgreSQL partial indexes')],
  18: [end('add', P.sponsor), work('Developing a follow-up video on PostgreSQL partial indexes', 'Producing a sponsored short for a database tool')],
  21: [end('complete', P.sponsor)],
  22: [work('Developing a video on common PostgreSQL indexing mistakes')],
  27: [end('remove', P.sponsor), work('Developing a video on background jobs and idempotency')],
};

export const closed = {
  api_video: [[6, 30]],
  redis_video: [[11, 30]],
  pg_indexes_video: [[17, 30]],
  pg_partial_video: [[22, 30]],
  indexing_mistakes_video: [[26, 30]],
  sponsorship: [[11, 17]],
};

export const coach = {
  1: ['api_video', null, 'strong'],
  2: ['api_video', null, 'strong'],
  3: ['api_video', null, 'strong'],
  4: ['api_video', 'sponsorship', 'strong'],
  5: ['api_video', null, 'strong'],
  6: ['redis_video', null, 'strong'],
  7: ['redis_video', null, 'strong'],
  8: ['redis_video', null, 'strong'],
  9: ['redis_video', null, 'strong'],
  10: ['next_video_planning', null, 'strong', null, { acceptable: ['pg_indexes_video'] }],
  11: ['pg_indexes_video', null, 'strong', null, { acceptable: ['next_video_planning'] }],
  12: ['pg_indexes_video', null, 'strong'],
  13: ['pg_indexes_video', null, 'strong'],
  14: ['pg_indexes_video', null, 'strong'],
  15: ['pg_indexes_video', null, 'strong'],
  16: [null, null, 'none', 'The video was published today and the key\'s own move is to let it gather audience signal before another production cycle starts. There is nothing to push forward.'],
  17: ['pg_partial_video', null, 'strong'],
  18: ['pg_partial_video', 'sponsorship', 'strong'],
  19: ['pg_partial_video', null, 'strong'],
  20: ['sponsorship', 'pg_partial_video', 'strong'],
  21: [null, null, 'none', 'Two deliverables were closed today; the next useful information is the audience response to the scheduled video. The key says not to start another project before it.'],
  22: ['indexing_mistakes_video', null, 'strong', null, { acceptable: ['next_video_planning'] }],
  23: ['indexing_mistakes_video', null, 'strong'],
  24: ['indexing_mistakes_video', null, 'strong'],
  25: ['next_video_planning', null, 'moderate', 'The finished video is scheduled; whether the audience question becomes the next project is a decision the key says to take after the release.'],
  26: ['next_video_planning', null, 'strong', null, { acceptable: ['background_jobs_video'] }],
  27: ['background_jobs_video', null, 'strong'],
  28: ['background_jobs_video', null, 'strong'],
  29: ['background_jobs_video', null, 'strong'],
  30: [null, null, 'none', 'Another multi-day video was completed and scheduled; the key\'s own move is to wait for audience response rather than start a new production to keep momentum.'],
};
