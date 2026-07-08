import { Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, type Theme } from '../store/themeStore';

const ITEMS: { id: Theme; Icon: typeof Sun; label: string }[] = [
  { id: 'system', Icon: Monitor, label: 'System theme' },
  { id: 'light', Icon: Sun, label: 'Light theme' },
  { id: 'dark', Icon: Moon, label: 'Dark theme' },
];

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md p-0.5"
      style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
    >
      {ITEMS.map(({ id, Icon, label }) => {
        const selected = theme === id;
        return (
          <button
            key={id}
            onClick={() => setTheme(id)}
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            className="h-7 w-8 inline-flex items-center justify-center rounded-[5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
            style={{
              color: selected ? 'var(--text)' : 'var(--text-muted)',
              background: selected ? 'var(--bg)' : 'transparent',
              boxShadow: selected ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <Icon size={14} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}