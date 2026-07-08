type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

/** Minimal DTO the renderer sees for each stored event. Mirrors `Event` but
 * kept separate so the DB layer's types never leak into renderer typings. */
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

interface Window {
  app: {
    sendFrameAction: (payload: FrameWindowAction) => void;
  };
  tracker: {
    getToday: () => Promise<TrackerEventDto[]>;
    getRange: (from: string, to: string) => Promise<TrackerEventDto[]>;
    getAll: (limit?: number) => Promise<TrackerEventDto[]>;
  };
}