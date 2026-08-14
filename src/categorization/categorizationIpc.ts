import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type { CategorizationService } from './CategorizationService.js';
import type { EventClassificationSource } from './Classification.js';

/**
 * Renderer bridge for the categorization engine. Follows the existing
 * registrar pattern: thin IPC handlers, DTOs only, frame-validated.
 */
export function registerCategorizationIpc(
  service: CategorizationService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  ipcMainHandle('categorization:getDimensions', () => service.getDimensions());
  ipcMainHandle('categorization:getContexts', () => service.getContexts());
  ipcMainHandle('categorization:listOverrides', () => service.listOverrides());
  ipcMainHandle('categorization:deleteOverride', (p: { id: string }) => {
    service.deleteOverride(p.id);
    return { ok: true };
  });
  ipcMainHandle('categorization:saveOverride', (p: {
    eventIds: number[];
    contextId: string | null;
    areaId: string | null;
    intentId: string | null;
    qualityId: string | null;
    remember: boolean;
    sessionHint?: {
      primaryApp?: string;
      primaryUrl?: string;
      primaryTitle?: string;
    };
  }) => {
    const result = service.saveOverride(
      p.eventIds,
      {
        contextId: p.contextId,
        areaId: p.areaId,
        intentId: p.intentId,
        qualityId: p.qualityId,
      },
      p.remember,
      p.sessionHint,
    );
    return { ok: true, ...result };
  });

  ipcMainHandle('categorization:getEventClassification', (p: { eventId: number }) =>
    service.getEventClassification(p.eventId),
  );
  ipcMainHandle('categorization:getEventClassifications', (p: { eventIds: number[] }) =>
    service.getEventClassifications(p.eventIds),
  );
  ipcMainHandle('categorization:getResolvedEventClassifications', (p: { eventIds: number[] }) =>
    service.getResolvedEventClassifications(p.eventIds),
  );
  ipcMainHandle('categorization:saveEventClassification', (p: {
    eventId: number;
    contextId: string | null;
    areaId: string | null;
    intentId: string | null;
    qualityId: string | null;
    source?: EventClassificationSource;
    ruleId?: string | null;
  }) => {
    service.saveEventClassification({
      eventId: p.eventId,
      contextId: p.contextId,
      areaId: p.areaId,
      intentId: p.intentId,
      qualityId: p.qualityId,
      source: p.source ?? 'user_override',
      ruleId: p.ruleId ?? null,
    });
    return { ok: true };
  });
  ipcMainHandle('categorization:deleteEventClassification', (p: { eventId: number }) => {
    service.deleteEventClassification(p.eventId);
    return { ok: true };
  });
  ipcMainHandle('categorization:rememberEventAsRule', (p: {
    eventId: number;
    contextId: string | null;
    areaId: string | null;
    intentId: string | null;
    qualityId: string | null;
    app?: string | null;
    title?: string | null;
    url?: string | null;
  }) => {
    const result = service.rememberEventAsRule(p.eventId, {
      contextId: p.contextId,
      areaId: p.areaId,
      intentId: p.intentId,
      qualityId: p.qualityId,
    }, {
      app: p.app,
      title: p.title,
      url: p.url,
    });
    return { ok: true, ...result };
  });

  return {
    notifyCategorizationChanged() {
      for (const wc of webContentsForPush()) {
        ipcWebContentsSend('categorization:changed', wc, null);
      }
    },
  };
}