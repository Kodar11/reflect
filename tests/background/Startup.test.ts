import { describe, it, expect, vi } from 'vitest';
import {
  BACKGROUND_ARG,
  ShutdownSequence,
  acquireSingleInstance,
  isBackgroundLaunch,
  syncLoginItem,
  type LoginItemApp,
} from '../../src/background/Startup';

const EXE = 'C:\\Program Files\\Productivity Coach\\Productivity Coach.exe';

describe('single instance', () => {
  function fakeApp(lockAvailable: boolean) {
    const listeners: ((event: unknown, argv: string[]) => void)[] = [];
    return {
      requestSingleInstanceLock: vi.fn(() => lockAvailable),
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: (event: unknown, argv: string[]) => void) => listeners.push(listener)),
      /** Another process was launched while this one holds the lock. */
      secondLaunch: (argv: string[]) => listeners.forEach((l) => l({}, argv)),
    };
  }

  it('the first instance takes the lock and carries on', () => {
    const app = fakeApp(true);
    expect(acquireSingleInstance(app, vi.fn())).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('a second instance quits before anything is created — no second tracker, tray or widget', () => {
    const app = fakeApp(false);
    const onUserLaunch = vi.fn();
    expect(acquireSingleInstance(app, onUserLaunch)).toBe(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.on).not.toHaveBeenCalled(); // it does not even listen
    expect(onUserLaunch).not.toHaveBeenCalled();
  });

  it('launching Reflect again shows the running instance', () => {
    const app = fakeApp(true);
    const onUserLaunch = vi.fn();
    acquireSingleInstance(app, onUserLaunch);
    app.secondLaunch([EXE]);
    expect(onUserLaunch).toHaveBeenCalledTimes(1);
  });

  it('a second background launch (sign-in while already running) opens nothing', () => {
    const app = fakeApp(true);
    const onUserLaunch = vi.fn();
    acquireSingleInstance(app, onUserLaunch);
    app.secondLaunch([EXE, BACKGROUND_ARG]);
    expect(onUserLaunch).not.toHaveBeenCalled();
  });
});

describe('background launch', () => {
  it('the login item starts Reflect without the main window; a normal launch shows it', () => {
    expect(isBackgroundLaunch([EXE, BACKGROUND_ARG])).toBe(true);
    expect(isBackgroundLaunch([EXE])).toBe(false);
    expect(isBackgroundLaunch(['electron.exe', '.', '--dev'])).toBe(false);
  });
});

describe('start with Windows', () => {
  function fakeApp(initial: { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean }) {
    const state = { ...initial };
    const app: LoginItemApp & { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(),
      set: vi.fn(),
      getLoginItemSettings: (options) => {
        app.get(options);
        return state;
      },
      setLoginItemSettings: (settings) => {
        app.set(settings);
        state.openAtLogin = settings.openAtLogin;
      },
    };
    return app;
  }

  it('registers a per-user login item that starts in the background', () => {
    const app = fakeApp({ openAtLogin: false });
    expect(syncLoginItem(app, { enabled: true, isPackaged: true, execPath: EXE })).toEqual({ action: 'registered', disabledBySystem: false });
    expect(app.set).toHaveBeenCalledWith({ openAtLogin: true, path: `"${EXE}"`, args: [BACKGROUND_ARG] });
  });

  it('quotes the executable path, which contains spaces once installed', () => {
    const app = fakeApp({ openAtLogin: false });
    syncLoginItem(app, { enabled: true, isPackaged: true, execPath: EXE });
    const { path } = app.set.mock.calls[0][0];
    expect(path.startsWith('"') && path.endsWith('"')).toBe(true);
    // Reading and writing use the same form, or the entry would never be recognised as ours.
    expect(app.get).toHaveBeenCalledWith({ path, args: [BACKGROUND_ARG] });
  });

  it('removes it when the user turns the setting off', () => {
    const app = fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: true });
    expect(syncLoginItem(app, { enabled: false, isPackaged: true, execPath: EXE }).action).toBe('removed');
    expect(app.set).toHaveBeenCalledWith({ openAtLogin: false, path: `"${EXE}"`, args: [BACKGROUND_ARG] });
  });

  it('writes nothing when the system already matches the setting', () => {
    const on = fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: true });
    expect(syncLoginItem(on, { enabled: true, isPackaged: true, execPath: EXE }).action).toBe('unchanged');
    const off = fakeApp({ openAtLogin: false });
    expect(syncLoginItem(off, { enabled: false, isPackaged: true, execPath: EXE }).action).toBe('unchanged');
    expect(on.set).not.toHaveBeenCalled();
    expect(off.set).not.toHaveBeenCalled();
  });

  it('follows the executable after an update or reinstall', () => {
    // Windows reports "not registered" for this path: the entry points at the old location.
    const app = fakeApp({ openAtLogin: false });
    const newExe = 'D:\\Apps\\Productivity Coach\\Productivity Coach.exe';
    syncLoginItem(app, { enabled: true, isPackaged: true, execPath: newExe });
    expect(app.get).toHaveBeenCalledWith({ path: `"${newExe}"`, args: [BACKGROUND_ARG] });
    expect(app.set).toHaveBeenCalledWith({ openAtLogin: true, path: `"${newExe}"`, args: [BACKGROUND_ARG] });
  });

  it('does not fight an entry the user disabled in Windows itself', () => {
    const app = fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: false });
    expect(syncLoginItem(app, { enabled: true, isPackaged: true, execPath: EXE })).toEqual({ action: 'unchanged', disabledBySystem: true });
    expect(app.set).not.toHaveBeenCalled();
  });

  it('never touches the startup configuration from a development build', () => {
    const app = fakeApp({ openAtLogin: false });
    expect(syncLoginItem(app, { enabled: true, isPackaged: false, execPath: 'node_modules\\electron\\dist\\electron.exe' })).toEqual({
      action: 'skipped-development',
      disabledBySystem: false,
    });
    expect(app.get).not.toHaveBeenCalled();
    expect(app.set).not.toHaveBeenCalled();
  });
});

describe('shutdown sequence', () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });

  it('runs the steps in order, waiting for each', async () => {
    const order: string[] = [];
    const step = (name: string, ms = 0) => ({
      name,
      run: async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
      },
    });
    const sequence = new ShutdownSequence(
      [step('tracking', 15), step('schedulers'), step('focus', 5), step('widget'), step('tray'), step('database')],
      log(),
    );
    await sequence.run();
    expect(order).toEqual(['tracking', 'schedulers', 'focus', 'widget', 'tray', 'database']);
  });

  it('runs once: a second quit request joins the shutdown already in progress', async () => {
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const sequence = new ShutdownSequence([{ name: 'tracking', run }], log());
    expect(sequence.started).toBe(false);
    const first = sequence.run();
    const second = sequence.run(); // before-quit arriving while the tray's Quit is still running
    expect(sequence.started).toBe(true);
    await Promise.all([first, second]);
    await sequence.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failing step is logged and the rest still run — the database is always closed', async () => {
    const logger = log();
    const closed = vi.fn();
    const sequence = new ShutdownSequence(
      [
        {
          name: 'focus',
          run: () => {
            throw new Error('helper pipe broken');
          },
        },
        { name: 'widget', run: () => Promise.reject(new Error('already destroyed')) },
        { name: 'database', run: closed },
      ],
      logger,
    );
    await expect(sequence.run()).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[0][0]).toContain('"focus"');
  });
});
