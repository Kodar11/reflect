import { describe, it, expect, vi } from 'vitest';
import { AppSettingsStore, DEFAULT_APP_SETTINGS, normalizeAppSettings } from '../../src/background/AppSettings';
import { FakeSettingsRepository, makeSettings } from './helpers';

describe('application settings', () => {
  it('defaults: start with Windows, tracking, widget and notifications are all on', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      startWithWindows: true,
      trackingPause: null,
      widgetEnabled: true,
      widgetPosition: null,
      notificationsEnabled: true,
    });
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('coerces stored or renderer-supplied junk into valid settings', () => {
    const settings = normalizeAppSettings({
      startWithWindows: 'yes',
      widgetEnabled: false,
      widgetPosition: { x: 12.6, y: 'top' },
      trackingPause: { since: 'not a date', until: null },
      notificationsEnabled: 0,
      somethingElse: true,
    });
    expect(settings).toEqual({ ...DEFAULT_APP_SETTINGS, widgetEnabled: false });

    expect(
      normalizeAppSettings({ widgetPosition: { x: 12.6, y: 40 }, trackingPause: { since: '2026-10-05T09:00:00.000Z', until: 'garbage' } }),
    ).toMatchObject({ widgetPosition: { x: 13, y: 40 }, trackingPause: { since: '2026-10-05T09:00:00.000Z', until: null } });
  });

  it('persists every change, so the main process can read it with no window open', () => {
    const repo = new FakeSettingsRepository();
    const store = new AppSettingsStore(repo);
    store.update({ startWithWindows: false, widgetPosition: { x: 100, y: 200 } });

    // A new store over the same storage is the app after a restart.
    const afterRestart = new AppSettingsStore(repo);
    expect(afterRestart.get()).toMatchObject({ startWithWindows: false, widgetPosition: { x: 100, y: 200 }, widgetEnabled: true });
  });

  it('announces changes with the previous value and skips no-op writes', () => {
    const { repo, store } = makeSettings();
    const listener = vi.fn();
    store.onChanged(listener);

    store.update({ widgetEnabled: true }); // already true
    expect(listener).not.toHaveBeenCalled();
    expect(repo.saves).toBe(0);

    store.update({ widgetEnabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].widgetEnabled).toBe(false);
    expect(listener.mock.calls[0][1].widgetEnabled).toBe(true);
    expect(repo.saves).toBe(1);
  });

  it('a storage failure is logged, not thrown: the change still applies for this run', () => {
    const repo = new FakeSettingsRepository();
    const log = vi.fn();
    const store = new AppSettingsStore(repo, { log });
    repo.failWrites = true;

    expect(() => store.update({ notificationsEnabled: false })).not.toThrow();
    expect(store.get().notificationsEnabled).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not save settings'));
  });

  it('unreadable storage falls back to the defaults', () => {
    const log = vi.fn();
    const store = new AppSettingsStore(
      {
        getSettings: () => {
          throw new Error('malformed database');
        },
        saveSettings: () => {},
      },
      { log },
    );
    expect(store.get()).toEqual(DEFAULT_APP_SETTINGS);
    expect(log).toHaveBeenCalled();
  });

  it('a failing listener does not stop the others', () => {
    const { store } = makeSettings();
    const second = vi.fn();
    store.onChanged(() => {
      throw new Error('tray is gone');
    });
    store.onChanged(second);
    expect(() => store.update({ widgetEnabled: false })).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});
