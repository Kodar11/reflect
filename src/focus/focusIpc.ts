import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type {
  ActiveFocusSessionDto,
  FocusProfile,
  FocusProfileRule,
  FocusRule,
  FocusSession,
  FocusSummaryDto,
  StartFocusRequest,
} from './FocusModels.js';
import type { IFocusService } from './FocusService.js';
import type { IFocusRepository } from '../database/FocusRepository.js';

export type { ActiveFocusSessionDto, FocusSummaryDto } from './FocusModels.js';

export interface FocusRuleDto {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FocusProfileDto {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  mode: 'stopwatch' | 'countdown';
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

export interface FocusSessionDto {
  id: string;
  profileId: string;
  task: string;
  notes: string | null;
  mode: 'stopwatch' | 'countdown';
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

export interface StartFocusRequestDto {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: 'stopwatch' | 'countdown';
  plannedDurationMinutes?: number | null;
}

export function registerFocusIpc(
  service: IFocusService,
  repo: IFocusRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
  getSummary: (session: FocusSession) => Promise<FocusSummaryDto> | FocusSummaryDto,
) {
  ipcMainHandle('focus:listProfiles', () => service.listProfiles().map(toProfileDto));
  ipcMainHandle('focus:saveProfile', (p?: { profile: FocusProfileDto; ruleIds: string[] }) => {
    if (!p || !p.profile) throw new Error('Missing profile');
    const now = new Date().toISOString();
    const existing = repo.getProfileById(p.profile.id);
    const profile: FocusProfile = {
      ...p.profile,
      rules: p.profile.rules.map((r) => ({
        ...r,
        profileId: p.profile.id,
        createdAt: r.createdAt || now,
        updatedAt: now,
      })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      repo.updateProfile(profile, p.ruleIds);
    } else {
      repo.insertProfile(profile, p.ruleIds);
    }
    return { ok: true };
  });
  ipcMainHandle('focus:deleteProfile', (p?: { id: string }) => {
    if (!p || !p.id) throw new Error('Missing profile id');
    repo.deleteProfile(p.id);
    return { ok: true };
  });

  ipcMainHandle('focus:listRules', () => repo.getRules().map(toRuleDto));
  ipcMainHandle('focus:saveRule', (p?: FocusRuleDto) => {
    if (!p) throw new Error('Missing rule');
    const now = new Date().toISOString();
    const existing = repo.getRuleById(p.id);
    const rule: FocusRule = {
      ...p,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      repo.updateRule(rule);
    } else {
      repo.insertRule(rule);
    }
    return { ok: true };
  });
  ipcMainHandle('focus:deleteRule', (p?: { id: string }) => {
    if (!p || !p.id) throw new Error('Missing rule id');
    repo.deleteRule(p.id);
    return { ok: true };
  });

  ipcMainHandle('focus:getActiveSession', () => {
    const dto = service.getActiveSession();
    return dto ? toActiveDto(dto) : null;
  });
  ipcMainHandle('focus:getSessionsByRange', (p?: { from: string; to: string }) => {
    if (!p || !p.from || !p.to) return [];
    return repo.getSessionsByRange(p.from, p.to).map(toSessionDto);
  });
  ipcMainHandle('focus:getSessionsForDay', (p?: { isoDate: string }) => {
    if (!p || !p.isoDate) return [];
    return repo.getSessionsForDay(p.isoDate).map(toSessionDto);
  });
  ipcMainHandle('focus:getHistory', (p?: { limit?: number }) => {
    return repo.getAllSessions(p?.limit ?? 100).map(toSessionDto);
  });
  ipcMainHandle('focus:getSessionSummary', async (p?: { sessionId: string }) => {
    if (!p || !p.sessionId) return null;
    const session = repo.getSessionById(p.sessionId);
    if (!session) return null;
    return getSummary(session);
  });
  ipcMainHandle('focus:start', async (p?: StartFocusRequestDto) => {
    if (!p) throw new Error('Missing start request');
    const dto = await service.start(p);
    return toActiveDto(dto);
  });
  ipcMainHandle('focus:pause', (p?: { reason?: string | null }) => {
    const dto = service.pause(p?.reason ?? null);
    return dto ? toActiveDto(dto) : null;
  });
  ipcMainHandle('focus:resume', () => {
    const dto = service.resume();
    return dto ? toActiveDto(dto) : null;
  });
  ipcMainHandle('focus:stop', async (p?: { state: 'completed' | 'cancelled' }) => {
    if (!p) throw new Error('Missing stop state');
    const session = service.stop(p.state);
    if (!session) return null;
    return toSessionDto(session);
  });

  service.on('activeSessionChanged', (dto) => {
    const payload = dto ? toActiveDto(dto) : null;
    for (const wc of webContentsForPush()) {
      ipcWebContentsSend('focus:activeSessionChanged', wc, payload);
    }
  });

  service.on('summary', async (session, profile) => {
    const summary = await getSummary(session);
    for (const wc of webContentsForPush()) {
      ipcWebContentsSend('focus:summary', wc, summary);
    }
  });

  return {
    notifyActiveSessionChanged(dto: ActiveFocusSessionDto | null) {
      const payload = dto ? toActiveDto(dto) : null;
      for (const wc of webContentsForPush()) {
        ipcWebContentsSend('focus:activeSessionChanged', wc, payload);
      }
    },
  };
}

function toRuleDto(r: FocusRule): FocusRuleDto {
  return {
    id: r.id,
    type: r.type,
    target: r.target,
    action: r.action,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toProfileDto(p: FocusProfile): FocusProfileDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    mode: p.mode,
    defaultDurationMinutes: p.defaultDurationMinutes,
    blocksDistractions: p.blocksDistractions,
    soundCue: p.soundCue,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    rules: p.rules.map(toProfileRuleDto),
  };
}

function toProfileRuleDto(r: FocusProfileRule): FocusProfileRuleDto {
  return {
    id: r.id,
    profileId: r.profileId,
    type: r.type,
    target: r.target,
    action: r.action,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toSessionDto(s: FocusSession): FocusSessionDto {
  return {
    id: s.id,
    profileId: s.profileId,
    task: s.task,
    notes: s.notes,
    mode: s.mode,
    plannedDurationMinutes: s.plannedDurationMinutes,
    state: s.state,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    pausedAt: s.pausedAt,
    totalPauseMs: s.totalPauseMs,
    elapsedMs: s.elapsedMs,
    blockingLeaseId: s.blockingLeaseId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toActiveDto(dto: ActiveFocusSessionDto): ActiveFocusSessionDto {
  return {
    session: toSessionDto(dto.session),
    profile: toProfileDto(dto.profile),
    liveElapsedMs: dto.liveElapsedMs,
    isRunning: dto.isRunning,
    remainingMs: dto.remainingMs,
  };
}
