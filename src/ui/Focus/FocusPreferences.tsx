import { useEffect, useMemo, useState } from 'react';
import { Bell, Moon, Clock, Zap, Monitor, Keyboard, Globe, Plus, Trash2, Check } from 'lucide-react';
import type { UseFocusResult, FocusRuleDto } from './useFocus';

const STORAGE_KEY = 'reflect_focus_preferences';

interface FocusPreferencesData {
  defaultProfileId: string | null;
  idleAutoPause: boolean;
  idleThresholdSeconds: number;
  autoResume: boolean;
  expiryBehavior: 'continue' | 'ask' | 'stop-blocking';
  notificationStart: boolean;
  notificationExpiry: boolean;
  notificationIdle: boolean;
  notificationComplete: boolean;
  trayShowTimer: boolean;
  trayControls: boolean;
}

const DEFAULTS: FocusPreferencesData = {
  defaultProfileId: null,
  idleAutoPause: true,
  idleThresholdSeconds: 120,
  autoResume: true,
  expiryBehavior: 'continue',
  notificationStart: false,
  notificationExpiry: true,
  notificationIdle: true,
  notificationComplete: true,
  trayShowTimer: true,
  trayControls: true,
};

function loadPrefs(): FocusPreferencesData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function savePrefs(prefs: FocusPreferencesData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function FocusPreferences({ focus }: { focus: UseFocusResult }) {
  const { profiles, rules, saveRule, deleteRule } = focus;
  const [prefs, setPrefs] = useState<FocusPreferencesData>(loadPrefs());

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const update = <K extends keyof FocusPreferencesData>(key: K, value: FocusPreferencesData[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  const defaultProfile = useMemo(() => {
    if (prefs.defaultProfileId) {
      const p = profiles.find((x) => x.id === prefs.defaultProfileId);
      if (p) return p;
    }
    return profiles.find((p) => p.isDefault) ?? profiles[0];
  }, [profiles, prefs.defaultProfileId]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="text-[18px] font-bold">Focus Preferences</h2>
          <p className="text-[13px] text-muted">Defaults and guardrails for focus sessions.</p>
        </div>

        {/* General */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Clock size={16} style={{ color: 'var(--accent)' }} />
            General
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-[12px] font-bold text-muted block mb-1">Default profile</label>
              <select
                value={prefs.defaultProfileId ?? defaultProfile?.id ?? ''}
                onChange={(e) => update('defaultProfileId', e.target.value || null)}
                className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[12px] font-bold text-muted block mb-1">Default timer</label>
              <div className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default capitalize">
                {defaultProfile?.mode ?? '—'}
              </div>
            </div>
            <div>
              <label className="text-[12px] font-bold text-muted block mb-1">Default duration</label>
              <div className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default">
                {defaultProfile?.mode === 'countdown' ? `${defaultProfile?.defaultDurationMinutes ?? '—'} min` : 'Open ended'}
              </div>
            </div>
          </div>
        </section>

        {/* Blocked Websites & Apps */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Globe size={16} style={{ color: 'var(--accent)' }} />
            Blocked Websites & Apps
          </div>
          <p className="text-[12px] text-muted">
            Global rules that profiles can activate. Wildcards are supported (e.g. <code>*.youtube.com</code>).
          </p>
          <BlockListManager rules={rules} onSave={saveRule} onDelete={deleteRule} />
        </section>

        {/* Notifications */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Bell size={16} style={{ color: 'var(--accent)' }} />
            Notifications
          </div>
          <div className="space-y-3">
            <Toggle label="Session started" checked={prefs.notificationStart} onChange={(v) => update('notificationStart', v)} />
            <Toggle label="Timer expired" checked={prefs.notificationExpiry} onChange={(v) => update('notificationExpiry', v)} />
            <Toggle label="Idle auto-pause" checked={prefs.notificationIdle} onChange={(v) => update('notificationIdle', v)} />
            <Toggle label="Session completed" checked={prefs.notificationComplete} onChange={(v) => update('notificationComplete', v)} />
          </div>
        </section>

        {/* Idle Behaviour */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Moon size={16} style={{ color: 'var(--accent)' }} />
            Idle Behaviour
          </div>
          <Toggle label="Auto-pause when idle" checked={prefs.idleAutoPause} onChange={(v) => update('idleAutoPause', v)} />
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1">Idle threshold (seconds)</label>
            <input
              type="number"
              min={5}
              value={prefs.idleThresholdSeconds}
              disabled={!prefs.idleAutoPause}
              onChange={(e) => update('idleThresholdSeconds', Number(e.target.value))}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
          <Toggle label="Auto-resume on activity" checked={prefs.autoResume} onChange={(v) => update('autoResume', v)} />
        </section>

        {/* Countdown Behaviour */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Zap size={16} style={{ color: 'var(--accent)' }} />
            Countdown Behaviour
          </div>
          <div>
            <label className="text-[12px] font-bold text-muted block mb-1">When time expires</label>
            <select
              value={prefs.expiryBehavior}
              onChange={(e) => update('expiryBehavior', e.target.value as FocusPreferencesData['expiryBehavior'])}
              className="w-full px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
            >
              <option value="continue">Continue timing and blocking</option>
              <option value="ask">Ask what to do</option>
              <option value="stop-blocking">Stop blocking, keep timing</option>
            </select>
          </div>
        </section>

        {/* System Tray */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Monitor size={16} style={{ color: 'var(--accent)' }} />
            System Tray
          </div>
          <Toggle label="Show active timer in tray tooltip" checked={prefs.trayShowTimer} onChange={(v) => update('trayShowTimer', v)} />
          <Toggle label="Show controls in tray menu" checked={prefs.trayControls} onChange={(v) => update('trayControls', v)} />
        </section>

        {/* Shortcuts */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2 text-[14px] font-bold text-default">
            <Keyboard size={16} style={{ color: 'var(--accent)' }} />
            Shortcuts
          </div>
          <div className="text-[13px] text-muted space-y-2">
            <div className="flex items-center justify-between py-1 border-b border-default">
              <span>Open Focus / Start session</span>
              <span className="font-mono text-[12px] bg-secondary px-2 py-0.5 rounded border border-default">Ctrl+Shift+F</span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-default">
              <span>Pause / Resume</span>
              <span className="font-mono text-[12px] bg-secondary px-2 py-0.5 rounded border border-default">Space</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span>Stop session</span>
              <span className="font-mono text-[12px] bg-secondary px-2 py-0.5 rounded border border-default">Esc</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between text-[13px] text-default cursor-pointer">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
    </label>
  );
}

function BlockListManager({
  rules,
  onSave,
  onDelete,
}: {
  rules: FocusRuleDto[];
  onSave: (rule: FocusRuleDto) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [type, setType] = useState<'website' | 'app' | 'category'>('website');
  const [target, setTarget] = useState('');
  const [action, setAction] = useState<'block' | 'allow'>('block');
  const [tab, setTab] = useState<'website' | 'app' | 'category'>('website');

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = target.trim();
    if (!value) return;
    const now = new Date().toISOString();
    await onSave({
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      target: value,
      action,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    setTarget('');
  };

  const handleToggleEnabled = async (rule: FocusRuleDto) => {
    await onSave({ ...rule, enabled: !rule.enabled, updatedAt: new Date().toISOString() });
  };

  const filtered = rules.filter((r) => r.type === tab);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 bg-default p-0.5 rounded-lg border border-default w-fit">
        {(['website', 'app', 'category'] as const).map((t) => (
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
            {t}s
          </button>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent"
        >
          <option value="website">Website</option>
          <option value="app">Application</option>
          <option value="category">Category</option>
        </select>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={
            type === 'website' ? 'e.g. *.youtube.com' : type === 'app' ? 'e.g. steam.exe' : 'e.g. social-media'
          }
          className="flex-1 px-3 py-2 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as typeof action)}
          className="px-3 py-2 bg-default border border-default rounded-md text-[13px] font-bold focus:outline-none focus:border-accent"
          style={{ color: action === 'block' ? 'var(--danger)' : 'var(--success)' }}
        >
          <option value="block">Block</option>
          <option value="allow">Allow</option>
        </select>
        <button
          type="submit"
          disabled={!target.trim()}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-md font-bold text-[13px]"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: !target.trim() ? 0.7 : 1 }}
        >
          <Plus size={14} /> Add
        </button>
      </form>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-[13px] text-muted py-4 text-center bg-secondary rounded-lg border border-dashed border-default">
            No {tab} rules. Add one above.
          </div>
        )}
        {filtered.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center justify-between gap-3 p-3 rounded-md bg-default border border-default"
          >
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={() => handleToggleEnabled(rule)}
                title={rule.enabled ? 'Enabled' : 'Disabled'}
                className="shrink-0 h-5 w-5 rounded flex items-center justify-center border"
                style={{
                  background: rule.enabled ? 'var(--accent)' : 'var(--bg-secondary)',
                  borderColor: rule.enabled ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {rule.enabled && <Check size={12} style={{ color: 'var(--accent-text)' }} />}
              </button>
              <span className={`text-[13px] truncate ${rule.enabled ? 'text-default' : 'text-muted line-through'}`}>
                {rule.target}
              </span>
              <span
                className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                style={{
                  background: rule.action === 'block' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(34, 197, 94, 0.12)',
                  color: rule.action === 'block' ? 'var(--danger)' : 'var(--success)',
                }}
              >
                {rule.action}
              </span>
            </div>
            <button
              onClick={() => onDelete(rule.id)}
              title="Delete"
              className="p-1.5 rounded-md text-muted hover:text-danger hover:bg-danger-soft transition-colors shrink-0"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
