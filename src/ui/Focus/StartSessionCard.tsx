import { useEffect, useMemo, useState } from 'react';
import { Play, Clock, Hourglass, ChevronDown, ChevronUp } from 'lucide-react';
import type { UseFocusResult, FocusProfileDto, FocusMode } from './useFocus';

const SUGGESTED_TASKS = ['Write proposal', 'Refactor auth', 'Review PRs', 'Deep reading'];
const PREF_KEY = 'reflect_focus_preferences';

function loadPrefProfileId(): string | null {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    return JSON.parse(raw)?.defaultProfileId ?? null;
  } catch {
    return null;
  }
}

interface StartSessionCardProps {
  focus: UseFocusResult;
}

export function StartSessionCard({ focus }: StartSessionCardProps) {
  const { profiles, loading, start } = focus;
  const defaultProfile = useMemo(() => {
    const prefId = loadPrefProfileId();
    return profiles.find((p) => p.id === prefId) ?? profiles.find((p) => p.isDefault) ?? profiles[0];
  }, [profiles]);
  const [profileId, setProfileId] = useState(defaultProfile?.id ?? '');
  const [task, setTask] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<FocusMode>(defaultProfile?.mode ?? 'countdown');
  const [duration, setDuration] = useState(defaultProfile?.defaultDurationMinutes ?? 25);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const current = profiles.find((p) => p.id === profileId);
    const target = current ?? defaultProfile;
    if (target && target.id !== profileId) {
      setProfileId(target.id);
    }
    const p = profiles.find((x) => x.id === profileId);
    if (p) {
      setMode(p.mode);
      if (p.defaultDurationMinutes) setDuration(p.defaultDurationMinutes);
    }
  }, [profileId, profiles, defaultProfile]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const canSubmit = task.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    start({
      profileId,
      task: task.trim(),
      notes: notes.trim() || null,
      mode,
      plannedDurationMinutes: mode === 'countdown' ? Math.max(1, duration) : null,
    });
  };

  return (
    <div className="card p-6 h-full">
      <div className="flex items-center gap-3 mb-5">
        <div className="h-10 w-10 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-soft)' }}>
          <Play size={20} style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <h2 className="text-[18px] font-bold">Start a Focus Session</h2>
          <p className="text-[13px] text-muted">Define what you intend to work on.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-[12px] font-bold text-muted block mb-1.5">What are you working on?</label>
          <input
            autoFocus
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Write project proposal"
            className="w-full px-3 py-2 bg-default border border-default rounded-md text-[14px] text-default font-medium placeholder-muted focus:outline-none focus:border-accent"
          />
          <div className="flex flex-wrap gap-2 mt-2">
            {SUGGESTED_TASKS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTask(t)}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-default bg-secondary text-muted hover:text-default transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1.5">Profile</label>
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[12px] font-bold text-muted block mb-1.5">Mode</label>
            <div className="flex gap-2">
              <ModeButton active={mode === 'countdown'} onClick={() => setMode('countdown')} icon={<Hourglass size={14} />} label="Countdown" />
              <ModeButton active={mode === 'stopwatch'} onClick={() => setMode('stopwatch')} icon={<Clock size={14} />} label="Stopwatch" />
            </div>
          </div>
        </div>

        {mode === 'countdown' && (
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1.5">Duration (minutes)</label>
            <input
              type="number"
              min={1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
            />
          </div>
        )}

        {selectedProfile && (
          <div className="text-[12px] text-muted flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />
            {selectedProfile.blocksDistractions
              ? `${selectedProfile.rules.length} blocking rule${selectedProfile.rules.length === 1 ? '' : 's'} active`
              : 'No blocking enabled for this profile'}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-default transition-colors"
        >
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {showAdvanced ? 'Hide advanced' : 'More options'}
        </button>

        {showAdvanced && (
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1.5">Notes <span className="font-normal text-faint">(optional)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Context, goals, anything the future AI coach should know..."
              rows={3}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent resize-y"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !canSubmit}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-md font-bold text-[14px] transition-opacity"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: loading || !canSubmit ? 0.7 : 1 }}
        >
          <Play size={16} />
          Start Focus
        </button>
      </form>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md border border-default text-[12px] font-semibold transition-colors"
      style={{
        background: active ? 'var(--accent-soft)' : 'var(--bg)',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
