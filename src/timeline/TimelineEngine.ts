import type { Session } from '../session/Session.js';
import type { TimelineEdit, VerifiedSession } from './TimelineModels.js';
import { toVerified } from './TimelineModels.js';
import {
  applyRename,
  applySplit,
  applyMerge,
  applyDelete,
  applyCreateOffline,
  applyOverrideEnvelope,
  applyDuplicate,
  applyNote,
  applyMarkOffline,
  applyAssignActivity,
  dropHidden,
  type OpCtx,
} from './TimelineOperations.js';

/**
 * Deterministic façade over the timeline pipeline.
 *
 *   Generated Sessions + Active Edit Log  ──►  Verified Timeline
 *
 * Bytes-for-bytes deterministic: same generated sessions + same active log
 * always produce the same verified timeline. Scratch state lives only inside
 * a single `applyEdits` call; the class holds none. No React / SQLite /
 * Electron / Date.now / Math.random.
 */
export class TimelineEngine {
  /** Apply the active edits to generated sessions and return the verified
   * timeline, in chronological order, with hidden (deleted) sessions removed. */
  applyEdits(generated: Session[], edits: TimelineEdit[]): VerifiedSession[] {
    if (edits.length === 0) {
      return generated.map((s) => toVerified(s));
    }

    let working: VerifiedSession[] = generated.map((s) => toVerified(s));

    const active = edits
      .filter((e) => e.undoneAt === null)
      .sort((a, b) => a.id - b.id);

    for (const edit of active) {
      const ctx: OpCtx = { editId: edit.id, events: working };
      switch (edit.operation) {
        case 'rename':           working = applyRename(ctx, edit.payload as any); break;
        case 'split':            working = applySplit(ctx, edit.payload as any); break;
        case 'merge':            working = applyMerge(ctx, edit.payload as any); break;
        case 'delete':           working = applyDelete(ctx, edit.payload as any); break;
        case 'create_offline':   working = applyCreateOffline(ctx, edit.payload as any); break;
        case 'override_envelope': working = applyOverrideEnvelope(ctx, edit.payload as any); break;
        case 'duplicate':        working = applyDuplicate(ctx, edit.payload as any); break;
        case 'note':             working = applyNote(ctx, edit.payload as any); break;
        case 'mark_offline':     working = applyMarkOffline(ctx, edit.payload as any); break;
        case 'assign_activity':  working = applyAssignActivity(ctx, edit.payload as any); break;
      }
    }

    return dropHidden(working);
  }
}