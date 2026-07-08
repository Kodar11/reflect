import { Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  showSidebarToggle: boolean;
}

export function Header({ sidebarOpen, onToggleSidebar, showSidebarToggle }: Props) {
  return (
    <header
      className="app-frame flex items-center justify-between h-11 px-2 sticky top-0 z-30"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
    >
      <div className="app-frame-no-drag flex items-center gap-1.5">
        {showSidebarToggle && (
          <IconButton onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </IconButton>
        )}
        <span className="px-1.5 text-[12.5px] text-muted select-none">Productivity Coach</span>
      </div>

      <div className="app-frame-no-drag flex items-center gap-2">
        <ThemeToggle />
        <div className="w-px h-5 mx-1" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-1">
          <IconButton onClick={() => window.app.sendFrameAction('MINIMIZE')} aria-label="Minimize">
            <Minus size={15} />
          </IconButton>
          <IconButton onClick={() => window.app.sendFrameAction('MAXIMIZE')} aria-label="Maximize">
            <Square size={12.5} />
          </IconButton>
          <IconButton onClick={() => window.app.sendFrameAction('CLOSE')} aria-label="Close" danger>
            <X size={15} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

function IconButton(props: {
  onClick: () => void;
  children: React.ReactNode;
  'aria-label': string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={props.onClick}
      aria-label={props['aria-label']}
      className="h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = props.danger ? 'var(--danger)' : 'var(--bg-hover)';
        el.style.color = props.danger ? '#fff' : 'var(--text)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = 'transparent';
        el.style.color = 'var(--text-muted)';
      }}
    >
      {props.children}
    </button>
  );
}
