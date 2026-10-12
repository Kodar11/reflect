import type { UsageService } from './UsageService.js';
import { parseUsageRequest } from './UsagePeriods.js';

/**
 * Thin adapter from the renderer ("usage:*") channels to the `UsageService`.
 * The renderer names a period; every boundary, total and comparison is worked
 * out here in the main process. A malformed request is rejected, never guessed.
 */
export function registerUsageIpc(
  service: UsageService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
) {
  ipcMainHandle('usage:getReport', (p?: { request?: unknown }) => service.getReport(requestOf(p)));
  ipcMainHandle('usage:getItemDetail', (p?: { request?: unknown; kind?: unknown; key?: unknown }) => {
    if ((p?.kind !== 'app' && p?.kind !== 'website') || typeof p.key !== 'string') throw new Error('Invalid usage item');
    return service.getItemDetail(requestOf(p), p.kind, p.key);
  });
}

function requestOf(p?: { request?: unknown }) {
  const request = parseUsageRequest(p?.request);
  if (!request) throw new Error('Invalid usage period');
  return request;
}
