type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

/** Minimal DTO the renderer sees for each stored raw event. Mirrors `Event`
 * but kept separate so the DB layer's types never leak into renderer typings. */
interface TrackerEventDto {
  id: number;
  watcher: string;
  startedAt: string;
  endedAt: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  payload: string | null;
  createdAt: string | null;
}

/** Derived session DTO. Sessions exist only in memory and are re-derived from
 * raw events on each query; the renderer never imports the engine. */
interface SessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
}

/** Verified-session DTO for the timeline. Carries custom-title flag and
 * source so the UI can show generated vs user (offline) sessions identically
 * per spec, with only metadata differing. */
interface VerifiedSessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  title: string;
  isCustomTitle: boolean;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
  source: 'generated' | 'user';
  note?: string;
  eventIds: number[];
}

interface TimelineStatus {
  activeEdits: number;
}

interface Window {
  app: {
    sendFrameAction: (payload: FrameWindowAction) => void;
  };
  tracker: {
    getToday: () => Promise<TrackerEventDto[]>;
    getRange: (from: string, to: string) => Promise<TrackerEventDto[]>;
    getAll: (limit?: number) => Promise<TrackerEventDto[]>;
  };
  session: {
    getToday: () => Promise<SessionDto[]>;
    getRange: (from: string, to: string) => Promise<SessionDto[]>;
    getAll: (limit?: number) => Promise<SessionDto[]>;
  };
  timeline: {
    getToday: () => Promise<VerifiedSessionDto[]>;
    getRange: (from: string, to: string) => Promise<VerifiedSessionDto[]>;
    getAll: (limit?: number) => Promise<VerifiedSessionDto[]>;
    apply: (p: { operation: string; payload: unknown }) => Promise<{ ok: boolean }>;
    undo: () => Promise<{ ok: boolean }>;
    redo: () => Promise<{ ok: boolean }>;
    status: () => Promise<TimelineStatus>;
  };
}