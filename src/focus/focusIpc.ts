import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type {
  ActiveFocusSessionDto,
  ConfirmEndRequest,
  EndFocusChallenge,
  FocusPreferences,
  FocusProfile,
  FocusProfileRule,
  FocusRule,
  FocusSession,
  FocusSummaryDto,
  StartFocusRequest,
} from './FocusModels.js';
import type { IFocusService } from './FocusService.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import {
  blockLabel,
  canonicalBlockTarget,
  compileBlockingConfig,
  countBlockRules,
  listCategoryOptions,
  type CategoryOption,
} from './BlockingConfig.js';

export type { ActiveFocusSessionDto, FocusSummaryDto } from './FocusModels.js';

/**
 * Focus IPC surface.
 *
 * The renderer can ask for transitions; it cannot dictate state. There is no
 * channel that sets a session's state, completes it or stops it directly:
 * ending goes through `focus:requestEnd` → `focus:confirmEnd`, and natural
 * completion is produced by the service alone.
 */

export interface FocusRuleDto {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: boolean;
  /** Human name: "Discord", "Social media", "youtube.com". */
  label: string;
  createdAt: string;
  updatedAt: string;
}

/** Things the blocking editor can offer without the user typing anything. */
export interface BlockingContext {
  /** Apps with an open window right now, most recently used first. */
  openApps: Array<{ name: string; process: string }>;
  /** Sites visited recently, most recent first. */
  recentSites: string[];
}

export interface BlockingOptionsDto extends BlockingContext {
  categories: CategoryOption[];
}

export interface AddBlockResultDto {
  ruleId: string;
  /** False when an equivalent block already existed and was reused. */
  created: boolean;
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
  /** Every rule attached to the profile, including currently disabled ones. */
  ruleIds: string[];
  /** What a session started from this profile would actually enforce. */
  blocking: { enabled: boolean; ruleCount: number; siteCount: number; appCount: number };
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

export type FocusSessionDto = Omit<FocusSession, 'blockingConfig'>;

export interface ActiveFocusSessionIpcDto extends Omit<ActiveFocusSessionDto, 'session' | 'profile'> {
  session: FocusSessionDto;
  profile: FocusProfileDto;
}

export interface FocusSummaryIpcDto extends Omit<FocusSummaryDto, 'session' | 'profile'> {
  session: FocusSessionDto;
  profile: FocusProfileDto;
}

/** Asks the renderer to open the Focus page, optionally at a specific flow. */
export type FocusIntent = 'open' | 'pause' | 'end';

const RULE_TYPES = ['app', 'website', 'category'];
const RULE_ACTIONS = ['block', 'allow'];

export function registerFocusIpc(
  service: IFocusService,
  repo: IFocusRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
  getSummary: (session: FocusSession) => Promise<FocusSummaryDto> | FocusSummaryDto,
  getBlockingContext: () => Promise<BlockingContext> | BlockingContext = () => ({ openApps: [], recentSites: [] }),
) {
  /** Attach or detach one rule; blocking is on exactly when a block rule is attached. */
  const setProfileRule = (profileId: string, ruleId: string, on: boolean) => {
    const profile = repo.getProfileById(profileId);
    if (!profile) throw new Error('That preset no longer exists.');
    const ids = new Set(repo.getProfileRuleIds(profileId));
    if (on) ids.add(ruleId);
    else ids.delete(ruleId);
    const ruleIds = [...ids].filter((id) => repo.getRuleById(id));
    const blocks = ruleIds.some((id) => repo.getRuleById(id)?.action === 'block');
    repo.updateProfile({ ...profile, blocksDistractions: blocks, updatedAt: new Date().toISOString() }, ruleIds);
  };

  ipcMainHandle('focus:getBlockingOptions', async (): Promise<BlockingOptionsDto> => {
    let context: BlockingContext = { openApps: [], recentSites: [] };
    try {
      context = await getBlockingContext();
    } catch (err) {
      console.error('[focus] could not read blocking suggestions:', err);
    }
    const seenApps = new Set<string>();
    const openApps = context.openApps
      .map((a) => ({ process: canonicalBlockTarget('app', a.process), name: a.name }))
      .filter((a): a is { process: string; name: string } => {
        if (!a.process || seenApps.has(a.process)) return false;
        seenApps.add(a.process);
        return true;
      })
      .map((a) => ({ process: a.process, name: a.name?.trim() || blockLabel('app', a.process) }));
    const recentSites = [...new Set(context.recentSites.map((s) => canonicalBlockTarget('website', s)).filter((s): s is string => !!s))];
    return { categories: listCategoryOptions(), openApps: openApps.slice(0, 12), recentSites: recentSites.slice(0, 8) };
  });

  /**
   * "Block this" in one step: normalize what the user gave, reuse the block
   * if it already exists, and switch it on for the preset being edited.
   */
  ipcMainHandle('focus:addBlock', (p?: { profileId?: string | null; type: FocusRule['type']; target: string; action?: FocusRule['action'] }): AddBlockResultDto => {
    if (!p || !RULE_TYPES.includes(p.type)) throw new Error('Choose what to block.');
    const action = p.action === 'allow' ? 'allow' : 'block';
    const target = canonicalBlockTarget(p.type, p.target);
    if (!target) {
      throw new Error(
        p.type === 'website' ? 'Enter a website like youtube.com.'
        : p.type === 'app' ? 'That app cannot be blocked.'
        : 'Unknown category.',
      );
    }
    if (p.profileId && !repo.getProfileById(p.profileId)) throw new Error('That preset no longer exists.');
    const now = new Date().toISOString();
    let rule = repo.getRules().find((r) => r.type === p.type && r.action === action && canonicalBlockTarget(r.type, r.target) === target);
    const created = !rule;
    if (!rule) {
      rule = { id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: p.type, target, action, enabled: true, createdAt: now, updatedAt: now };
      repo.insertRule(rule);
    } else if (!rule.enabled) {
      repo.updateRule({ ...rule, enabled: true, updatedAt: now });
    }
    if (p.profileId) setProfileRule(p.profileId, rule.id, true);
    return { ruleId: rule.id, created };
  });

  ipcMainHandle('focus:setProfileBlock', (p?: { profileId: string; ruleId: string; on: boolean }) => {
    if (!p || !p.profileId || !p.ruleId) throw new Error('Missing preset or block.');
    if (!repo.getRuleById(p.ruleId)) throw new Error('That block no longer exists.');
    setProfileRule(p.profileId, p.ruleId, Boolean(p.on));
    return { ok: true };
  });

  const push = (channel: string, payload: unknown) => {
    for (const wc of webContentsForPush()) ipcWebContentsSend(channel, wc, payload);
  };

  ipcMainHandle('focus:listProfiles', () =>
    service.listProfiles().map((p) => toProfileDto(p, repo.getProfileRuleIds(p.id))),
  );
  ipcMainHandle('focus:saveProfile', (p?: { profile: FocusProfileDto; ruleIds: string[] | null }) => {
    if (!p || !p.profile || typeof p.profile.id !== 'string' || !p.profile.id) throw new Error('Missing profile');
    const name = typeof p.profile.name === 'string' ? p.profile.name.trim().slice(0, 60) : '';
    if (!name) throw new Error('A profile needs a name.');
    const mode = p.profile.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
    const duration = Number(p.profile.defaultDurationMinutes);
    const existing = repo.getProfileById(p.profile.id);
    const now = new Date().toISOString();
    // `ruleIds: null` keeps the profile's rules as they are (e.g. when only
    // its default duration changed).
    const ruleIds = Array.isArray(p.ruleIds)
      ? p.ruleIds.filter((id) => typeof id === 'string' && repo.getRuleById(id))
      : existing
        ? repo.getProfileRuleIds(existing.id)
        : [];
    const profile: FocusProfile = {
      id: p.profile.id,
      name,
      description: typeof p.profile.description === 'string' ? p.profile.description.trim().slice(0, 200) || null : null,
      isDefault: Boolean(p.profile.isDefault),
      mode,
      defaultDurationMinutes:
        mode === 'countdown' ? (Number.isFinite(duration) ? Math.min(720, Math.max(1, Math.round(duration))) : 25) : null,
      blocksDistractions: Boolean(p.profile.blocksDistractions),
      soundCue: null,
      rules: [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // A running session keeps the blocking it started with (it holds its own
    // snapshot), so saving here only affects future sessions.
    if (existing) repo.updateProfile(profile, ruleIds);
    else repo.insertProfile(profile, ruleIds);
    return { ok: true };
  });
  ipcMainHandle('focus:deleteProfile', (p?: { id: string }) => {
    if (!p || !p.id) throw new Error('Missing profile id');
    if (service.isProfileInUse(p.id)) throw new Error('This profile is in use by the current Focus session.');
    if (service.listProfiles().length <= 1) throw new Error('Keep at least one Focus profile.');
    repo.deleteProfile(p.id);
    return { ok: true };
  });

  ipcMainHandle('focus:listRules', () => repo.getRules().map(toRuleDto));
  ipcMainHandle('focus:saveRule', (p?: FocusRuleDto) => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error('Missing rule');
    if (!RULE_TYPES.includes(p.type) || !RULE_ACTIONS.includes(p.action)) throw new Error('Invalid rule');
    const target = typeof p.target === 'string' ? p.target.trim().slice(0, 200) : '';
    if (!target) throw new Error('A rule needs a target.');
    const now = new Date().toISOString();
    const existing = repo.getRuleById(p.id);
    const rule: FocusRule = {
      id: p.id,
      type: p.type,
      target,
      action: p.action,
      enabled: Boolean(p.enabled),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) repo.updateRule(rule);
    else repo.insertRule(rule);
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
    return toSummaryDto(await getSummary(session));
  });

  ipcMainHandle('focus:start', async (p?: StartFocusRequest) => {
    if (!p || typeof p !== 'object') throw new Error('Missing start request');
    // Only the fields a start is allowed to set are passed on.
    const dto = await service.start({
      profileId: p.profileId,
      task: p.task,
      notes: p.notes ?? null,
      mode: p.mode,
      plannedDurationMinutes: p.plannedDurationMinutes,
      withoutBlocking: p.withoutBlocking === true,
    });
    return toActiveDto(dto);
  });
  ipcMainHandle('focus:pause', async (p?: { reason?: string | null }) => {
    const dto = await service.pause(typeof p?.reason === 'string' ? p.reason : null);
    return dto ? toActiveDto(dto) : null;
  });
  ipcMainHandle('focus:resume', async () => {
    const dto = await service.resume();
    return dto ? toActiveDto(dto) : null;
  });
  ipcMainHandle('focus:requestEnd', (): Promise<EndFocusChallenge | null> => service.requestEnd());
  ipcMainHandle('focus:confirmEnd', async (p?: ConfirmEndRequest) => {
    if (!p || typeof p !== 'object') throw new Error('Missing confirmation');
    const session = await service.confirmEnd({ token: p.token, phrase: p.phrase ?? null, reason: p.reason ?? null });
    return toSessionDto(session);
  });
  ipcMainHandle('focus:restoreBlocking', async () => {
    const dto = await service.restoreBlocking();
    return dto ? toActiveDto(dto) : null;
  });

  ipcMainHandle('focus:getPreferences', (): FocusPreferences => service.getPreferences());
  ipcMainHandle('focus:savePreferences', (p?: unknown): FocusPreferences => service.setPreferences(p));
  ipcMainHandle('focus:getBlockingResidue', (): boolean => service.hasBlockingResidue());
  ipcMainHandle('focus:clearBlockingResidue', async (): Promise<boolean> => {
    await service.clearBlockingResidue();
    return service.hasBlockingResidue();
  });

  service.on('activeSessionChanged', (dto) => {
    push('focus:activeSessionChanged', dto ? toActiveDto(dto) : null);
  });

  service.on('summary', async (session) => {
    try {
      push('focus:summary', toSummaryDto(await getSummary(session)));
    } catch (err) {
      console.error('[focus] failed to build session summary:', err);
    }
  });

  return {
    /** Bring the renderer to the Focus page (tray menu, shortcuts). */
    sendIntent(intent: FocusIntent) {
      push('focus:intent', intent);
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
    label: blockLabel(r.type, r.target),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toProfileDto(p: FocusProfile, ruleIds: string[] = p.rules.map((r) => r.id)): FocusProfileDto {
  const config = compileBlockingConfig(p);
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
    ruleIds,
    blocking: {
      enabled: config.enabled,
      ruleCount: countBlockRules(config),
      siteCount: config.domains.length,
      appCount: config.apps.length,
    },
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

export function toSessionDto(s: FocusSession): FocusSessionDto {
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
    endReason: s.endReason,
    endNote: s.endNote,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toActiveDto(dto: ActiveFocusSessionDto): ActiveFocusSessionIpcDto {
  return {
    session: toSessionDto(dto.session),
    profile: toProfileDto(dto.profile),
    liveElapsedMs: dto.liveElapsedMs,
    isRunning: dto.isRunning,
    remainingMs: dto.remainingMs,
    plannedEndsAt: dto.plannedEndsAt,
    pauseKind: dto.pauseKind,
    blocking: dto.blocking,
  };
}

function toSummaryDto(summary: FocusSummaryDto): FocusSummaryIpcDto {
  return {
    ...summary,
    session: toSessionDto(summary.session),
    profile: toProfileDto(summary.profile),
  };
}
