import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type FocusMode = 'stopwatch' | 'countdown';

export interface FocusProfileDto {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  mode: FocusMode;
  defaultDurationMinutes: number | null;
  blocksDistractions: boolean;
  soundCue: string | null;
  createdAt: string;
  updatedAt: string;
  rules: FocusProfileRuleDto[];
}

export interface FocusProfileRuleDto {
  id: string;
  profileId: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  createdAt: string;
  updatedAt: string;
}

export interface FocusRuleDto {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FocusSessionDto {
  id: string;
  profileId: string;
  task: string;
  notes: string | null;
  mode: FocusMode;
  plannedDurationMinutes: number | null;
  state: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  totalPauseMs: number;
  elapsedMs: number;
  blockingLeaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveFocusSessionDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  liveElapsedMs: number;
  isRunning: boolean;
  remainingMs: number | null;
}

export interface FocusSummaryDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  trackedSessionIds: string[];
  interruptionCount: number;
  blockedAttemptCount: number;
  productiveMs: number;
}

export interface StartFocusRequest {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: FocusMode;
  plannedDurationMinutes?: number | null;
}

export interface UseFocusResult {
  profiles: FocusProfileDto[];
  rules: FocusRuleDto[];
  activeSession: ActiveFocusSessionDto | null;
  summary: FocusSummaryDto | null;
  dismissSummary: () => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (request: StartFocusRequest) => Promise<void>;
  pause: (reason?: string | null) => Promise<void>;
  resume: () => Promise<void>;
  stop: (state: 'completed' | 'cancelled') => Promise<void>;
  saveProfile: (profile: FocusProfileDto, ruleIds: string[]) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  saveRule: (rule: FocusRuleDto) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  getSessionsByRange: (from: string, to: string) => Promise<FocusSessionDto[]>;
  getSessionsForDay: (isoDate: string) => Promise<FocusSessionDto[]>;
  getHistory: (limit?: number) => Promise<FocusSessionDto[]>;
  getSessionSummary: (sessionId: string) => Promise<FocusSummaryDto | null>;
}

export function useFocus(): UseFocusResult {
  const [profiles, setProfiles] = useState<FocusProfileDto[]>([]);
  const [rules, setRules] = useState<FocusRuleDto[]>([]);
  const [activeSession, setActiveSession] = useState<ActiveFocusSessionDto | null>(null);
  const [summary, setSummary] = useState<FocusSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [profileList, ruleList, active] = await Promise.all([
        window.focusMode.listProfiles(),
        window.focusMode.listRules(),
        window.focusMode.getActiveSession(),
      ]);
      setProfiles(profileList);
      setRules(ruleList);
      setActiveSession(active);
      if (active?.isRunning) {
        startLiveTick();
      } else {
        stopLiveTick();
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChange = (dto: ActiveFocusSessionDto | null) => {
      setActiveSession(dto);
      if (dto?.isRunning) startLiveTick();
      else stopLiveTick();
    };
    const onSummary = (dto: FocusSummaryDto) => {
      setSummary(dto);
    };
    window.focusMode.onActiveSessionChanged(onChange);
    window.focusMode.onSummary(onSummary);
    return () => {
      window.focusMode.offActiveSessionChanged(onChange);
      window.focusMode.offSummary(onSummary);
      stopLiveTick();
    };
  }, [refresh]);

  function startLiveTick() {
    if (liveRef.current) return;
    liveRef.current = window.setInterval(() => {
      setActiveSession((prev) => {
        if (!prev || !prev.isRunning) return prev;
        const elapsed = prev.liveElapsedMs + 1000;
        let remainingMs: number | null = null;
        if (prev.session.mode === 'countdown' && prev.session.plannedDurationMinutes !== null) {
          remainingMs = Math.max(0, prev.session.plannedDurationMinutes * 60_000 - elapsed);
        }
        return { ...prev, liveElapsedMs: elapsed, remainingMs };
      });
    }, 1000);
  }

  function stopLiveTick() {
    if (liveRef.current) {
      clearInterval(liveRef.current);
      liveRef.current = null;
    }
  }

  const start = useCallback(async (request: StartFocusRequest) => {
    setLoading(true);
    setError(null);
    try {
      await window.focusMode.start(request);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const pause = useCallback(async (reason?: string | null) => {
    try {
      await window.focusMode.pause(reason ?? null);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [refresh]);

  const resume = useCallback(async () => {
    try {
      await window.focusMode.resume();
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [refresh]);

  const stop = useCallback(async (state: 'completed' | 'cancelled') => {
    try {
      await window.focusMode.stop(state);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [refresh]);

  const getSessionsByRange = useCallback(async (from: string, to: string) => {
    return window.focusMode.getSessionsByRange(from, to);
  }, []);

  const getSessionsForDay = useCallback(async (isoDate: string) => {
    return window.focusMode.getSessionsForDay(isoDate);
  }, []);

  const getHistory = useCallback(async (limit?: number) => {
    return window.focusMode.getHistory(limit);
  }, []);

  const getSessionSummary = useCallback(async (sessionId: string) => {
    return window.focusMode.getSessionSummary(sessionId);
  }, []);

  const saveProfile = useCallback(async (profile: FocusProfileDto, ruleIds: string[]) => {
    try {
      await window.focusMode.saveProfile(profile, ruleIds);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      throw e;
    }
  }, [refresh]);

  const deleteProfile = useCallback(async (id: string) => {
    try {
      await window.focusMode.deleteProfile(id);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      throw e;
    }
  }, [refresh]);

  const saveRule = useCallback(async (rule: FocusRuleDto) => {
    try {
      await window.focusMode.saveRule(rule);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      throw e;
    }
  }, [refresh]);

  const deleteRule = useCallback(async (id: string) => {
    try {
      await window.focusMode.deleteRule(id);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      throw e;
    }
  }, [refresh]);

  const dismissSummary = useCallback(() => setSummary(null), []);

  return useMemo(() => ({
    profiles,
    rules,
    activeSession,
    summary,
    dismissSummary,
    loading,
    error,
    refresh,
    start,
    pause,
    resume,
    stop,
    saveProfile,
    deleteProfile,
    saveRule,
    deleteRule,
    getSessionsByRange,
    getSessionsForDay,
    getHistory,
    getSessionSummary,
  }), [profiles, rules, activeSession, summary, dismissSummary, loading, error, refresh, start, pause, resume, stop, saveProfile, deleteProfile, saveRule, deleteRule, getSessionsByRange, getSessionsForDay, getHistory, getSessionSummary]);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes.toString().padStart(2, '0')}m`);
  parts.push(`${seconds.toString().padStart(2, '0')}s`);
  return parts.join(' ');
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
