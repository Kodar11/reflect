import type { IntelligenceService } from './IntelligenceService.js';

/**
 * Renderer bridge for the intelligence layer — a manual prototype/testing
 * path, not a product surface. Follows the existing registrar pattern: thin
 * frame-validated handlers returning plain JSON.
 *
 * Only results and run metadata cross this boundary. The Gemini API key lives
 * in the main process and is never part of any payload.
 */
export function registerIntelligenceIpc(
  service: IntelligenceService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  onAnalyzed: () => void = () => {},
) {
  const notifyOnSuccess = <T extends { status: string }>(result: T): T => {
    if (result.status === 'succeeded') onAnalyzed();
    return result;
  };

  /** "Analyze the last 60 minutes." */
  ipcMainHandle('intelligence:analyzeRecent', async (p?: { minutes?: number; force?: boolean }) =>
    notifyOnSuccess(await service.analyzeRecent(p?.minutes ?? 60, { force: p?.force === true })),
  );

  ipcMainHandle('intelligence:analyzeWindow', async (p?: { from: string; to: string; force?: boolean }) => {
    if (!p || !p.from || !p.to) throw new Error('intelligence:analyzeWindow requires from+to');
    return notifyOnSuccess(await service.analyzeWindow(p.from, p.to, { force: p.force === true }));
  });

  ipcMainHandle('intelligence:processBacklog', async () => {
    const result = await service.processBacklog();
    if (result.results.some((r) => r.status === 'succeeded')) onAnalyzed();
    return result;
  });

  ipcMainHandle('intelligence:status', () => service.getStatus());
}
