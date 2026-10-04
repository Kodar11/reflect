import type { WebContents } from 'electron';
import {
  COACH_EXECUTIONS,
  COACH_OUTCOMES,
  type CoachExecution,
  type CoachOutcome,
  type CoachReasonCode,
  type CoachSettings,
} from './CoachModels.js';
import type { CoachService, EditInput } from './CoachService.js';

/**
 * Renderer bridge for the Coach, inside the Reflection tab. Thin,
 * frame-validated handlers returning plain JSON.
 *
 * The main process owns every action, memory and message. The renderer shows
 * them and reports what the user chose — it never decides what a state means,
 * never touches SQLite, never calls Gemini, and no prompt content or API key
 * crosses this boundary.
 */

interface ActionRequest {
  actionId?: unknown;
  reasonCode?: unknown;
  note?: unknown;
}

function actionId(p: ActionRequest | undefined, channel: string): string {
  if (!p || typeof p.actionId !== 'string' || !p.actionId) throw new Error(`${channel} requires actionId`);
  return p.actionId;
}

const reasonInput = (p: ActionRequest) => ({
  reasonCode: typeof p.reasonCode === 'string' ? (p.reasonCode as CoachReasonCode) : null,
  note: typeof p.note === 'string' ? p.note : null,
});

export interface CoachIpcOptions {
  /** The reflection time or day boundary changed. */
  onSettingsChanged?: (settings: CoachSettings) => void;
}

export function registerCoachIpc(
  service: CoachService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
  options: CoachIpcOptions = {},
) {
  const notifyChanged = () => {
    for (const wc of webContentsForPush()) wc.send('coach:changed', null);
  };

  ipcMainHandle('coach:getState', (p?: { reportId?: unknown }) =>
    service.getState(typeof p?.reportId === 'string' && p.reportId ? p.reportId : null),
  );

  ipcMainHandle('coach:decide', (p?: ActionRequest & { decision?: unknown }) => {
    const id = actionId(p, 'coach:decide');
    if (p!.decision !== 'accept' && p!.decision !== 'not_now' && p!.decision !== 'reject') {
      throw new Error('coach:decide received an unknown decision');
    }
    return service.decide(id, p!.decision, reasonInput(p!));
  });

  ipcMainHandle('coach:edit', (p?: ActionRequest & { patch?: unknown }) => {
    const id = actionId(p, 'coach:edit');
    if (!p!.patch || typeof p!.patch !== 'object') throw new Error('coach:edit requires a patch');
    const raw = p!.patch as Record<string, unknown>;
    // Only the fields an edit is allowed to set are passed on.
    const patch: EditInput = {
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string' || raw.description === null ? { description: raw.description as string | null } : {}),
      ...(typeof raw.focusMinutes === 'number' || raw.focusMinutes === null ? { focusMinutes: raw.focusMinutes as number | null } : {}),
      ...(typeof raw.focusTask === 'string' || raw.focusTask === null ? { focusTask: raw.focusTask as string | null } : {}),
      ...(typeof raw.when === 'string' ? { when: raw.when as EditInput['when'] } : {}),
      ...(typeof raw.daypart === 'string' ? { daypart: raw.daypart as EditInput['daypart'] } : {}),
    };
    return service.edit(id, patch);
  });

  ipcMainHandle('coach:reportExecution', (p?: ActionRequest & { execution?: unknown }) => {
    const id = actionId(p, 'coach:reportExecution');
    if (!(COACH_EXECUTIONS as readonly unknown[]).includes(p!.execution)) throw new Error('coach:reportExecution received an unknown answer');
    return service.reportExecution(id, p!.execution as CoachExecution, reasonInput(p!));
  });

  ipcMainHandle('coach:reportOutcome', (p?: ActionRequest & { outcome?: unknown }) => {
    const id = actionId(p, 'coach:reportOutcome');
    if (!(COACH_OUTCOMES as readonly unknown[]).includes(p!.outcome)) throw new Error('coach:reportOutcome received an unknown answer');
    return service.reportOutcome(id, p!.outcome as CoachOutcome, reasonInput(p!));
  });

  /** The Focus session now running was started for this action. */
  ipcMainHandle('coach:linkFocus', (p?: ActionRequest) => service.linkFocus(actionId(p, 'coach:linkFocus')));

  ipcMainHandle('coach:chat', (p?: { text?: unknown }) => {
    if (!p || typeof p.text !== 'string') throw new Error('coach:chat requires text');
    return service.chat(p.text);
  });

  ipcMainHandle('coach:removeMemory', (p?: { id?: unknown }) => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error('coach:removeMemory requires id');
    return { ok: service.removeMemory(p.id) };
  });

  ipcMainHandle('coach:getSettings', () => service.getSettings());

  ipcMainHandle('coach:saveSettings', (p?: unknown) => {
    const settings = service.saveSettings(p);
    options.onSettingsChanged?.(settings);
    notifyChanged();
    return settings;
  });

  return { notifyCoachChanged: notifyChanged };
}
