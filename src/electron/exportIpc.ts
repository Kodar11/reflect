import { ExportService } from '../service/ExportService.js';

export function registerExportIpc(
  service: ExportService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
) {
  ipcMainHandle('export:timeline', (p?: { format: 'csv' | 'json' }) => {
    if (!p || !p.format) throw new Error('Format required');
    return service.exportTimeline(p.format);
  });
  ipcMainHandle('export:activity', (p?: { format: 'csv' | 'json' }) => {
    if (!p || !p.format) throw new Error('Format required');
    return service.exportActivity(p.format);
  });
  ipcMainHandle('export:sessions', (p?: { format: 'csv' | 'json' }) => {
    if (!p || !p.format) throw new Error('Format required');
    return service.exportSessions(p.format);
  });
}
