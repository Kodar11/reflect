import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Sparkles, Activity, Layers, Clock, type LucideIcon } from 'lucide-react';
import { APP_VERSION } from '../lib/version';

export type Route = 'timeline' | 'settings' | 'activity' | 'sessions';

interface SidebarProps {
  route: Route;
  onNavigate: (r: Route) => void;
  open: boolean;
}

const ITEMS: { id: Route; label: string; Icon: LucideIcon }[] = [
  { id: 'timeline', label: 'Timeline', Icon: Clock },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'sessions', label: 'Sessions (Dev)', Icon: Layers },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export function Sidebar({ route, onNavigate, open }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const [currentEvent, setCurrentEvent] = useState<any>(null);
  const [timeString, setTimeString] = useState('');

  const isExpanded = open || hovered;

  // Poll current active tracking details
  const fetchCurrent = async () => {
    try {
      const events = await window.tracker.getToday();
      const active = events.find((e: any) => e.watcher === 'window-watcher');
      if (active) {
        setCurrentEvent(active);
      } else {
        setCurrentEvent(null);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchCurrent();
    const pollInterval = setInterval(fetchCurrent, 3000);
    return () => clearInterval(pollInterval);
  }, []);

  // Update real-time clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      let hrs = now.getHours();
      const mins = String(now.getMinutes()).padStart(2, '0');
      const secs = String(now.getSeconds()).padStart(2, '0');
      const ampm = hrs >= 12 ? 'PM' : 'AM';
      const displayHours = hrs % 12 || 12;
      
      const formatted = `${String(displayHours).padStart(2, '0')}:${mins}:${secs} ${ampm}`;
      setTimeString(formatted);
    };
    updateTime();
    const clockInterval = setInterval(updateTime, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  return (
    <aside
      aria-hidden={!open}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="shrink-0 sticky top-11 overflow-hidden flex flex-col transition-[width] duration-200 ease-out z-30"
      style={{
        width: isExpanded ? '240px' : '56px',
        height: 'calc(100vh - 2.75rem)',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border)',
        boxShadow: isExpanded && !open ? 'var(--shadow-lg)' : 'none',
        paddingTop: isExpanded ? '0px' : '12px',
      }}
    >
      <div style={{ width: isExpanded ? '240px' : '56px' }} className="flex flex-col h-full">
        {/* Header Section */}
        {isExpanded && (
          <div className="px-4 pt-4 pb-3 flex items-center gap-2.5 select-none overflow-hidden animate-fadeIn">
            <div
              className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0"
              style={{ background: 'var(--text)', color: 'var(--bg)' }}
            >
              <Sparkles size={15} strokeWidth={2.25} />
            </div>
            <div className="leading-tight">
              <div className="text-[13.5px] font-semibold text-default whitespace-nowrap">Productivity Coach</div>
              <div className="text-[11.5px] text-muted mt-0.5 whitespace-nowrap">Reflect Timeline</div>
            </div>
          </div>
        )}

        {/* Navigation Items */}
        <nav className="px-2 mt-1 flex flex-col gap-0.5">
          {ITEMS.map(({ id, label, Icon }) => {
            const isActive = route === id;
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                className="inline-flex items-center rounded-md text-[13.5px] transition-colors"
                style={{
                  color: isActive ? 'var(--text)' : 'var(--text-muted)',
                  fontWeight: isActive ? 500 : 400,
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  padding: isExpanded ? '6px 10px' : '8px 0',
                  justifyContent: isExpanded ? 'flex-start' : 'center',
                  width: '100%',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
                title={!isExpanded ? label : undefined}
              >
                <Icon size={15} strokeWidth={1.75} className="shrink-0" />
                {isExpanded && <span className="ml-2.5 whitespace-nowrap animate-fadeIn">{label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Current Timer Section */}
        {isExpanded && (
          <div className="mt-auto px-4 pb-4 animate-fadeIn">
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                <span>Currently Tracking</span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text)', margin: '4px 0', fontFamily: 'monospace, var(--font-mono)' }}>
                {timeString}
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', fontWeight: 550 }} title={currentEvent?.app ?? 'Idle'}>
                {currentEvent?.app ?? 'Idle'}
              </div>
            </div>
          </div>
        )}

        {/* Footer Version info */}
        {isExpanded && (
          <div className="px-4 pb-3 text-[11px] text-faint animate-fadeIn">
            v{APP_VERSION}
          </div>
        )}
      </div>
    </aside>
  );
}
