import type { Session } from '../session/Session.js';
import type { TimelineEdit, VerifiedSession } from './TimelineModels.js';
import { toVerified } from './TimelineModels.js';
import {
  applyRename,
  applySplit,
  applyMerge,
  applyDelete,
  applyCreateOffline,
  dropHidden,
  type OpCtx,
} from './TimelineOperations.js';

/**
 * `TimelineEngine` is the pure replay head of Stage 3.
 *
 *   Generated Sessions + Active Edit Log  ──►  Verified Timeline
 *
 * Bytes-for-bytes deterministic: same generated sessions + same active log
 * always produce the same verified timeline. Scratch state lives only inside
 * a single `applyEdits` call; the class holds none. No React / SQLite /
 * Electron / Date.now / Math.random.
 *
 * Replay semantics: edits are applied in chronological (id) order. An edit
 * whose `undoneAt` is non-null is SKIPPED (it represents an undo: still in
 * the log for audit/replay-fidelity, but inert). A stale edit (it references
 * event ids no longer arranged as expected by an algorithm improvement) is a
 * no-op — the engine never throws — satisfying the spec's "if Stage 2
 * improves later, the edit log should still work."
 *
 * Pure functions (operations) live in `TimelineOperations`; this module is the
 * ordered orchestrator so tests can target the full log → timeline path.
 */
export class TimelineEngine {
  /** Apply the active edits to generated sessions and return the verified
   * timeline, in chronological order, with hidden (deleted) sessions removed. */
  applyEdits(generated: Session[], edits: TimelineEdit[]): VerifiedSession[] {
    if (edits.length === 0) {
      return generated.map((s) => toVerified(s));
    }

    // Initial working list = generated sessions promoted to verified.
    let working: VerifiedSession[] = generated.map((s) => toVerified(s));

    // Active edits in chronological/insertion order (id asc).
    const active = edits
      .filter((e) => e.undoneAt === null)
      .sort((a, b) => a.id - b.id);

    for (const edit of active) {
      const ctx: OpCtx = { editId: edit.id, events: working };
      switch (edit.operation) {
        case 'rename':         working = applyRename(ctx, edit.payload as any); break;
        case 'split':          working = applySplit(ctx, edit.payload as any); break;
        case 'merge':          working = applyMerge(ctx, edit.payload as any); break;
        case 'delete':         working = applyDelete(ctx, edit.payload as any); break;
        case 'create_offline': working = applyCreateOffline(ctx, edit.payload as any); break;
      }
    }

    return dropHidden(working);
  }
}