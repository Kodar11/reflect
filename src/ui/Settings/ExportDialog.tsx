import { useEffect, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Braces, Check, FolderOpen, Loader2, Table2, X } from 'lucide-react';
import {
  EXPORT_CATEGORIES,
  EXPORT_CATEGORY_INFO,
  EXPORT_PRESETS,
  EXPORT_PRESET_LABELS,
  type ExportCategory,
  type ExportFormat,
  type ExportPreview,
  type ExportRunResult,
} from '../../export/ExportModels';
import { useDialog } from '../Focus/useDialog';
import {
  clearCategories,
  describePackaging,
  describeRange,
  draftProblem,
  estimateFor,
  formatBytes,
  formatNote,
  selectAllCategories,
  toExportRequest,
  toggleCategory,
  undatedNote,
  type ExportDraft,
} from './exportView';

export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'saved'; result: Extract<ExportRunResult, { status: 'saved' }> }
  | { kind: 'error'; message: string };

export interface ExportDialogViewProps {
  draft: ExportDraft;
  /** Null while the counts for the current choices are loading. */
  preview: ExportPreview | null;
  problem: string | null;
  phase: ExportPhase;
  onChange: (draft: ExportDraft) => void;
  onExport: () => void;
  onReveal: () => void;
  onClose: () => void;
  dialogRef?: RefObject<HTMLDivElement>;
}

const FORMATS: { id: ExportFormat; label: string; detail: string; Icon: typeof Braces }[] = [
  { id: 'json', label: 'JSON', detail: 'Complete — keeps every detail', Icon: Braces },
  { id: 'csv', label: 'CSV', detail: 'Tables for spreadsheets', Icon: Table2 },
];

/**
 * The export on one screen: what to include on the left, when and how on the
 * right, a live summary under them and the action always in view. Every
 * choice stays editable; a failed or cancelled export keeps them.
 */
export function ExportDialogView({ draft, preview, problem, phase, onChange, onExport, onReveal, onClose, dialogRef }: ExportDialogViewProps) {
  const running = phase.kind === 'running';
  const saved = phase.kind === 'saved' ? phase.result : null;
  const error = problem ?? (phase.kind === 'error' ? phase.message : null);
  const canExport = !running && problem === null && preview !== null && preview.ok;
  const estimates = preview?.ok ? preview.estimates : undefined;
  const notes = [formatNote(draft), undatedNote(draft.categories)].filter((n): n is string => !!n);
  const allSelected = draft.categories.length === EXPORT_CATEGORIES.length;

  return (
    <div
      className="focus-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div ref={dialogRef} className="xp" role="dialog" aria-modal="true" aria-labelledby="export-title" aria-busy={running}>
        <header className="xp-head">
          <div className="min-w-0">
            <h2 id="export-title" className="xp-title">Export your data</h2>
            <p className="xp-sub">A copy of your data, saved as a file wherever you choose. Nothing leaves this computer.</p>
          </div>
          <button type="button" className="xp-icon-btn" aria-label="Close" onClick={onClose} disabled={running}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="xp-body">
          {/* ── Left: what ─────────────────────────────────────────── */}
          <fieldset className="xp-panel" disabled={running}>
            <legend className="sr-only">What to export</legend>
            <div className="xp-panel-head">
              <span className="xp-step" aria-hidden>
                <span className="xp-step-n">1</span> What to export
              </span>
              <button type="button" className="xp-link" onClick={() => onChange(allSelected ? clearCategories(draft) : selectAllCategories(draft))}>
                {allSelected ? 'Clear' : 'Select all'}
              </button>
            </div>
            <div className="xp-cats">
              {EXPORT_CATEGORIES.map((category) => (
                <CategoryOption
                  key={category}
                  category={category}
                  checked={draft.categories.includes(category)}
                  count={estimateFor(estimates, category)}
                  csvChosen={draft.format === 'csv'}
                  onToggle={() => onChange(toggleCategory(draft, category))}
                />
              ))}
            </div>
          </fieldset>

          {/* ── Right: when, how, summary ──────────────────────────── */}
          <div className="xp-side">
            <fieldset className="xp-panel" disabled={running}>
              <legend className="sr-only">Date range</legend>
              <span className="xp-step" aria-hidden>
                <span className="xp-step-n">2</span> Date range
              </span>
              <div className="xp-chips" role="radiogroup" aria-label="Date range">
                {EXPORT_PRESETS.map((preset) => (
                  <label key={preset} className="xp-chip" data-checked={draft.preset === preset}>
                    <input type="radio" className="sr-only" name="export-range" checked={draft.preset === preset} onChange={() => onChange({ ...draft, preset })} />
                    {EXPORT_PRESET_LABELS[preset]}
                  </label>
                ))}
              </div>
              {draft.preset === 'custom' && (
                <div className="xp-dates">
                  <label>
                    <span>From</span>
                    <input type="date" className="field" value={draft.customFrom} max={draft.customTo || undefined} onChange={(e) => onChange({ ...draft, customFrom: e.currentTarget.value })} />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="date" className="field" value={draft.customTo} min={draft.customFrom || undefined} onChange={(e) => onChange({ ...draft, customTo: e.currentTarget.value })} />
                  </label>
                </div>
              )}
              <p className="xp-hint">
                Local days, midnight to midnight.{' '}
                {draft.preset === 'all' ? 'Your complete history — not just what is on screen.' : 'Both end days included.'}
              </p>
            </fieldset>

            <fieldset className="xp-panel" disabled={running}>
              <legend className="sr-only">Format</legend>
              <span className="xp-step" aria-hidden>
                <span className="xp-step-n">3</span> Format
              </span>
              <div className="xp-formats" role="radiogroup" aria-label="Format">
                {FORMATS.map(({ id, label, detail, Icon }) => (
                  <label key={id} className="xp-format" data-checked={draft.format === id}>
                    <input type="radio" className="sr-only" name="export-format" checked={draft.format === id} onChange={() => onChange({ ...draft, format: id })} />
                    <Icon size={16} strokeWidth={1.75} aria-hidden />
                    <span className="min-w-0">
                      <span className="xp-format-label">{label}</span>
                      <span className="xp-format-detail">{detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <section className="xp-summary" aria-labelledby="export-summary-title" aria-live="polite">
              <h3 id="export-summary-title" className="xp-step">
                <span className="xp-step-n">4</span> Summary
              </h3>
              {saved ? (
                <div className="xp-saved" role="status">
                  <span className="xp-saved-icon" aria-hidden>
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                  <div className="min-w-0">
                    <div className="xp-saved-name">Saved {saved.fileName}</div>
                    <div className="xp-saved-meta" title={saved.folder}>
                      {saved.folder} · {formatBytes(saved.bytes)}
                      {saved.files.length > 1 ? ` · ${saved.files.length} files inside` : ''}
                    </div>
                  </div>
                </div>
              ) : (
                <dl className="xp-facts">
                  <dt>Range</dt>
                  <dd>{preview?.ok ? describeRange(preview.range) : EXPORT_PRESET_LABELS[draft.preset]}</dd>
                  <dt>Output</dt>
                  <dd>
                    {draft.format.toUpperCase()} · {describePackaging(draft)}
                  </dd>
                  <dt>File</dt>
                  <dd className="xp-mono">{preview?.ok ? preview.fileName : '—'}</dd>
                </dl>
              )}
              {!saved && notes.length > 0 && (
                <ul className="xp-notes">
                  {notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        <footer className="xp-foot">
          <div className="xp-status" role={error ? 'alert' : 'status'} data-tone={error ? 'error' : undefined}>
            {error ? (
              <>
                <AlertTriangle size={14} strokeWidth={2} aria-hidden /> <span>{error}</span>
              </>
            ) : running ? (
              <>
                <Loader2 size={14} strokeWidth={2} className="xp-spin" aria-hidden /> <span>Exporting… large exports can take a minute. You can keep using Reflect.</span>
              </>
            ) : saved ? (
              <span>Your selections are kept if you want to export again.</span>
            ) : preview?.ok && preview.empty ? (
              <span>Nothing was recorded in this range — the export will contain empty files.</span>
            ) : !preview && !problem ? (
              <span>Counting…</span>
            ) : (
              <span>You will choose where to save it.</span>
            )}
          </div>
          <div className="xp-actions">
            {saved ? (
              <>
                <button type="button" className="btn bg-control" onClick={onReveal}>
                  <FolderOpen size={15} strokeWidth={1.75} aria-hidden /> Show in folder
                </button>
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={onClose} disabled={running}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={onExport} disabled={!canExport}>
                  {running ? 'Exporting…' : 'Export…'}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function CategoryOption(props: { category: ExportCategory; checked: boolean; count: string | null; csvChosen: boolean; onToggle: () => void }) {
  const info = EXPORT_CATEGORY_INFO[props.category];
  const id = `export-category-${props.category}`;
  return (
    <label className="xp-cat" data-checked={props.checked} htmlFor={id}>
      <input id={id} type="checkbox" className="xp-check" checked={props.checked} onChange={props.onToggle} />
      <span className="xp-cat-main">
        <span className="xp-cat-title">
          {info.label}
          {!info.csv && (
            <span className="xp-tag" data-active={props.csvChosen && props.checked}>
              JSON only
            </span>
          )}
          {props.checked && props.count && <span className="xp-count">{props.count}</span>}
        </span>
        <span className="xp-cat-detail">{info.description}</span>
        {props.checked && info.warning && (
          <span className="xp-cat-warning">
            <AlertTriangle size={12} strokeWidth={2} aria-hidden /> {info.warning}
          </span>
        )}
      </span>
    </label>
  );
}

/** The dialog with its state: the draft, a live preview and the run. */
export function ExportDialog({ initialDraft, onClose, onDraftChange }: { initialDraft: ExportDraft; onClose: () => void; onDraftChange?: (draft: ExportDraft) => void }) {
  const [draft, setDraft] = useState(initialDraft);
  // Kept with the request it answers, so counts for older choices are never shown.
  const [counted, setCounted] = useState<{ key: string; preview: ExportPreview } | null>(null);
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'idle' });
  const dialogRef = useRef<HTMLDivElement>(null);
  const running = phase.kind === 'running';
  useDialog(dialogRef, () => {
    if (!running) onClose();
  });

  const problem = draftProblem(draft, new Date());
  const requestKey = JSON.stringify(toExportRequest(draft));

  // Counts follow the choices, a moment after the last change.
  useEffect(() => {
    if (problem) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.dataExport
        .preview(toExportRequest(draft))
        .then((p) => {
          if (!cancelled) setCounted({ key: requestKey, preview: p });
        })
        .catch(() => {
          if (!cancelled) setCounted({ key: requestKey, preview: { ok: false, error: 'Reflect could not count the data for this export.' } });
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestKey, problem]);

  const change = (next: ExportDraft) => {
    setDraft(next);
    onDraftChange?.(next);
    if (phase.kind !== 'running') setPhase({ kind: 'idle' });
  };

  const run = async () => {
    setPhase({ kind: 'running' });
    try {
      const result = await window.dataExport.run(toExportRequest(draft));
      if (result.status === 'saved') setPhase({ kind: 'saved', result });
      else if (result.status === 'cancelled') setPhase({ kind: 'idle' });
      else setPhase({ kind: 'error', message: result.message });
    } catch {
      setPhase({ kind: 'error', message: 'The export could not be completed. Nothing was saved.' });
    }
  };

  const preview = !problem && counted?.key === requestKey ? counted.preview : null;
  const shownProblem = problem ?? (preview && !preview.ok ? preview.error : null);

  return (
    <ExportDialogView
      draft={draft}
      preview={preview}
      problem={shownProblem}
      phase={phase}
      onChange={change}
      onExport={() => void run()}
      onReveal={() => void window.dataExport.revealLast()}
      onClose={onClose}
      dialogRef={dialogRef}
    />
  );
}
