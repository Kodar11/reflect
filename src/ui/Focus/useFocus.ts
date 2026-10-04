import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cleanIpcError } from './focusView';

export { formatClock } from './focusView';
export type { FocusMode } from './focusView';

// The DTO shapes are declared globally in types.d.ts; re-exported under the
// names the Focus components import.
type ProfileDto = FocusProfileDto;
type ProfileRuleDto = FocusProfileRuleDto;
type RuleDto = FocusRuleDto;
type SessionDto = FocusSessionDto;
type ActiveDto = ActiveFocusSessionDto;
type SummaryDto = FocusSummaryDto;
type PreferencesDto = FocusPreferencesDto;
type EndChallengeDto = EndFocusChallengeDto;
type IntentDto = FocusIntentDto;
export type {
  ProfileDto as FocusProfileDto,
  ProfileRuleDto as FocusProfileRuleDto,
  RuleDto as FocusRuleDto,
  SessionDto as FocusSessionDto,
  ActiveDto as ActiveFocusSessionDto,
  SummaryDto as FocusSummaryDto,
  PreferencesDto as FocusPreferencesDto,
  EndChallengeDto as EndFocusChallengeDto,
  IntentDto as FocusIntentDto,
};

export interface StartFocusRequest {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: 'stopwatch' | 'countdown';
  plannedDurationMinutes?: number | null;
  withoutBlocking?: boolean;
}

export interface NewBlock {
  profileId?: string | null;
  type: FocusRuleDto['type'];
  target: string;
  action?: FocusRuleDto['action'];
}

/** The operation currently in flight; controls stay disabled meanwhile. */
export type FocusBusy = 'starting' | 'pausing' | 'resuming' | 'ending' | 'restoring';

export const FALLBACK_PREFERENCES: PreferencesDto = {
  defaultProfileId: null,
  idleAutoPause: true,
  idleThresholdSeconds: 120,
  idleAutoResume: true,
  notifyStart: false,
  notifyIdle: true,
  notifyComplete: true,
  notifyBlocked: true,
};

export interface UseFocusResult {
  /** False until the first load finished — render nothing session-specific before. */
  ready: boolean;
  profiles: ProfileDto[];
  rules: RuleDto[];
  preferences: PreferencesDto;
  activeSession: ActiveDto | null;
  summary: SummaryDto | null;
  dismissSummary: () => void;
  /** Show the summary of a past session (from the Timeline). */
  showSummaryFor: (sessionId: string) => Promise<void>;
  busy: FocusBusy | null;
  error: string | null;
  clearError: () => void;
  /** Blocking left behind by an earlier session is still in place. */
  blockingResidue: boolean;
  clearBlockingResidue: () => Promise<void>;
  /** A request from the tray to open a specific flow; `nonce` makes repeats distinct. */
  intent: { kind: IntentDto; nonce: number } | null;
  consumeIntent: () => void;
  /** The same request, arriving through the main window's navigation (tray, widget). */
  requestIntent: (kind: IntentDto) => void;
  refresh: () => Promise<void>;
  start: (request: StartFocusRequest) => Promise<boolean>;
  pause: (reason?: string | null) => Promise<boolean>;
  resume: () => Promise<boolean>;
  requestEnd: () => Promise<EndChallengeDto | null>;
  confirmEnd: (request: { token: string; phrase?: string | null; reason?: string | null }) => Promise<string | null>;
  restoreBlocking: () => Promise<void>;
  savePreferences: (preferences: PreferencesDto) => Promise<void>;
  /** Categories, open apps and recent sites the blocking editor can offer. */
  blockingOptions: FocusBlockingOptionsDto | null;
  loadBlockingOptions: () => Promise<void>;
  /** Resolves to null on success or to the reason it was refused. */
  addBlock: (block: NewBlock) => Promise<string | null>;
  setProfileBlock: (profileId: string, ruleId: string, on: boolean) => Promise<void>;
  /** `ruleIds: null` keeps the profile's current rules. */
  saveProfile: (profile: ProfileDto, ruleIds: string[] | null) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  saveRule: (rule: RuleDto) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  getSessionsByRange: (from: string, to: string) => Promise<SessionDto[]>;
  getSessionsForDay: (isoDate: string) => Promise<SessionDto[]>;
  getHistory: (limit?: number) => Promise<SessionDto[]>;
  getSessionSummary: (sessionId: string) => Promise<SummaryDto | null>;
}

export function useFocus(): UseFocusResult {
  const [ready, setReady] = useState(false);
  const [profiles, setProfiles] = useState<ProfileDto[]>([]);
  const [rules, setRules] = useState<RuleDto[]>([]);
  const [preferences, setPreferences] = useState<PreferencesDto>(FALLBACK_PREFERENCES);
  const [activeSession, setActiveSession] = useState<ActiveDto | null>(null);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [busy, setBusy] = useState<FocusBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockingResidue, setBlockingResidue] = useState(false);
  const [intent, setIntent] = useState<{ kind: IntentDto; nonce: number } | null>(null);
  const [blockingOptions, setBlockingOptions] = useState<FocusBlockingOptionsDto | null>(null);
  // Guards against double-clicks; the service enforces the same thing.
  const busyRef = useRef<FocusBusy | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [profileList, ruleList, active, prefs, residue] = await Promise.all([
        window.focusMode.listProfiles(),
        window.focusMode.listRules(),
        window.focusMode.getActiveSession(),
        window.focusMode.getPreferences(),
        window.focusMode.getBlockingResidue(),
      ]);
      setProfiles(profileList);
      setRules(ruleList);
      setActiveSession(active);
      setPreferences(prefs);
      setBlockingResidue(residue);
    } catch (e) {
      setError(cleanIpcError(e));
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChange = (dto: ActiveDto | null) => {
      setActiveSession(dto);
      // A session just ended: check whether its blocking was fully released.
      if (!dto) window.focusMode.getBlockingResidue().then(setBlockingResidue).catch(() => {});
    };
    const onSummary = (dto: SummaryDto) => setSummary(dto);
    const onIntent = (kind: IntentDto) => setIntent({ kind, nonce: Date.now() });
    window.focusMode.onActiveSessionChanged(onChange);
    window.focusMode.onSummary(onSummary);
    window.focusMode.onIntent(onIntent);
    return () => {
      window.focusMode.offActiveSessionChanged(onChange);
      window.focusMode.offSummary(onSummary);
      window.focusMode.offIntent(onIntent);
    };
  }, [refresh]);

  /** Run one session operation at a time; returns whether it succeeded. */
  const run = useCallback(async (kind: FocusBusy, op: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = kind;
    setBusy(kind);
    setError(null);
    try {
      await op();
      return true;
    } catch (e) {
      setError(cleanIpcError(e));
      return false;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const start = useCallback(
    (request: StartFocusRequest) =>
      run('starting', async () => {
        setActiveSession(await window.focusMode.start(request));
      }),
    [run],
  );

  const pause = useCallback(
    (reason?: string | null) =>
      run('pausing', async () => {
        setActiveSession(await window.focusMode.pause(reason ?? null));
      }),
    [run],
  );

  const resume = useCallback(
    () =>
      run('resuming', async () => {
        setActiveSession(await window.focusMode.resume());
      }),
    [run],
  );

  const requestEnd = useCallback(async () => {
    try {
      setError(null);
      return await window.focusMode.requestEnd();
    } catch (e) {
      setError(cleanIpcError(e));
      return null;
    }
  }, []);

  /** Resolves to null on success, or to the reason the service refused. */
  const confirmEnd = useCallback(async (request: { token: string; phrase?: string | null; reason?: string | null }) => {
    if (busyRef.current) return 'Please wait…';
    busyRef.current = 'ending';
    setBusy('ending');
    try {
      await window.focusMode.confirmEnd(request);
      setActiveSession(null);
      return null;
    } catch (e) {
      return cleanIpcError(e);
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const restoreBlocking = useCallback(async () => {
    await run('restoring', async () => {
      const dto = await window.focusMode.restoreBlocking();
      if (dto) setActiveSession(dto);
    });
  }, [run]);

  const clearBlockingResidue = useCallback(async () => {
    try {
      setError(null);
      setBlockingResidue(await window.focusMode.clearBlockingResidue());
    } catch (e) {
      setError(cleanIpcError(e));
    }
  }, []);

  const savePreferences = useCallback(async (next: PreferencesDto) => {
    setPreferences(next);
    try {
      setPreferences(await window.focusMode.savePreferences(next));
    } catch (e) {
      setError(cleanIpcError(e));
    }
  }, []);

  const loadBlockingOptions = useCallback(async () => {
    try {
      setBlockingOptions(await window.focusMode.getBlockingOptions());
    } catch {
      // Suggestions are a convenience; the editor works without them.
    }
  }, []);

  const addBlock = useCallback(
    async (block: NewBlock) => {
      try {
        await window.focusMode.addBlock(block);
        await refresh();
        return null;
      } catch (e) {
        return cleanIpcError(e);
      }
    },
    [refresh],
  );

  const setProfileBlock = useCallback(
    async (profileId: string, ruleId: string, on: boolean) => {
      try {
        await window.focusMode.setProfileBlock(profileId, ruleId, on);
        await refresh();
      } catch (e) {
        setError(cleanIpcError(e));
      }
    },
    [refresh],
  );

  const getSessionsByRange = useCallback((from: string, to: string) => window.focusMode.getSessionsByRange(from, to), []);
  const getSessionsForDay = useCallback((isoDate: string) => window.focusMode.getSessionsForDay(isoDate), []);
  const getHistory = useCallback((limit?: number) => window.focusMode.getHistory(limit), []);
  const getSessionSummary = useCallback((sessionId: string) => window.focusMode.getSessionSummary(sessionId), []);

  const showSummaryFor = useCallback(async (sessionId: string) => {
    try {
      const dto = await window.focusMode.getSessionSummary(sessionId);
      if (dto) setSummary(dto);
    } catch (e) {
      setError(cleanIpcError(e));
    }
  }, []);

  const mutate = useCallback(
    async (op: () => Promise<unknown>) => {
      try {
        await op();
        await refresh();
      } catch (e) {
        const message = cleanIpcError(e);
        setError(message);
        throw new Error(message);
      }
    },
    [refresh],
  );

  const saveProfile = useCallback((profile: ProfileDto, ruleIds: string[] | null) => mutate(() => window.focusMode.saveProfile(profile, ruleIds)), [mutate]);
  const deleteProfile = useCallback((id: string) => mutate(() => window.focusMode.deleteProfile(id)), [mutate]);
  const saveRule = useCallback((rule: RuleDto) => mutate(() => window.focusMode.saveRule(rule)), [mutate]);
  const deleteRule = useCallback((id: string) => mutate(() => window.focusMode.deleteRule(id)), [mutate]);

  const dismissSummary = useCallback(() => setSummary(null), []);
  const clearError = useCallback(() => setError(null), []);
  const consumeIntent = useCallback(() => setIntent(null), []);
  const requestIntent = useCallback((kind: IntentDto) => setIntent({ kind, nonce: Date.now() }), []);

  return useMemo(
    () => ({
      ready,
      profiles,
      rules,
      preferences,
      activeSession,
      summary,
      dismissSummary,
      showSummaryFor,
      busy,
      error,
      clearError,
      blockingResidue,
      clearBlockingResidue,
      intent,
      consumeIntent,
      requestIntent,
      refresh,
      start,
      pause,
      resume,
      requestEnd,
      confirmEnd,
      restoreBlocking,
      savePreferences,
      blockingOptions,
      loadBlockingOptions,
      addBlock,
      setProfileBlock,
      saveProfile,
      deleteProfile,
      saveRule,
      deleteRule,
      getSessionsByRange,
      getSessionsForDay,
      getHistory,
      getSessionSummary,
    }),
    [
      ready, profiles, rules, preferences, activeSession, summary, dismissSummary, showSummaryFor, busy, error,
      clearError, blockingResidue, clearBlockingResidue, intent, consumeIntent, requestIntent, refresh, start, pause, resume,
      requestEnd, confirmEnd, restoreBlocking, savePreferences, blockingOptions, loadBlockingOptions, addBlock, setProfileBlock, saveProfile, deleteProfile, saveRule, deleteRule,
      getSessionsByRange, getSessionsForDay, getHistory, getSessionSummary,
    ],
  );
}
