import { dialog } from 'electron';
import * as fs from 'fs';
import type { TimelineService } from '../timeline/TimelineService.js';
import type { IEventRepository } from '../database/EventRepository.js';
import type { SessionService } from '../session/SessionService.js';

export class ExportService {
  constructor(
    private readonly timelineService: TimelineService,
    private readonly eventRepo: IEventRepository,
    private readonly sessionService: SessionService,
  ) {}

  async exportTimeline(format: 'csv' | 'json'): Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }> {
    try {
      const list = this.timelineService.getAll();
      const todayStr = new Date().toISOString().split('T')[0];
      const defaultName = `timeline-${todayStr}.${format}`;

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export Timeline',
        defaultPath: defaultName,
        filters: [
          { name: format === 'csv' ? 'CSV Files' : 'JSON Files', extensions: [format] }
        ]
      });

      if (canceled || !filePath) return { success: false, cancelled: true };

      let content = '';
      if (format === 'json') {
        const jsonList = list.map((s) => ({
          id: s.id,
          title: s.customTitle ?? s.primaryTitle ?? '',
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt.toISOString(),
          duration: s.duration,
          activeDuration: s.activeDuration,
          eventCount: s.eventCount,
          primaryApp: s.primaryApp ?? null,
          primaryBrowser: s.primaryBrowser ?? null,
          primaryTitle: s.primaryTitle ?? null,
          primaryUrl: s.primaryUrl ?? null,
          appsUsed: s.appsUsed,
          browserTabs: s.browserTabs,
          source: s.source,
          note: s.note,
        }));
        content = JSON.stringify(jsonList, null, 2);
      } else {
        const headers = ['Title', 'Start', 'End', 'Duration', 'Active Duration', 'Primary App', 'Primary Browser', 'Websites', 'Event Count', 'Source', 'Notes'];
        const rows = list.map((s) => [
          s.customTitle ?? s.primaryTitle ?? '',
          s.startedAt.toISOString(),
          s.endedAt.toISOString(),
          s.duration,
          s.activeDuration,
          s.primaryApp ?? '',
          s.primaryBrowser ?? '',
          s.browserTabs.join('; '),
          s.eventCount,
          s.source,
          s.note ?? '',
        ]);
        content = [headers, ...rows].map((row) => row.map(escapeCSV).join(',')).join('\n');
      }

      await fs.promises.writeFile(filePath, content, 'utf8');
      return { success: true, filePath };
    } catch (e) {
      console.error('[ExportService] exportTimeline failed', e);
      return { success: false, error: (e as Error)?.message ?? String(e) };
    }
  }

  async exportActivity(format: 'csv' | 'json'): Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }> {
    try {
      const list = this.eventRepo.getAll(10000000); // load up to 10M events
      const todayStr = new Date().toISOString().split('T')[0];
      const defaultName = `activity-${todayStr}.${format}`;

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export Activity',
        defaultPath: defaultName,
        filters: [
          { name: format === 'csv' ? 'CSV Files' : 'JSON Files', extensions: [format] }
        ]
      });

      if (canceled || !filePath) return { success: false, cancelled: true };

      let content = '';
      if (format === 'json') {
        const jsonList = list.map((e) => ({
          id: e.id,
          watcher: e.watcher,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          duration: new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime(),
          app: e.app ?? null,
          browser: e.browser ?? null,
          title: e.title ?? null,
          url: e.url ?? null,
        }));
        content = JSON.stringify(jsonList, null, 2);
      } else {
        const headers = ['Timestamp', 'Duration', 'Watcher', 'Application', 'Window Title', 'URL'];
        const rows = list.map((e) => [
          e.startedAt,
          new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime(),
          e.watcher,
          e.app ?? '',
          e.title ?? '',
          e.url ?? '',
        ]);
        content = [headers, ...rows].map((row) => row.map(escapeCSV).join(',')).join('\n');
      }

      await fs.promises.writeFile(filePath, content, 'utf8');
      return { success: true, filePath };
    } catch (e) {
      console.error('[ExportService] exportActivity failed', e);
      return { success: false, error: (e as Error)?.message ?? String(e) };
    }
  }

  async exportSessions(format: 'csv' | 'json'): Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }> {
    try {
      const list = this.sessionService.getAll(10000000);
      const todayStr = new Date().toISOString().split('T')[0];
      const defaultName = `sessions-${todayStr}.${format}`;

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export Sessions',
        defaultPath: defaultName,
        filters: [
          { name: format === 'csv' ? 'CSV Files' : 'JSON Files', extensions: [format] }
        ]
      });

      if (canceled || !filePath) return { success: false, cancelled: true };

      let content = '';
      if (format === 'json') {
        const jsonList = list.map((s) => ({
          id: s.id,
          title: s.primaryApp ?? s.primaryBrowser ?? 'Untitled',
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt.toISOString(),
          duration: s.duration,
          applications: s.appsUsed,
          websites: s.browserTabs,
          eventCount: s.eventCount,
          notes: '',
          offline: false,
        }));
        content = JSON.stringify(jsonList, null, 2);
      } else {
        const headers = ['Title', 'Start', 'End', 'Duration', 'Applications', 'Websites', 'Event Count', 'Notes', 'Offline'];
        const rows = list.map((s) => [
          s.primaryApp ?? s.primaryBrowser ?? 'Untitled',
          s.startedAt.toISOString(),
          s.endedAt.toISOString(),
          s.duration,
          s.appsUsed.join('; '),
          s.browserTabs.join('; '),
          s.eventCount,
          '',
          'false',
        ]);
        content = [headers, ...rows].map((row) => row.map(escapeCSV).join(',')).join('\n');
      }

      await fs.promises.writeFile(filePath, content, 'utf8');
      return { success: true, filePath };
    } catch (e) {
      console.error('[ExportService] exportSessions failed', e);
      return { success: false, error: (e as Error)?.message ?? String(e) };
    }
  }
}

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
