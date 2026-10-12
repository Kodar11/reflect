import { Target } from 'lucide-react';
import type { UseFocusResult } from './useFocus';
import { FocusActive } from './FocusActive';
import { FocusStart, type FocusPrefill } from './FocusStart';

interface FocusPageProps {
  focus: UseFocusResult;
  /** A session to set up on behalf of a coach recommendation. */
  prefill?: FocusPrefill | null;
  onPrefillConsumed?: () => void;
}

/**
 * One page, two states. Setup holds everything that configures a session —
 * task, duration, preset, blocking and the quieter preferences. Once a
 * session runs the page shows only that session; setup comes back when it
 * ends. The two are never on screen together.
 */
export function FocusPage({ focus, prefill, onPrefillConsumed }: FocusPageProps) {
  const active = focus.activeSession;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="px-6 border-b border-default shrink-0 flex items-center justify-between"
        style={{ background: 'var(--bg-secondary)', height: 60 }}
      >
        <div className="flex items-center gap-3">
          <Target size={20} style={{ color: 'var(--accent)' }} />
          <h1 className="text-[20px] font-extrabold tracking-tight">Focus</h1>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!focus.ready ? (
          // Nothing half-populated: wait for profiles and the active session.
          <div className="focus-stage" aria-busy="true" />
        ) : active ? (
          <FocusActive focus={focus} session={active} />
        ) : (
          <FocusStart focus={focus} prefill={prefill} onPrefillConsumed={onPrefillConsumed} />
        )}
      </div>
    </div>
  );
}
