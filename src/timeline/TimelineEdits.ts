import type { TimelineEdit, TimelineOperation, TimelinePayload } from './TimelineModels.js';
import type {
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
  OverrideEnvelopePayload,
  DuplicatePayload,
  NotePayload,
  MarkOfflinePayload,
  AssignActivityPayload,
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
    case 'rename':           return decodeRename(obj);
    case 'split':            return decodeSplit(obj);
    case 'merge':            return decodeMerge(obj);
    case 'delete':           return decodeDelete(obj);
    case 'create_offline':   return decodeCreateOffline(obj);
    case 'override_envelope': return decodeOverrideEnvelope(obj);
    case 'duplicate':        return decodeDuplicate(obj);
    case 'note':             return decodeNote(obj);
    case 'mark_offline':     return decodeMarkOffline(obj);
    case 'assign_activity':  return decodeAssignActivity(obj);
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
  // Backward-compatible: single merge shape used in Stage 3.
  if (typeof o?.boundaryFromEventId === 'number' && typeof o?.boundaryToEventId === 'number') {
    return { boundaryFromEventId: o.boundaryFromEventId, boundaryToEventId: o.boundaryToEventId };
  }
  // Stage 3.5 multi-merge: a list of boundaries applied sequentially.
  if (Array.isArray(o?.boundaries)) {
    const first = o.boundaries[0];
    if (
      first &&
      typeof first.boundaryFromEventId === 'number' &&
      typeof first.boundaryToEventId === 'number'
    ) {
      return { boundaries: o.boundaries as { boundaryFromEventId: number; boundaryToEventId: number }[] };
    }
  }
  throw malformed('merge');
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
function decodeOverrideEnvelope(o: any): OverrideEnvelopePayload {
  if (
    !Array.isArray(o?.eventIds) ||
    !o.eventIds.every((n: unknown) => typeof n === 'number') ||
    typeof o?.newStartedAt !== 'string' ||
    typeof o?.newEndedAt !== 'string'
  ) {
    throw malformed('override_envelope');
  }
  return { eventIds: o.eventIds, newStartedAt: o.newStartedAt, newEndedAt: o.newEndedAt };
}
function decodeDuplicate(o: any): DuplicatePayload {
  if (!Array.isArray(o?.eventIds) || !o.eventIds.every((n: unknown) => typeof n === 'number')) {
    throw malformed('duplicate');
  }
  return { eventIds: o.eventIds, offsetMinutes: o?.offsetMinutes };
}
function decodeNote(o: any): NotePayload {
  if (
    !Array.isArray(o?.eventIds) ||
    !o.eventIds.every((n: unknown) => typeof n === 'number') ||
    typeof o?.note !== 'string'
  ) {
    throw malformed('note');
  }
  return { eventIds: o.eventIds, note: o.note };
}
function decodeMarkOffline(o: any): MarkOfflinePayload {
  if (
    !Array.isArray(o?.eventIds) ||
    !o.eventIds.every((n: unknown) => typeof n === 'number') ||
    typeof o?.offline !== 'boolean'
  ) {
    throw malformed('mark_offline');
  }
  return { eventIds: o.eventIds, offline: o.offline };
}

function decodeAssignActivity(o: any): AssignActivityPayload {
  if (
    !Array.isArray(o?.eventIds) ||
    !o.eventIds.every((n: unknown) => typeof n === 'number')
  ) {
    throw malformed('assign_activity');
  }
  return { eventIds: o.eventIds, activityId: o.activityId ?? null };
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