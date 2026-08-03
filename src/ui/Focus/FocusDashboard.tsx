import { useMemo } from 'react';
import type { UseFocusResult } from './useFocus';
import { ActiveSessionCard } from './ActiveSessionCard';
import { StartSessionCard } from './StartSessionCard';
import { RecentSessions } from './RecentSessions';
import { ProfileGrid } from './ProfileGrid';

interface FocusDashboardProps {
  focus: UseFocusResult;
  initialHistorySessionId?: string | null;
  onViewInTimeline?: (isoDate: string) => void;
}

export function FocusDashboard({ focus, initialHistorySessionId, onViewInTimeline }: FocusDashboardProps) {
  const { activeSession, profiles, pause, resume, stop } = focus;

  const defaultProfile = useMemo(() => profiles.find((p) => p.isDefault) ?? profiles[0], [profiles]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Top row: session + profile context */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {activeSession ? (
            <ActiveSessionCard
              session={activeSession}
              onPause={pause}
              onResume={resume}
              onStop={stop}
            />
          ) : (
            <StartSessionCard focus={focus} />
          )}

          <ProfileContextCard profile={defaultProfile} />
        </div>

        {/* Recent Sessions */}
        <RecentSessions
          focus={focus}
          initialSessionId={initialHistorySessionId}
          onViewInTimeline={onViewInTimeline}
        />

        {/* Profiles */}
        <ProfileGrid focus={focus} />
      </div>
    </div>
  );
}

function ProfileContextCard({ profile }: { profile?: UseFocusResult['profiles'][number] }) {
  if (!profile) {
    return (
      <div className="card p-5 flex flex-col justify-center h-full">
        <div className="text-[13px] text-muted">No profiles yet.</div>
        <div className="text-[12px] text-faint mt-1">Create a profile below to define what Focus blocks.</div>
      </div>
    );
  }

  const blockCount = profile.rules.filter((r) => r.action === 'block').length;

  return (
    <div className="card p-5 h-full flex flex-col justify-between">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-2">Active Profile</div>
        <div className="text-[18px] font-bold text-default">{profile.name}</div>
        {profile.description && (
          <div className="text-[12px] text-muted mt-1">{profile.description}</div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 mt-4">
        <div className="bg-default border border-default rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1">Mode</div>
          <div className="text-[14px] font-semibold text-default capitalize">{profile.mode}</div>
        </div>
        <div className="bg-default border border-default rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1">Duration</div>
          <div className="text-[14px] font-semibold text-default">
            {profile.mode === 'countdown' ? `${profile.defaultDurationMinutes ?? '—'}m` : 'Open'}
          </div>
        </div>
        <div className="bg-default border border-default rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1">Blocks</div>
          <div className="text-[14px] font-semibold text-default">{blockCount} rules</div>
        </div>
      </div>
    </div>
  );
}
