import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { NewBlock, UseFocusResult } from './useFocus';
import { blockingCounts, blockingEditorModel } from './focusView';

export interface BlockingEditorViewProps {
  profile: FocusProfileDto;
  rules: FocusRuleDto[];
  options: FocusBlockingOptionsDto | null;
  siteDraft: string;
  allowDraft: string;
  /** Why the last add was refused, shown next to the field it came from. */
  problem: { field: 'site' | 'allow' | 'app'; message: string } | null;
  busy: boolean;
  onSiteDraftChange: (value: string) => void;
  onAllowDraftChange: (value: string) => void;
  /** Add (or reuse) a block and switch it on for this preset. */
  onAdd: (block: Omit<NewBlock, 'profileId'>, field: 'site' | 'allow' | 'app') => void;
  /** Switch an existing block on or off for this preset. */
  onToggle: (rule: FocusRuleDto, on: boolean) => void;
  /** Remove a block everywhere. */
  onRemove: (rule: FocusRuleDto) => void;
}

/**
 * "What does this preset block?" — categories, websites and apps as one-click
 * toggles. Adding something switches it on for the preset straight away;
 * there is no separate attach step and nothing to save.
 */
export function BlockingEditorView(props: BlockingEditorViewProps) {
  const { profile, rules, options, siteDraft, allowDraft, problem, busy } = props;
  const model = blockingEditorModel(profile, rules, options);

  const row = ({ rule, on }: { rule: FocusRuleDto; on: boolean }) => (
    <div key={rule.id} className="focus-block-row">
      <label>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => props.onToggle(rule, e.target.checked)} />
        <span className="focus-truncate" title={rule.label}>{rule.label}</span>
      </label>
      <button type="button" className="focus-icon-btn" data-tone="danger" aria-label={`Remove ${rule.label}`} title="Remove" disabled={busy} onClick={() => props.onRemove(rule)}>
        <X size={14} />
      </button>
    </div>
  );

  return (
    <div className="focus-blocking">
      <div className="focus-blocking-summary">
        <span className="focus-dot" data-tone={profile.blocking.enabled ? 'ok' : undefined} />
        {blockingCounts(profile)}
      </div>

      {model.categories.length > 0 && (
        <section>
          <div className="focus-label">Categories</div>
          <div className="focus-chips">
            {model.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className="focus-chip"
                aria-pressed={c.on}
                disabled={busy}
                onClick={() => {
                  const rule = c.on ? rules.find((r) => r.id === c.ruleId) : undefined;
                  if (rule) props.onToggle(rule, false);
                  else props.onAdd({ type: 'category', target: c.id, action: 'block' }, 'site');
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="focus-label">Websites</div>
        {model.websites.map(row)}
        <form
          className="focus-add-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (siteDraft.trim() && !busy) props.onAdd({ type: 'website', target: siteDraft, action: 'block' }, 'site');
          }}
        >
          <input
            className="focus-input"
            data-size="sm"
            value={siteDraft}
            maxLength={200}
            placeholder="youtube.com"
            aria-label="Website to block"
            onChange={(e) => props.onSiteDraftChange(e.target.value)}
          />
          <button type="submit" className="focus-btn" data-fit="content" data-size="sm" disabled={!siteDraft.trim() || busy}>
            <Plus size={14} /> Block
          </button>
        </form>
        {problem?.field === 'site' && <div className="focus-field-problem" role="alert">{problem.message}</div>}
        {model.suggestedSites.length > 0 && (
          <div className="focus-suggest">
            <span className="focus-hint">Recently visited</span>
            {model.suggestedSites.map((site) => (
              <button key={site} type="button" className="focus-chip" data-quiet="true" disabled={busy} title={`Block ${site}`} onClick={() => props.onAdd({ type: 'website', target: site, action: 'block' }, 'site')}>
                + {site}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="focus-label">Apps</div>
        {model.apps.map(row)}
        {model.apps.length === 0 && model.suggestedApps.length === 0 && (
          <div className="focus-hint">Open the app you want to block and it will be offered here.</div>
        )}
        {model.suggestedApps.length > 0 && (
          <div className="focus-suggest">
            <span className="focus-hint">Open now</span>
            {model.suggestedApps.map((app) => (
              <button key={app.process} type="button" className="focus-chip" data-quiet="true" disabled={busy} title={`Block ${app.name}`} onClick={() => props.onAdd({ type: 'app', target: app.process, action: 'block' }, 'app')}>
                + {app.name}
              </button>
            ))}
          </div>
        )}
        {problem?.field === 'app' && <div className="focus-field-problem" role="alert">{problem.message}</div>}
      </section>

      <section>
        <div className="focus-label">Always allowed</div>
        {model.allowed.map(row)}
        <form
          className="focus-add-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (allowDraft.trim() && !busy) props.onAdd({ type: 'website', target: allowDraft, action: 'allow' }, 'allow');
          }}
        >
          <input
            className="focus-input"
            data-size="sm"
            value={allowDraft}
            maxLength={200}
            placeholder="github.com"
            aria-label="Website to allow"
            onChange={(e) => props.onAllowDraftChange(e.target.value)}
          />
          <button type="submit" className="focus-btn" data-fit="content" data-size="sm" disabled={!allowDraft.trim() || busy}>
            <Plus size={14} /> Allow
          </button>
        </form>
        {problem?.field === 'allow' && <div className="focus-field-problem" role="alert">{problem.message}</div>}
        <div className="focus-hint">Allowed sites stay open even when a category would block them.</div>
      </section>
    </div>
  );
}

/** Wires the editor to the service for one preset. */
export function BlockingEditor({ focus, profile }: { focus: UseFocusResult; profile: FocusProfileDto }) {
  const { rules, blockingOptions, loadBlockingOptions, addBlock, setProfileBlock, deleteRule } = focus;
  const [siteDraft, setSiteDraft] = useState('');
  const [allowDraft, setAllowDraft] = useState('');
  const [problem, setProblem] = useState<BlockingEditorViewProps['problem']>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadBlockingOptions();
  }, [loadBlockingOptions]);

  const guarded = async (op: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await op();
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockingEditorView
      profile={profile}
      rules={rules}
      options={blockingOptions}
      siteDraft={siteDraft}
      allowDraft={allowDraft}
      problem={problem}
      busy={busy}
      onSiteDraftChange={(v) => {
        setSiteDraft(v);
        setProblem(null);
      }}
      onAllowDraftChange={(v) => {
        setAllowDraft(v);
        setProblem(null);
      }}
      onAdd={(block, field) =>
        void guarded(async () => {
          const message = await addBlock({ ...block, profileId: profile.id });
          if (message) {
            setProblem({ field, message });
            return;
          }
          setProblem(null);
          if (block.type === 'website') (block.action === 'allow' ? setAllowDraft : setSiteDraft)('');
        })
      }
      onToggle={(rule, on) =>
        void guarded(async () => {
          // Switching on goes through addBlock so a disabled block is re-enabled too.
          if (on) await addBlock({ profileId: profile.id, type: rule.type, target: rule.target, action: rule.action });
          else await setProfileBlock(profile.id, rule.id, false);
        })
      }
      onRemove={(rule) => void guarded(() => deleteRule(rule.id).catch(() => {}))}
    />
  );
}
