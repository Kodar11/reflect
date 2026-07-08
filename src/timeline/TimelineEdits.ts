import type { TimelineEdit, TimelineOperation, TimelinePayload } from './TimelineModels.js';
import type {
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
} from './TimelineModels.js';

/**
 * Encode/decode helpers between typed `TimelinePayload` objects and the JSON
 * string stored in `timeline_edits.payload`. Centralizing the codec here keeps
 * the repository free of operation-specific guesses and the engine free of
 * JSON parse/typing boilerplate.
 */

export function encodePayload(payload: TimelinePayload): string {
  return JSON.stringify(payload);
}

/** Decode the JSON string column into the strongly-typed payload for the op. */
export function decodePayload(operation: TimelineOperation, raw: string): TimelinePayload {
  const obj = JSON.parse(raw);
  switch (operation) {
    case 'rename':        return decodeRename(obj);
    case 'split':         return decodeSplit(obj);
    case 'merge':         return decodeMerge(obj);
    case 'delete':        return decodeDelete(obj);
    case 'create_offline': return decodeCreateOffline(obj);
  }
}

function decodeRename(o: any): RenamePayload {
  if (typeof o?.anchorEventId !== 'number' || typeof o?.newTitle !== 'string') {
    throw malformed('rename');
  }
  return { anchorEventId: o.anchorEventId, newTitle: o.newTitle, oldTitle: o?.oldTitle };
}
function decodeSplit(o: any): SplitPayload {
  if (typeof o?.afterEventId !== 'number') throw malformed('split');
  return { afterEventId: o.afterEventId };
}
function decodeMerge(o: any): MergePayload {
  if (typeof o?.boundaryFromEventId !== 'number' || typeof o?.boundaryToEventId !== 'number') {
    throw malformed('merge');
  }
  return { boundaryFromEventId: o.boundaryFromEventId, boundaryToEventId: o.boundaryToEventId };
}
function decodeDelete(o: any): DeletePayload {
  if (!Array.isArray(o?.eventIds) || !o.eventIds.every((n: unknown) => typeof n === 'number')) {
    throw malformed('delete');
  }
  return { eventIds: o.eventIds };
}
function decodeCreateOffline(o: any): CreateOfflinePayload {
  if (typeof o?.startedAt !== 'string' || typeof o?.endedAt !== 'string' || typeof o?.title !== 'string') {
    throw malformed('create_offline');
  }
  return { startedAt: o.startedAt, endedAt: o.endedAt, title: o.title, app: o?.app, browser: o?.browser };
}

function malformed(op: string): Error {
  return new Error(`Malformed timeline edit payload for '${op}'`);
}

/** Helper for tests: fabricate an edit as if from the DB without a real DB. */
export function makeEdit(
  id: number,
  operation: TimelineOperation,
  payload: TimelinePayload,
  undoneAt: string | null = null,
): TimelineEdit {
  return { id, operation, payload, createdAt: null, undoneAt };
}