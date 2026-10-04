import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import type { UseFocusResult } from './useFocus';
import { FocusActive } from './FocusActive';
import { FocusStart } from './FocusStart';
import { FocusPreferences } from './FocusPreferences';

export type FocusPageTab = 'focus' | 'preferences';

interface FocusPageProps {
  focus: UseFocusResult;
}

/**
 * One page that changes state: start → active. While a session runs the
 * page shows only that session — the Preferences tab (profiles, rules,
 * notifications) is not reachable until Focus has ended.
 */
export function FocusPage({ focus }: FocusPageProps) {
  const [tab, setTab] = useState<FocusPageTab>('focus');
  const active = focus.activeSession;

  // A tray action or a new session always brings the Focus view forward.
  useEffect(() => {
    if (active || focus.intent) setTab('focus');
  }, [active, focus.intent]);

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
        {focus.ready && !active && (
          <div className="focus-tabs" role="tablist">
            {(['focus', 'preferences'] as FocusPageTab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="capitalize">
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!focus.ready ? (
          // Nothing half-populated: wait for profiles and the active session.
          <div className="focus-stage" aria-busy="true" />
        ) : active ? (
          <FocusActive focus={focus} session={active} />
        ) : tab === 'preferences' ? (
          <FocusPreferences focus={focus} onUsePreset={() => setTab('focus')} />
        ) : (
          <FocusStart focus={focus} />
        )}
      </div>
    </div>
  );
}
