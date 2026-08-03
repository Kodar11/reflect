import { X, Target, Clock, Layers, ShieldAlert, Sparkles } from 'lucide-react';
import { formatDuration, formatClock, type FocusSummaryDto } from './useFocus';

interface FocusSummaryModalProps {
  summary: FocusSummaryDto;
  onClose: () => void;
}

export function FocusSummaryModal({ summary, onClose }: FocusSummaryModalProps) {
  const productiveMinutes = Math.round(summary.productiveMs / 60000);
  const elapsedMinutes = Math.round(summary.session.elapsedMs / 60000);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 120ms var(--ease-out)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 420,
          maxWidth: '90vw',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          padding: 28,
          animation: 'scaleIn 160ms var(--ease-out)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Focus Complete
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text)' }}>
              {summary.session.task}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: 4 }}>
              {summary.profile.name} · {summary.session.mode === 'countdown' ? 'Countdown' : 'Stopwatch'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ color: 'var(--text-muted)', padding: 4, borderRadius: 6 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <SummaryCard
            icon={<Clock size={16} />}
            label="Total Focus Time"
            value={formatClock(summary.session.elapsedMs)}
            sub={`${elapsedMinutes} min`}
          />
          <SummaryCard
            icon={<Layers size={16} />}
            label="Productive Time"
            value={formatDuration(summary.productiveMs)}
            sub={`${productiveMinutes} min tracked`}
          />
          <SummaryCard
            icon={<Sparkles size={16} />}
            label="Interruptions"
            value={String(summary.interruptionCount)}
            sub={summary.interruptionCount === 1 ? 'pause recorded' : 'pauses recorded'}
          />
          <SummaryCard
            icon={<ShieldAlert size={16} />}
            label="Blocked Attempts"
            value={String(summary.blockedAttemptCount)}
            sub={summary.blockedAttemptCount === 1 ? 'distraction stopped' : 'distractions stopped'}
          />
        </div>

        {summary.session.notes && (
          <div style={{ marginBottom: 20, padding: 12, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
            {summary.session.notes}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          style={{
            width: '100%',
            padding: '11px 0',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--accent-text)',
            fontWeight: 700,
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', marginBottom: 8 }}>
        {icon}
        <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</span>
      </div>
      <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
