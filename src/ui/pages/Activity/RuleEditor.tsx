import { useEffect, useState } from 'react';
import type { DimensionDto, RuleEditorState } from './activityTypes';
import { CURATED_COLORS } from './activityUtils';

interface RuleEditorProps {
  open: boolean;
  title?: string;
  initialRule: RuleEditorState;
  dimensions: { areas: DimensionDto[]; intents: DimensionDto[]; qualities: DimensionDto[] };
  onSave: (rule: RuleEditorState) => void;
  onCancel: () => void;
}

export function RuleEditor({ open, title, initialRule, dimensions, onSave, onCancel }: RuleEditorProps) {
  const [rule, setRule] = useState<RuleEditorState>(initialRule);

  useEffect(() => {
    if (open) {
      setRule(initialRule);
    }
  }, [open, initialRule]);

  if (!open) return null;

  const update = <K extends keyof RuleEditorState>(key: K, value: RuleEditorState[K]) => {
    setRule((r) => ({ ...r, [key]: value }));
  };

  const updateCondition = (idx: number, patch: Partial<{ type: string; value: string }>) => {
    setRule((r) => ({
      ...r,
      conditions: r.conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  };

  const addCondition = () => {
    setRule((r) => ({
      ...r,
      conditions: [...r.conditions, { type: 'app_equals', value: '' }],
    }));
  };

  const removeCondition = (idx: number) => {
    setRule((r) => ({
      ...r,
      conditions: r.conditions.filter((_, i) => i !== idx),
    }));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        padding: 24,
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="card space-y-4"
        style={{
          width: '100%',
          maxWidth: 460,
          padding: 20,
          animation: 'inspectorIn 140ms var(--ease-out)',
          boxShadow: 'var(--shadow-lg)',
          borderRadius: 12,
        }}
      >
        <div>
          <h2 className="text-[17px] font-bold text-default">{title ?? (rule.id.startsWith('rule_') ? 'Create Tracking Rule' : 'Edit Tracking Rule')}</h2>
          <p className="text-[12px] text-muted mt-0.5">
            When a session matches these conditions, classify it as Context + Area + Intent + Quality.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-[11.5px] font-bold text-muted">Context (Activity) Name</label>
          <input
            type="text"
            value={rule.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="e.g. Coding, ChatGPT, Writing"
            className="w-full px-3 py-1.5 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent font-semibold"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11.5px] font-bold text-muted">Theme Color</label>
          <div className="flex gap-2 flex-wrap">
            {CURATED_COLORS.map((col) => (
              <button
                key={col.name}
                title={col.name}
                onClick={() => update('color', col.name)}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: col.hex,
                  border: rule.color === col.name ? '2px solid var(--text)' : '1px solid transparent',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11.5px] font-bold text-muted">Area</label>
            <select
              value={rule.areaId ?? ''}
              onChange={(e) => update('areaId', e.target.value || null)}
              className="w-full px-2 py-1.5 bg-default border border-default rounded-md text-[12px] text-default focus:outline-none focus:border-accent"
            >
              <option value="">(None)</option>
              {dimensions.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11.5px] font-bold text-muted">Intent</label>
            <select
              value={rule.intentId ?? ''}
              onChange={(e) => update('intentId', e.target.value || null)}
              className="w-full px-2 py-1.5 bg-default border border-default rounded-md text-[12px] text-default focus:outline-none focus:border-accent"
            >
              <option value="">(None)</option>
              {dimensions.intents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11.5px] font-bold text-muted">Quality</label>
            <select
              value={rule.qualityId ?? ''}
              onChange={(e) => update('qualityId', e.target.value || null)}
              className="w-full px-2 py-1.5 bg-default border border-default rounded-md text-[12px] text-default focus:outline-none focus:border-accent"
            >
              <option value="">(None)</option>
              {dimensions.qualities.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11.5px] font-bold text-muted">Priority</label>
            <input
              type="number"
              value={rule.priority}
              onChange={(e) => update('priority', Number(e.target.value) || 0)}
              className="w-full px-2 py-1.5 bg-default border border-default rounded-md text-[12px] text-default focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11.5px] font-bold text-muted flex justify-between items-center">
            <span>Matching Conditions</span>
            <button
              onClick={addCondition}
              style={{ color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
            >
              + Add Condition
            </button>
          </label>

          <div className="space-y-2 max-h-[120px] overflow-y-auto pr-1">
            {rule.conditions.length === 0 ? (
              <div className="text-[11.5px] text-faint py-2 text-center bg-secondary rounded-lg border border-default">
                No conditions defined. Match will not trigger.
              </div>
            ) : (
              rule.conditions.map((cond, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <select
                    value={cond.type}
                    onChange={(e) => updateCondition(idx, { type: e.target.value })}
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '3px 6px',
                      fontSize: '11.5px',
                      outline: 'none',
                    }}
                  >
                    <option value="app_equals">Application equals</option>
                    <option value="title_contains">Window Title contains</option>
                    <option value="url_contains">URL contains</option>
                    <option value="url_starts_with">URL starts with</option>
                    <option value="domain_equals">Domain equals</option>
                    <option value="browser_equals">Browser equals</option>
                  </select>

                  <input
                    type="text"
                    value={cond.value}
                    onChange={(e) => updateCondition(idx, { value: e.target.value })}
                    placeholder="match string"
                    style={{
                      flex: 1,
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '3px 6px',
                      fontSize: '12px',
                    }}
                  />

                  <button
                    onClick={() => removeCondition(idx)}
                    style={{ color: 'var(--danger)', fontSize: '10.5px', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 select-none">
          <input
            type="checkbox"
            id="rule_enabled"
            checked={rule.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <label htmlFor="rule_enabled" style={{ fontSize: '12px', fontWeight: 500, cursor: 'pointer' }}>
            Enable Rule
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-default" style={{ borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-secondary py-1 px-3 text-[12px]" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary py-1 px-3 text-[12px]"
            disabled={!rule.name.trim()}
            onClick={() => onSave(rule)}
          >
            Save Rule
          </button>
        </div>
      </div>
    </div>
  );
}
