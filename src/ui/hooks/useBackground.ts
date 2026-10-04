import { useCallback, useEffect, useState } from 'react';

/**
 * The background runtime's status, as the main process reports it. This hook
 * only mirrors it for rendering — tracking, the widget and notifications are
 * owned by the main process and carry on whether or not this is mounted.
 */
export function useBackgroundStatus(): BackgroundStatusDto | null {
  const [status, setStatus] = useState<BackgroundStatusDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.background
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => console.error('[background] failed to load status', e));
    const subscription = window.background.onStatus(setStatus);
    return () => {
      cancelled = true;
      window.background.offStatus(subscription);
    };
  }, []);

  return status;
}

export interface UseBackgroundSettings {
  settings: BackgroundSettingsDto | null;
  update: (patch: BackgroundSettingsPatchDto) => Promise<void>;
}

/** The background preferences. `refreshKey` re-reads them when something outside this window changed them (the tray, the widget). */
export function useBackgroundSettings(refreshKey?: unknown): UseBackgroundSettings {
  const [settings, setSettings] = useState<BackgroundSettingsDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.background
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => console.error('[background] failed to load settings', e));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const update = useCallback(async (patch: BackgroundSettingsPatchDto) => {
    try {
      setSettings(await window.background.updateSettings(patch));
    } catch (e) {
      console.error('[background] failed to save settings', e);
    }
  }, []);

  return { settings, update };
}
