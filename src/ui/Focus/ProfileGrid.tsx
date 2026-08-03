import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Copy, X, Save, Search, Globe, Monitor, Tag } from 'lucide-react';
import type { UseFocusResult, FocusProfileDto, FocusMode, FocusRuleDto } from './useFocus';

const NEW_PROFILE_ID = '__new__';

interface ProfileGridProps {
  focus: UseFocusResult;
}

export function ProfileGrid({ focus }: ProfileGridProps) {
  const { profiles, rules, saveProfile, deleteProfile } = focus;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this profile?')) return;
    try {
      await deleteProfile(id);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  };

  const handleDuplicate = (profile: FocusProfileDto) => {
    const newId = `profile-${Date.now()}`;
    const copy: FocusProfileDto = {
      ...profile,
      id: newId,
      name: `${profile.name} (Copy)`,
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rules: profile.rules.map((r) => ({ ...r, id: r.id, profileId: newId })),
    };
    saveProfile(copy, profile.rules.map((r) => r.id)).catch((e) => setError(e?.message ?? String(e)));
  };

  const editingProfile = useMemo(() => {
    if (!editingId) return null;
    if (editingId === NEW_PROFILE_ID) return null;
    return profiles.find((p) => p.id === editingId) ?? null;
  }, [editingId, profiles]);

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Monitor size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="text-[16px] font-bold">Profiles</h2>
        </div>
        <button
          onClick={() => setEditingId(NEW_PROFILE_ID)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          <Plus size={14} /> New Profile
        </button>
      </div>

      {error && (
        <div className="card p-3 text-[12px] text-danger border-danger mb-4">{error}</div>
      )}

      {profiles.length === 0 && (
        <div className="text-[13px] text-muted py-6 text-center bg-secondary rounded-lg border border-default border-dashed">
          No profiles found. Create one to define what Focus blocks.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {profiles.map((profile) => {
          const blockCount = profile.rules.filter((r) => r.action === 'block').length;
          return (
            <div
              key={profile.id}
              className="card p-4 border border-default hover:bg-hover transition-colors"
              style={{ background: 'var(--bg)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-[14px] text-default truncate">{profile.name}</div>
                    {profile.isDefault && (
                      <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-soft text-accent">Default</span>
                    )}
                  </div>
                  {profile.description && <div className="text-[12px] text-muted mt-0.5 truncate">{profile.description}</div>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleDuplicate(profile)}
                    title="Duplicate"
                    className="p-1.5 rounded-md text-muted hover:text-default hover:bg-secondary transition-colors"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={() => handleDelete(profile.id)}
                    title="Delete"
                    className="p-1.5 rounded-md text-muted hover:text-danger hover:bg-danger-soft transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="bg-secondary rounded-md p-2 text-center">
                  <div className="text-[10px] text-muted font-bold uppercase">Mode</div>
                  <div className="text-[12px] font-semibold text-default capitalize">{profile.mode}</div>
                </div>
                <div className="bg-secondary rounded-md p-2 text-center">
                  <div className="text-[10px] text-muted font-bold uppercase">Duration</div>
                  <div className="text-[12px] font-semibold text-default">
                    {profile.mode === 'countdown' ? `${profile.defaultDurationMinutes ?? '—'}m` : 'Open'}
                  </div>
                </div>
                <div className="bg-secondary rounded-md p-2 text-center">
                  <div className="text-[10px] text-muted font-bold uppercase">Blocks</div>
                  <div className="text-[12px] font-semibold text-default">{blockCount}</div>
                </div>
              </div>
              <button
                onClick={() => setEditingId(profile.id)}
                className="w-full mt-3 py-1.5 rounded-md border border-default bg-secondary text-[12px] font-semibold text-default hover:bg-hover transition-colors"
              >
                Edit
              </button>
            </div>
          );
        })}
      </div>

      <ProfileDrawer
        focus={focus}
        profile={editingProfile}
        isNew={editingId === NEW_PROFILE_ID}
        open={editingId !== null}
        onClose={() => setEditingId(null)}
        onSave={async () => {
          setEditingId(null);
          setError(null);
        }}
      />
    </section>
  );
}

interface ProfileDrawerProps {
  focus: UseFocusResult;
  profile: FocusProfileDto | null;
  isNew: boolean;
  open: boolean;
  onClose: () => void;
  onSave: () => void;
}

function ProfileDrawer({ focus, profile, isNew, open, onClose, onSave }: ProfileDrawerProps) {
  const { rules, saveProfile } = focus;
  const [name, setName] = useState(profile?.name ?? 'New Profile');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [mode, setMode] = useState<FocusMode>(profile?.mode ?? 'countdown');
  const [duration, setDuration] = useState(profile?.defaultDurationMinutes ?? 25);
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? 'New Profile');
      setDescription(profile?.description ?? '');
      setMode(profile?.mode ?? 'countdown');
      setDuration(profile?.defaultDurationMinutes ?? 25);
      setIsDefault(profile?.isDefault ?? false);
      setSelectedRuleIds(new Set(profile?.rules.map((r) => r.id) ?? []));
      setError(null);
      setSearch('');
    }
  }, [open, profile]);

  if (!open) return null;

  const handleSave = async () => {
    const now = new Date().toISOString();
    const id = isNew ? `profile-${Date.now()}` : profile!.id;
    const activeRuleIds = Array.from(selectedRuleIds);
    const activeRules = rules.filter((r) => selectedRuleIds.has(r.id));
    const p: FocusProfileDto = {
      id,
      name: name.trim(),
      description: description.trim() || null,
      isDefault,
      mode,
      defaultDurationMinutes: mode === 'countdown' ? Math.max(1, duration) : null,
      blocksDistractions: activeRules.some((r) => r.action === 'block'),
      soundCue: null,
      createdAt: profile?.createdAt ?? now,
      updatedAt: now,
      rules: activeRules.map((r) => ({
        id: r.id,
        profileId: id,
        type: r.type,
        target: r.target,
        action: r.action,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
    try {
      await saveProfile(p, activeRuleIds);
      // Ensure only this profile is default.
      if (isDefault) {
        for (const other of focus.profiles) {
          if (other.id !== id && other.isDefault) {
            await saveProfile({ ...other, isDefault: false }, other.rules.map((r) => r.id));
          }
        }
      }
      onSave();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  };

  const toggleRule = (id: string) => {
    setSelectedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredRules = rules.filter((r) =>
    r.target.toLowerCase().includes(search.toLowerCase()) ||
    r.type.toLowerCase().includes(search.toLowerCase())
  );
  const grouped = groupBy(filteredRules, 'type');

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg h-full bg-secondary border-l border-default shadow-lg p-5 overflow-y-auto animate-in slide-in-from-right">
        <div className="flex items-center justify-between mb-5">
          <div className="text-[16px] font-bold">{isNew ? 'New Profile' : 'Edit Profile'}</div>
          <button onClick={onClose} className="p-1 rounded-md text-muted hover:text-default"><X size={18} /></button>
        </div>

        {error && (
          <div className="card p-3 text-[12px] text-danger border-danger mb-4">{error}</div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="text-[12px] font-bold text-muted block mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this profile for?"
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[12px] font-bold text-muted block mb-1">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as FocusMode)}
                className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
              >
                <option value="countdown">Countdown</option>
                <option value="stopwatch">Stopwatch</option>
              </select>
            </div>
            <div>
              <label className="text-[12px] font-bold text-muted block mb-1">Duration (min)</label>
              <input
                type="number"
                min={1}
                value={duration}
                disabled={mode !== 'countdown'}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent disabled:opacity-50"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-default cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="accent-accent" />
            <span className="font-medium">Default profile</span>
          </label>
        </div>

        <div className="mt-6 pt-4 border-t border-default">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[12px] font-bold uppercase tracking-wide text-muted">Active Rules</div>
          </div>
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search rules..."
              className="w-full pl-9 pr-3 py-2 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
            />
          </div>

          {rules.length === 0 && (
            <div className="text-[12px] text-muted py-4 text-center bg-default rounded-lg border border-dashed border-default">
              No rules yet. Add them in Preferences → Blocked Websites & Apps.
            </div>
          )}

          <div className="space-y-4">
            {(['website', 'app', 'category'] as const).map((type) => {
              const items = grouped[type] ?? [];
              if (items.length === 0) return null;
              return (
                <div key={type}>
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted mb-2">
                    {type === 'website' && <Globe size={12} />}
                    {type === 'app' && <Monitor size={12} />}
                    {type === 'category' && <Tag size={12} />}
                    {type}
                  </div>
                  <div className="space-y-1">
                    {items.map((rule) => (
                      <label
                        key={rule.id}
                        className="flex items-center justify-between gap-3 p-2 rounded-md bg-default border border-default cursor-pointer hover:bg-hover transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={selectedRuleIds.has(rule.id)}
                            onChange={() => toggleRule(rule.id)}
                            className="accent-accent shrink-0"
                            disabled={!rule.enabled}
                          />
                          <span className={`text-[13px] truncate ${rule.enabled ? 'text-default' : 'text-muted line-through'}`}>
                            {rule.target}
                          </span>
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted">
                          {rule.action}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2 pt-4 mt-4 border-t border-default">
          <button onClick={onClose} className="flex-1 py-2 rounded-md border border-default bg-secondary text-[13px] font-semibold text-default">Cancel</button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex-1 py-2 rounded-md text-[13px] font-bold flex items-center justify-center gap-2"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: !name.trim() ? 0.7 : 1 }}
          >
            <Save size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function groupBy<T extends Record<string, any>, K extends keyof T>(arr: T[], key: K): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const k = String(item[key]);
    acc[k] = acc[k] ?? [];
    acc[k].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}
