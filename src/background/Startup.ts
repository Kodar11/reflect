/**
 * How Reflect starts: once, and quietly.
 *
 * - One instance. A second launch never builds a second tracker, tray or
 *   widget — it hands over to the running instance and exits.
 * - Started by Windows at sign-in, Reflect comes up in the background: the
 *   runtime, the tray and the widget, but no main window.
 * - "Start with Windows" is a per-user login item (a Run entry) — no service,
 *   no administrator rights. It is only ever registered by the packaged app,
 *   so running the development build never touches the developer's startup.
 */

/** Passed by the login item: start without opening the main window. */
export const BACKGROUND_ARG = '--background';

export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_ARG);
}

// ── Single instance ──────────────────────────────────────────────────────────

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): unknown;
}

/**
 * Take the single-instance lock. Returns false when another Reflect is
 * already running — the caller must then start nothing at all.
 *
 * When the user launches Reflect again, the running instance shows its
 * window. A second background launch (sign-in while already running) is
 * ignored.
 */
export function acquireSingleInstance(app: SingleInstanceApp, onUserLaunch: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', (_event, argv) => {
    if (!isBackgroundLaunch(argv ?? [])) onUserLaunch();
  });
  return true;
}

// ── Start with Windows ───────────────────────────────────────────────────────

export interface LoginItemApp {
  getLoginItemSettings(options: { path: string; args: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void;
}

export interface LoginItemResult {
  /** What was done to the system's startup configuration. */
  action: 'registered' | 'removed' | 'unchanged' | 'skipped-development';
  /** Registered by Reflect, but switched off by the user in Windows' own startup settings. */
  disabledBySystem: boolean;
}

/**
 * Make the system's login item match the stored preference.
 *
 * Called at every start (so the entry follows the executable after an update
 * or reinstall) and whenever the setting changes. It only writes when
 * something actually differs: an entry the user disabled in Task Manager is
 * left disabled rather than being switched back on at each launch.
 */
export function syncLoginItem(
  app: LoginItemApp,
  options: { enabled: boolean; isPackaged: boolean; execPath: string },
): LoginItemResult {
  if (!options.isPackaged) return { action: 'skipped-development', disabledBySystem: false };

  // The path is quoted: Electron writes it into the Run entry as given, and an
  // install path contains spaces ("Program Files\Productivity Coach\…").
  const item = { path: `"${options.execPath}"`, args: [BACKGROUND_ARG] };
  const current = app.getLoginItemSettings(item);

  if (options.enabled && !current.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, ...item });
    return { action: 'registered', disabledBySystem: false };
  }
  if (!options.enabled && current.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false, ...item });
    return { action: 'removed', disabledBySystem: false };
  }
  return {
    action: 'unchanged',
    disabledBySystem: options.enabled && current.openAtLogin && current.executableWillLaunchAtLogin === false,
  };
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

/**
 * The real quit, in a fixed order. Each step runs even if an earlier one
 * failed, and the whole sequence runs once: a second request (the tray's
 * Quit followed by Electron's own `before-quit`, or Windows ending the
 * session at the same time) joins the run already in progress.
 */
export class ShutdownSequence {
  private running: Promise<void> | null = null;

  constructor(
    private readonly steps: ShutdownStep[],
    private readonly log: { info(m: string): void; error(m: string): void },
  ) {}

  get started(): boolean {
    return this.running !== null;
  }

  run(): Promise<void> {
    this.running ??= this.execute();
    return this.running;
  }

  private async execute(): Promise<void> {
    this.log.info('[APP] Quit requested — shutting down the background runtime.');
    for (const step of this.steps) {
      try {
        await step.run();
      } catch (err) {
        this.log.error(`[APP] Shutdown step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
