import { useState } from 'react';
import { Target } from 'lucide-react';
import type { UseFocusResult } from './useFocus';
import { FocusDashboard } from './FocusDashboard';
import { FocusPreferences } from './FocusPreferences';

export type FocusPageTab = 'focus' | 'preferences';

interface FocusPageProps {
  focus: UseFocusResult;
  initialTab?: FocusPageTab;
  initialHistorySessionId?: string | null;
  onViewInTimeline?: (isoDate: string) => void;
}

export function FocusPage({
  focus,
  initialTab = 'focus',
  initialHistorySessionId,
  onViewInTimeline,
}: FocusPageProps) {
  const [tab, setTab] = useState<FocusPageTab>(initialTab);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default bg-secondary shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Target size={20} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h1 className="text-[20px] font-extrabold tracking-tight">Focus</h1>
        </div>
        <div className="flex items-center bg-default p-0.5 rounded-lg border border-default">
          {(['focus', 'preferences'] as FocusPageTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1 rounded-md text-[12px] font-bold transition-colors capitalize"
              style={{
                background: tab === t ? 'var(--bg-secondary)' : 'transparent',
                color: tab === t ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: tab === t ? 'var(--shadow-sm)' : 'none',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'focus' ? (
          <FocusDashboard
            focus={focus}
            initialHistorySessionId={initialHistorySessionId}
            onViewInTimeline={onViewInTimeline}
          />
        ) : (
          <FocusPreferences focus={focus} />
        )}
      </div>
    </div>
  );
}
