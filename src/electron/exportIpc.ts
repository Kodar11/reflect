import path from 'node:path';
import type { ExportService } from '../service/ExportService.js';
import { ExportRangeError } from '../service/ExportService.js';
import { ZipTooLargeError } from '../export/ZipWriter.js';
import { isSingleFileExport, parseExportRequest, suggestedExportFileName, type ExportPreview, type ExportRequest, type ExportRunResult } from '../export/ExportModels.js';

/**
 * Renderer bridge for the data export.
 *
 * The renderer only ever sends WHAT to export (validated strictly — unknown
 * fields, and so any path, are refused). WHERE is chosen by the user in the
 * native save dialog, shown here in the main process; the renderer never
 * names a path. The folder is revealed only for the file this process just
 * wrote.
 */

export interface ExportIpcDeps {
  service: Pick<ExportService, 'preview' | 'write'>;
  /** Native save dialog. Resolves to the chosen path, or null when cancelled. */
  chooseDestination: (options: { defaultName: string; extension: 'zip' | 'csv' | 'json' }) => Promise<string | null>;
  /** Open the folder and select the file (shell.showItemInFolder). */
  revealFile: (filePath: string) => void;
  now?: () => Date;
  logger?: { info(message: string): void; warn(message: string): void };
}

export function registerExportIpc(deps: ExportIpcDeps, ipcMainHandle: (key: string, handler: (payload?: any) => any) => void) {
  const handlers = createExportHandlers(deps);
  ipcMainHandle('export:preview', (p?: { request?: unknown }) => handlers.preview(p?.request));
  ipcMainHandle('export:run', (p?: { request?: unknown }) => handlers.run(p?.request));
  ipcMainHandle('export:reveal', () => handlers.reveal());
}

/** The handlers, independent of Electron, so they can be tested directly. */
export function createExportHandlers(deps: ExportIpcDeps) {
  const now = deps.now ?? (() => new Date());
  let running = false;
  let lastSaved: string | null = null;

  return {
    preview(raw: unknown): ExportPreview {
      const parsed = parseExportRequest(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return deps.service.preview(parsed.request);
    },

    async run(raw: unknown): Promise<ExportRunResult> {
      const parsed = parseExportRequest(raw);
      if (!parsed.ok) return { status: 'error', message: parsed.error };
      if (running) return { status: 'error', message: 'An export is already in progress.' };
      running = true;
      try {
        const request = parsed.request;
        const extension = exportExtension(request);
        const chosen = await deps.chooseDestination({ defaultName: suggestedExportFileName(request, now()), extension });
        if (!chosen) return { status: 'cancelled' };
        const destination = normalizeDestination(chosen, extension);
        if (!destination) return { status: 'error', message: 'That location cannot be used. Choose another folder.' };

        const result = await deps.service.write(request, destination);
        lastSaved = destination;
        deps.logger?.info(`[EXPORT] Wrote ${result.files.length} file(s), ${result.bytes} bytes (${request.categories.join(', ')}).`);
        return { status: 'saved', fileName: path.basename(destination), folder: path.dirname(destination), files: result.files, bytes: result.bytes };
      } catch (err) {
        deps.logger?.warn(`[EXPORT] Export failed: ${errorCode(err)}`);
        return { status: 'error', message: describeExportError(err) };
      } finally {
        running = false;
      }
    },

    reveal(): { ok: boolean } {
      if (!lastSaved) return { ok: false };
      deps.revealFile(lastSaved);
      return { ok: true };
    },
  };
}

function exportExtension(request: ExportRequest): 'zip' | 'csv' | 'json' {
  if (!isSingleFileExport(request)) return 'zip';
  return suggestedExportFileName(request, new Date()).endsWith('.csv') ? 'csv' : 'json';
}

/** An absolute path with the expected extension (added when the user typed a name without it). */
export function normalizeDestination(chosen: string, extension: string): string | null {
  if (typeof chosen !== 'string' || chosen.length === 0 || chosen.includes('\0') || !path.isAbsolute(chosen)) return null;
  const resolved = path.resolve(chosen);
  return path.extname(resolved).toLowerCase() === `.${extension}` ? resolved : `${resolved}.${extension}`;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') return (err as { code: string }).code;
  return err instanceof Error ? err.name : 'unknown';
}

/** Plain-language failure, with no path or system message in it. */
export function describeExportError(err: unknown): string {
  if (err instanceof ExportRangeError) return err.message;
  if (err instanceof ZipTooLargeError) return 'This export is too large for one ZIP file. Choose a shorter date range or fewer kinds of data.';
  switch (errorCode(err)) {
    case 'EACCES':
    case 'EPERM':
      return 'Reflect is not allowed to save in that folder, or the file is open in another program. Choose another location.';
    case 'EBUSY':
      return 'The file is open in another program. Close it or choose another name.';
    case 'ENOSPC':
      return 'There is not enough free disk space for this export.';
    case 'ENOENT':
      return 'That folder no longer exists. Choose another location.';
    case 'EROFS':
      return 'That location is read-only. Choose another folder.';
    default:
      return 'The export could not be completed. Nothing was saved.';
  }
}
