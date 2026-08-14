import { useCallback, useEffect, useState } from 'react';
import type { ActivityDto, DimensionDto, RuleDto, TrackerEventDto } from './activityTypes';
import { EventsTab } from './EventsTab';
import { RulesTab } from './RulesTab';
import { UsageTab } from './UsageTab';

interface ActivityPageProps {
  activeTab?: 'events' | 'usage' | 'rules';
  onTabChange?: (tab: 'events' | 'usage' | 'rules') => void;
  editingRuleId?: string | null;
  setEditingRuleId?: (id: string | null) => void;
  prefilledRule?: any | null;
  setPrefilledRule?: (rule: any | null) => void;
}

export function ActivityPage({
  activeTab = 'events',
  onTabChange,
  editingRuleId,
  setEditingRuleId,
  prefilledRule,
  setPrefilledRule,
}: ActivityPageProps) {
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [rules, setRules] = useState<RuleDto[]>([]);
  const [dimensions, setDimensions] = useState<{ areas: DimensionDto[]; intents: DimensionDto[]; qualities: DimensionDto[] }>({
    areas: [],
    intents: [],
    qualities: [],
  });
  const [events, setEvents] = useState<TrackerEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const rows = await window.tracker.getToday();
      setEvents(rows);
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to load events');
    }
  }, []);

  const refreshActivitiesAndRules = useCallback(async () => {
    try {
      const [actList, ruleList] = await Promise.all([window.timeline.listActivities(), window.timeline.listRules()]);
      setActivities(actList);
      setRules(ruleList);
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to load rules/activities');
      console.error('Failed to load rules/activities', e);
    }
  }, []);

  const refreshDimensions = useCallback(async () => {
    try {
      const dims = await window.categorization.getDimensions();
      setDimensions(dims);
    } catch (e) {
      console.error('Failed to load dimensions', e);
    }
  }, []);

  useEffect(() => {
    refreshDimensions();
    refreshActivitiesAndRules();
    loadEvents();
    const t = setInterval(loadEvents, 3000);
    return () => clearInterval(t);
  }, [refreshDimensions, refreshActivitiesAndRules, loadEvents]);

  useEffect(() => {
    localStorage.setItem('reflect_activity_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'rules') {
      refreshActivitiesAndRules();
    }
  }, [activeTab, refreshActivitiesAndRules]);

  const handleEditorClosed = () => {
    setEditingRuleId?.(null);
    setPrefilledRule?.(null);
  };

  return (
    <div className="flex flex-col h-full space-y-4">
      <section className="card p-3 flex justify-between items-center border border-default bg-secondary rounded-xl">
        <div className="flex items-center gap-4">
          <h1 className="text-[20px] font-extrabold tracking-tight">Activity</h1>

          <div className="flex bg-default p-0.5 rounded-lg border border-default shrink-0">
            {(['events', 'usage', 'rules'] as const).map((tab) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => onTabChange?.(tab)}
                  className="px-3 py-1 rounded-md text-[12px] font-bold transition-colors capitalize"
                  style={{
                    background: isActive ? 'var(--bg-secondary)' : 'transparent',
                    color: isActive ? 'var(--text)' : 'var(--text-muted)',
                    boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
                  }}
                >
                  {tab}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {error && (
        <section className="card border-danger">
          <div className="card-section text-[13px] text-danger">Failed to load data: {error}</div>
        </section>
      )}

      {activeTab === 'events' && (
        <EventsTab
          events={events}
          activities={activities}
          dimensions={dimensions}
          onActivitiesChange={refreshActivitiesAndRules}
          onRulesChange={refreshActivitiesAndRules}
        />
      )}

      {activeTab === 'usage' && <UsageTab events={events} />}

      {activeTab === 'rules' && (
        <RulesTab
          activities={activities}
          rules={rules}
          dimensions={dimensions}
          onRefresh={refreshActivitiesAndRules}
          editingRuleId={editingRuleId}
          prefilledRule={prefilledRule}
          onEditorClosed={handleEditorClosed}
        />
      )}
    </div>
  );
}
