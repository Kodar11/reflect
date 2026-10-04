import type { VerifiedSessionDto } from '../../src/timeline/timelineIpc';

/** Local midnight of the fixture day; all fixture times are local wall-clock. */
export const DAY = new Date(2026, 9, 4);

/** `at('17:23:31')` → ISO string on the fixture day. */
export function at(hms: string): string {
  const [h, m, s = 0] = hms.split(':').map(Number);
  return new Date(2026, 9, 4, h, m, s).toISOString();
}

let nextEventId = 1;

export function session(id: string, start: string, end: string, overrides: Partial<VerifiedSessionDto> = {}): VerifiedSessionDto {
  const startedAt = at(start);
  const endedAt = at(end);
  const duration = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return {
    id,
    startedAt,
    endedAt,
    duration,
    activeDuration: Math.max(0, duration),
    eventCount: 1,
    title: `Activity ${id}`,
    isCustomTitle: false,
    primaryApp: 'App',
    primaryBrowser: null,
    primaryTitle: `Activity ${id}`,
    primaryUrl: null,
    appsUsed: ['App'],
    browserTabs: [],
    source: 'generated',
    eventIds: [nextEventId++],
    ...overrides,
  };
}

/**
 * A real dense day, reduced to its shape: long blocks, a burst of ten
 * sub-five-minute activities, one-second tab switches (one nested inside a
 * long block), a zero-length activity, a few genuinely overlapping ranges
 * after midnight, and one inverted range left behind by a system-clock change.
 */
export function denseDay(): VerifiedSessionDto[] {
  const rows: [string, string, string][] = [
    ['00:00:03', '00:08:05', 'Project work with an assistant'],
    ['00:05:13', '00:05:14', 'New Tab'],
    ['00:05:14', '00:07:38', 'Browse media'],
    ['00:07:38', '00:13:13', 'Project configuration'],
    ['00:12:23', '00:12:42', 'Quick web check'],
    ['00:12:42', '00:30:17', 'Project work, second pass'],
    ['00:40:58', '00:45:33', 'Review the coach'],
    ['00:45:33', '00:58:03', 'Watch a tournament video'],
    ['00:58:03', '00:59:24', 'Review project documentation'],
    ['00:59:24', '00:01:24', 'Change date and time'],
    ['15:17:36', '15:21:52', 'Use the coach and an assistant'],
    ['15:21:52', '15:23:11', 'Review timeline and reflection'],
    ['15:23:11', '17:14:33', 'Work with an assistant'],
    ['17:14:33', '17:23:31', 'Reflect via chat'],
    ['17:23:31', '17:23:32', 'New Tab'],
    ['17:23:32', '17:27:49', 'Researching tools for thinking on video sites and reference pages'],
    ['17:27:49', '17:28:47', 'Dataset work planning'],
    ['17:28:47', '17:33:56', 'Watching educational videos'],
    ['17:33:56', '17:35:34', 'Physics simulation'],
    ['17:35:34', '17:35:39', 'Budget simulation'],
    ['17:35:39', '17:36:27', 'Video browsing'],
    ['17:36:27', '17:41:24', 'Music listening and dataset work'],
    ['17:41:24', '17:42:17', 'Checking a wiki'],
    ['17:42:17', '17:46:22', 'Streaming and dataset work'],
    ['17:46:22', '18:33:11', 'JSON generation with chat and an editor'],
    ['18:33:11', '19:21:27', 'Development and coursework research'],
    ['18:59:58', '18:59:59', 'New Tab'],
    ['19:21:27', '19:24:22', 'Messaging and brief browsing'],
    ['19:24:22', '20:50:11', 'Project development and planning in chat and the productivity coach'],
    ['20:50:11', '20:50:11', 'Project tab'],
    ['20:50:11', '20:58:10', 'Watching a show'],
    ['20:58:10', '20:59:12', 'Working with an assistant'],
    ['20:59:12', '21:02:53', 'Chat and video browsing'],
    ['21:02:53', '21:07:29', 'Project tab'],
    ['21:09:08', '21:48:55', 'Lock screen'],
    ['21:48:55', '22:01:16', 'Watching a match'],
  ];
  return rows.map(([start, end, title], i) => session(`d${String(i).padStart(2, '0')}`, start, end, { title, primaryTitle: title }));
}
