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
}