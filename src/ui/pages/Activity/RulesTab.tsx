import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Layers,
  ArrowUpDown,
  Pencil,
  Copy,
  Trash2,
} from 'lucide-react';
import type {
  ActivityDto,
  DimensionDto,
  RuleDto,
  RuleEditorState,
} from './activityTypes';
import {
  classifySummary,
  conditionSummary,
  CURATED_COLORS,
  getDomain,
} from './activityUtils';
import { RuleEditor } from './RuleEditor';
import { LearnedPatternsPanel } from './LearnedPatternsPanel';

const SOURCE_LABELS: Record<NonNullable<RuleDto['source']>, string> = {
  user: 'User',
  learned: 'Learned',
  system: 'System',
};

function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `Seen 18 times · Based on 3 corrections · Learned Sep 28`. */
function learnedDetails(rule: RuleDto): string {
  const l = rule.learned;
  if (!l) return 'Learned from a pattern you confirmed.';
  const parts = [
    `Seen ${l.matchCount === 1 ? 'once' : `${l.matchCount} times`}`,
    `Based on ${l.correctionCount === 1 ? '1 correction' : `${l.correctionCount} corrections`}`,
  ];
  const learnedOn = fmtDay(l.confirmedAt);
  if (learnedOn) parts.push(`Learned ${learnedOn}`);
  const lastSeen = fmtDay(l.lastSeenAt);
  if (lastSeen) parts.push(`Last seen ${lastSeen}`);
  if (l.userModifiedAt) parts.push('Edited by you');
  return parts.join(' · ');
}

interface RulesTabProps {
  activities: ActivityDto[];
  rules: RuleDto[];
  dimensions: {
    areas: DimensionDto[];
    intents: DimensionDto[];
    qualities: DimensionDto[];
  };
  onRefresh: () => Promise<void>;
  editingRuleId?: string | null;
  prefilledRule?: any | null;
  onEditorClosed?: () => void;
}

export function RulesTab({
  activities,
  rules,
  dimensions,
  onRefresh,
  editingRuleId,
  prefilledRule,
  onEditorClosed,
}: RulesTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortAsc, setSortAsc] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTitle, setEditorTitle] = useState<string | undefined>(
    undefined,
  );
  const [editRule, setEditRule] = useState<RuleEditorState | null>(null);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  useEffect(() => {
    if (!editingRuleId || activities.length === 0) return;

    const rule = rules.find((r) => r.id === editingRuleId);

    if (rule) {
      startEditRule(rule);
    }
  }, [editingRuleId, rules, activities.length]);

  useEffect(() => {
    if (!prefilledRule || activities.length === 0) return;

    const isWeb =
      !!prefilledRule.primaryUrl ||
      (prefilledRule.browserTabs &&
        prefilledRule.browserTabs.length > 0);

    const appVal = prefilledRule.primaryApp ?? 'App';

    const condVal = isWeb
      ? getDomain(
          prefilledRule.primaryUrl ??
            prefilledRule.browserTabs?.[0] ??
            '',
        )
      : appVal;

    const prefilledCond = {
      type: isWeb ? 'domain_equals' : 'app_equals',
      value: condVal || 'VS Code',
    };

    const tempActId = `act_${Date.now()}`;
    const tempRuleId = `rule_${Date.now()}`;

    openEditor(
      {
        id: tempRuleId,
        activityId: tempActId,
        name: prefilledRule.activity?.name ?? appVal,
        color: prefilledRule.activity?.color ?? 'blue',
        conditions: [prefilledCond],
        enabled: true,
        areaId: null,
        intentId: null,
        qualityId: null,
        priority: 0,
      },
      'Create Tracking Rule',
    );

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefilledRule, activities.length]);

  const filteredRules = useMemo(() => {
    let list = [...rules];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();

      list = list.filter((r) => {
        const act = activities.find((a) => a.id === r.activityId);

        return (
          (act?.name ?? '').toLowerCase().includes(q) ||
          r.conditions.toLowerCase().includes(q)
        );
      });
    }

    list.sort((a, b) => {
      const actA =
        activities.find((act) => act.id === a.activityId)?.name ?? '';

      const actB =
        activities.find((act) => act.id === b.activityId)?.name ?? '';

      return sortAsc
        ? actA.localeCompare(actB)
        : actB.localeCompare(actA);
    });

    return list;
  }, [rules, activities, searchQuery, sortAsc]);

  const openEditor = (
    state: RuleEditorState,
    title?: string,
  ) => {
    setEditRule(state);
    setEditorTitle(title);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditRule(null);
    setEditorTitle(undefined);
    onEditorClosed?.();
  };

  const handleSaveRule = async (rule: RuleEditorState) => {
    await window.timeline.saveActivity({
      id: rule.activityId,
      name: rule.name.trim(),
      color: rule.color,
    });

    await window.timeline.saveRule({
      id: rule.id,
      activityId: rule.activityId,
      conditions: JSON.stringify(rule.conditions),
      enabled: rule.enabled ? 1 : 0,
      priority: rule.priority,
      areaId: rule.areaId,
      intentId: rule.intentId,
      qualityId: rule.qualityId,
    });

    closeEditor();
    await onRefresh();
  };

  const handleToggleRule = async (rule: RuleDto) => {
    await window.timeline.saveRule({
      ...rule,
      enabled: rule.enabled === 1 ? 0 : 1,
    });

    await onRefresh();
  };

  const handleDuplicateRule = async (rule: RuleDto) => {
    const act = activities.find(
      (a) => a.id === rule.activityId,
    );

    const newActId = `act_${Date.now()}`;
    const newRuleId = `rule_${Date.now()}`;

    await window.timeline.saveActivity({
      id: newActId,
      name: (act?.name ?? 'Cloned') + ' Copy',
      color: act?.color ?? 'blue',
    });

    await window.timeline.saveRule({
      id: newRuleId,
      activityId: newActId,
      conditions: rule.conditions,
      enabled: rule.enabled,
      priority: rule.priority,
      areaId: rule.areaId,
      intentId: rule.intentId,
      qualityId: rule.qualityId,
    });

    await onRefresh();
  };

  const handleDeleteRule = async (rule: RuleDto) => {
    await window.timeline.deleteRule({
      id: rule.id,
    });

    // A Context can be shared (learned and remembered rules point at existing
    // ones); only remove it when this was the last rule using it.
    const contextShared = rules.some(
      (r) => r.id !== rule.id && r.activityId === rule.activityId,
    );

    if (rule.activityId && rule.source !== 'learned' && !contextShared) {
      await window.timeline.deleteActivity({
        id: rule.activityId,
      });
    }

    await onRefresh();
  };

  const startCreateRule = () => {
    const newActId = `act_${Date.now()}`;
    const newRuleId = `rule_${Date.now()}`;

    openEditor(
      {
        id: newRuleId,
        activityId: newActId,
        name: '',
        color: 'blue',
        conditions: [
          {
            type: 'app_equals',
            value: '',
          },
        ],
        enabled: true,
        areaId: null,
        intentId: null,
        qualityId: null,
        priority: 0,
      },
      'Create Tracking Rule',
    );
  };

  const startEditRule = (rule: RuleDto) => {
    const act = activities.find(
      (a) => a.id === rule.activityId,
    );

    let conds: {
      type: string;
      value: string;
    }[] = [];

    try {
      conds = JSON.parse(rule.conditions);
    } catch {
      // Ignore invalid conditions.
    }

    openEditor(
      {
        id: rule.id,
        // A rule without a Context gets a fresh one when it is edited.
        activityId: rule.activityId || `act_${Date.now()}`,
        name: act?.name ?? '',
        color: act?.color ?? 'blue',
        conditions: conds,
        enabled: rule.enabled === 1,
        areaId: rule.areaId,
        intentId: rule.intentId,
        qualityId: rule.qualityId,
        priority: rule.priority,
      },
      'Edit Tracking Rule',
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 mb-4">
        <div className="relative w-60">
          <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
            <Search size={13} />
          </span>

          <input
            type="text"
            placeholder="Search rules..."
            value={searchQuery}
            onChange={(e) =>
              setSearchQuery(e.target.value)
            }
            className="w-full pr-3 py-1 bg-default border border-default rounded-md text-[12.5px] text-default placeholder-muted focus:outline-none focus:border-accent"
            style={{ paddingLeft: '28px' }}
          />
        </div>

        <button
          className="btn btn-primary py-1 px-3 text-[12px] font-bold"
          onClick={startCreateRule}
        >
          + Create Rule
        </button>
      </div>

      <LearnedPatternsPanel onRulesChanged={onRefresh} />

      <div className="card flex-1 min-h-0 overflow-hidden flex flex-col rounded-xl border border-default">
        <div className="card-section border-b border-default bg-secondary py-2 px-4">
          <div className="text-[12px] text-muted">
            Showing {filteredRules.length} rule(s) configured.
          </div>
        </div>

        <div className="flex-1 overflow-auto relative">
          <table
            className="w-full text-[12.5px]"
            style={{ borderCollapse: 'collapse' }}
          >
            <thead>
              <tr className="bg-secondary border-b border-default sticky top-0 z-10 text-muted font-bold select-none">
                <th
                  className="text-left px-4 py-2 cursor-pointer hover:text-default"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                  onClick={() => setSortAsc(!sortAsc)}
                >
                  <div className="flex items-center gap-1">
                    Context
                    <ArrowUpDown
                      size={12}
                      className="opacity-60"
                    />
                  </div>
                </th>

                <th
                  className="text-left px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  When
                </th>

                <th
                  className="text-left px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Classify As
                </th>

                <th
                  className="text-left px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Source
                </th>

                <th
                  className="text-left px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Color
                </th>

                <th
                  className="text-left px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Status
                </th>

                <th
                  className="text-right px-4 py-2"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {filteredRules.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-16 text-center text-muted"
                  >
                    <div className="flex flex-col items-center justify-center gap-1">
                      <Layers
                        size={32}
                        className="text-faint mb-1"
                      />

                      <span className="font-semibold text-default">
                        No tracking rules found
                      </span>

                      <span className="text-[12px] text-faint">
                        Create a rule or adjust your search filter.
                      </span>
                    </div>
                  </td>
                </tr>
              )}

              {filteredRules.map((rule) => {
                const act = activities.find(
                  (a) => a.id === rule.activityId,
                );

                const colorObj =
                  CURATED_COLORS.find(
                    (c) => c.name === act?.color,
                  ) ?? CURATED_COLORS[0];

                const source = rule.source ?? 'user';
                const isLearned = source === 'learned';
                const expanded = expandedRuleId === rule.id;

                return (
                  <Fragment key={rule.id}>
                  <tr
                    className="border-b border-default hover:bg-hover transition-colors"
                  >
                    <td className="px-4 py-2 font-bold text-default">
                      {act?.name ?? (rule.activityId || '—')}
                    </td>

                    <td className="px-4 py-2 text-muted font-semibold break-all">
                      {conditionSummary(rule.conditions)}
                    </td>

                    <td className="px-4 py-2 text-muted text-[11.5px]">
                      {classifySummary(rule, dimensions)}
                    </td>

                    <td className="px-4 py-2">
                      <button
                        type="button"
                        disabled={!isLearned}
                        onClick={() =>
                          setExpandedRuleId(expanded ? null : rule.id)
                        }
                        title={
                          isLearned
                            ? 'Show how this rule was learned'
                            : undefined
                        }
                        className="text-[10.5px] font-bold rounded-full px-2 py-0.5"
                        style={{
                          border: '1px solid var(--border)',
                          background: isLearned
                            ? 'var(--accent-soft)'
                            : 'transparent',
                          color: isLearned
                            ? 'var(--accent)'
                            : 'var(--text-muted)',
                          cursor: isLearned ? 'pointer' : 'default',
                        }}
                      >
                        {SOURCE_LABELS[source]}
                      </button>
                    </td>

                    <td className="px-4 py-2">
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: colorObj.hex,
                        }}
                        title={act?.color}
                      />
                    </td>

                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={rule.enabled === 1}
                        onChange={() =>
                          handleToggleRule(rule)
                        }
                        style={{
                          accentColor: 'var(--accent)',
                          cursor: 'pointer',
                        }}
                      />
                    </td>

                    {/* Updated Actions */}
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            startEditRule(rule)
                          }
                          title="Edit rule"
                          aria-label="Edit rule"
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-hover"
                          style={{
                            color: 'var(--accent)',
                            cursor: 'pointer',
                          }}
                        >
                          <Pencil size={14} strokeWidth={2} />
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            handleDuplicateRule(rule)
                          }
                          title="Duplicate rule"
                          aria-label="Duplicate rule"
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-hover"
                          style={{
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                        >
                          <Copy size={14} strokeWidth={2} />
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            handleDeleteRule(rule)
                          }
                          title="Delete rule"
                          aria-label="Delete rule"
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-hover"
                          style={{
                            color: 'var(--danger)',
                            cursor: 'pointer',
                          }}
                        >
                          <Trash2
                            size={14}
                            strokeWidth={2}
                          />
                        </button>
                      </div>
                    </td>
                  </tr>

                  {isLearned && expanded && (
                    <tr className="border-b border-default bg-secondary">
                      <td
                        colSpan={7}
                        className="px-4 py-2 text-[11.5px] text-muted"
                      >
                        {learnedDetails(rule)}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <RuleEditor
        open={editorOpen}
        title={editorTitle}
        initialRule={
          editRule ?? {
            id: '',
            activityId: '',
            name: '',
            color: 'blue',
            conditions: [],
            enabled: true,
            areaId: null,
            intentId: null,
            qualityId: null,
            priority: 0,
          }
        }
        dimensions={dimensions}
        onSave={handleSaveRule}
        onCancel={closeEditor}
      />
    </div>
  );
}