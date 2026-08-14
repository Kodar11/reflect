import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Pencil,
  Search,
  Tag,
  X,
  Clock3,
  Globe,
  Monitor,
} from 'lucide-react';

import type {
  ActivityDto,
  DimensionDto,
  EventClassificationEdit,
  TrackerEventDto,
} from './activityTypes';

import { AppIcon, WebsiteFavicon } from './ActivityIcons';
import { EventClassificationEditor } from './EventClassificationEditor';

import {
  CURATED_COLORS,
  deterministicColorForName,
  fmtTime,
  getDomain,
  humanDuration,
} from './activityUtils';

interface EventsTabProps {
  events: TrackerEventDto[];
  activities: ActivityDto[];
  dimensions: {
    areas: DimensionDto[];
    intents: DimensionDto[];
    qualities: DimensionDto[];
  };
  onActivitiesChange?: () => Promise<void>;
  onRulesChange?: () => Promise<void>;
}

interface LocalClassification {
  eventId: number;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
}

const EMPTY_CLASSIFICATION: EventClassificationEdit = {
  contextId: null,
  areaId: null,
  intentId: null,
  qualityId: null,
};

export function EventsTab({
  events,
  activities,
  dimensions,
  onActivitiesChange,
  onRulesChange,
}: EventsTabProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const [classificationMap, setClassificationMap] = useState<
    Map<number, LocalClassification>
  >(new Map());

  const [editingEventId, setEditingEventId] =
    useState<number | null>(null);

  const [editorPos, setEditorPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const [savingEventId, setSavingEventId] =
    useState<number | null>(null);

  const [saveError, setSaveError] =
    useState<string | null>(null);

  const [rememberingEventId, setRememberingEventId] =
    useState<number | null>(null);

  /*
   * IMPORTANT:
   *
   * This ref mirrors editingEventId without making the async
   * classification loader depend on React render timing.
   *
   * The tracker can refresh every few seconds. While an event
   * editor is open, its classification must remain owned by
   * the editor/local state.
   */
  const editingEventIdRef = useRef<number | null>(null);

  /*
   * Used to invalidate older async classification requests.
   *
   * If a newer request starts before an older one finishes,
   * the old response is ignored.
   */
  const classificationRequestRef = useRef(0);

  /*
   * Keep the ref synchronized with the actual editor state.
   */
  useEffect(() => {
    editingEventIdRef.current = editingEventId;
  }, [editingEventId]);

  const closeEditor = useCallback(() => {
    editingEventIdRef.current = null;

    setEditingEventId(null);
    setEditorPos(null);
    setSaveError(null);
  }, []);

  /*
   * Load classifications for the current event list.
   *
   * IMPORTANT BEHAVIOR:
   *
   * If an editor is currently open for event X, the server response
   * is NOT allowed to overwrite event X's local classification.
   *
   * This is what prevents the 3-second tracker refresh from resetting
   * the user's work while they are editing.
   */
  const loadClassifications = useCallback(
    async (eventList: TrackerEventDto[]) => {
      const requestId =
        ++classificationRequestRef.current;

      if (eventList.length === 0) {
        setClassificationMap((prev) => {
          /*
           * Even when there are no events, don't blindly destroy
           * the classification currently being edited.
           */
          const activeId = editingEventIdRef.current;

          if (activeId === null || !prev.has(activeId)) {
            return new Map();
          }

          const next = new Map<number, LocalClassification>();

          next.set(activeId, prev.get(activeId)!);

          return next;
        });

        return;
      }

      try {
        const result =
          await window.categorization.getEventClassifications({
            eventIds: eventList.map((e) => e.id),
          });

        /*
         * Ignore stale responses.
         *
         * Example:
         *
         * request A starts
         * request B starts
         * B finishes
         * A finishes later
         *
         * A must not overwrite B.
         */
        if (
          requestId !==
          classificationRequestRef.current
        ) {
          return;
        }

        const currentIds = new Set(
          eventList.map((e) => e.id),
        );

        const activeEditingId =
          editingEventIdRef.current;

        setClassificationMap((prev) => {
          const next =
            new Map<number, LocalClassification>();

          /*
           * Preserve existing local classifications for
           * events that still exist.
           */
          for (const [id, cls] of prev) {
            if (currentIds.has(id)) {
              next.set(id, cls);
            }
          }

          /*
           * Apply server values.
           *
           * EXCEPTION:
           *
           * Never overwrite the event currently being edited.
           */
          for (const c of result) {
            if (
              activeEditingId !== null &&
              c.eventId === activeEditingId
            ) {
              continue;
            }

            next.set(c.eventId, {
              eventId: c.eventId,
              contextId: c.contextId,
              areaId: c.areaId,
              intentId: c.intentId,
              qualityId: c.qualityId,
            });
          }

          return next;
        });
      } catch (e) {
        console.error(
          'Failed to load event classifications',
          e,
        );
      }
    },
    [],
  );

  /*
   * Only use the event IDs as the polling/reload key.
   *
   * The actual event objects can change every few seconds,
   * but that should not cause the classification editor itself
   * to reset.
   */
  const eventIdsKey = useMemo(
    () => events.map((e) => e.id).join(','),
    [events],
  );

  useEffect(() => {
    loadClassifications(events);
  }, [
    eventIdsKey,
    loadClassifications,
  ]);

  /*
   * If the event being edited disappears completely from the
   * tracker result, close the editor.
   *
   * This is a legitimate case because the event itself no longer
   * exists in the current event list.
   */
  useEffect(() => {
    if (
      editingEventId !== null &&
      !events.some(
        (e) => e.id === editingEventId,
      )
    ) {
      closeEditor();
    }
  }, [
    events,
    editingEventId,
    closeEditor,
  ]);

  const filteredEvents = useMemo(() => {
    if (!searchQuery.trim()) {
      return events;
    }

    const q = searchQuery.toLowerCase();

    return events.filter(
      (e) =>
        (e.app &&
          e.app.toLowerCase().includes(q)) ||
        (e.title &&
          e.title.toLowerCase().includes(q)) ||
        (e.url &&
          e.url.toLowerCase().includes(q)) ||
        (e.watcher &&
          e.watcher.toLowerCase().includes(q)),
    );
  }, [events, searchQuery]);

  const editingEvent = useMemo(() => {
    if (editingEventId === null) {
      return null;
    }

    return (
      events.find(
        (e) => e.id === editingEventId,
      ) ?? null
    );
  }, [events, editingEventId]);

  /*
   * Open editor.
   */
  const startEdit = (
    eventId: number,
    anchorEl: HTMLElement,
  ) => {
    const rect =
      anchorEl.getBoundingClientRect();

    const EDITOR_WIDTH = 320;
    const EDITOR_HEIGHT = 500;
    const VIEWPORT_GAP = 12;

    let left = rect.left;
    let top = rect.bottom + 4;

    if (
      left + EDITOR_WIDTH >
      window.innerWidth - VIEWPORT_GAP
    ) {
      left =
        window.innerWidth -
        EDITOR_WIDTH -
        VIEWPORT_GAP;
    }

    if (
      top + EDITOR_HEIGHT >
      window.innerHeight - VIEWPORT_GAP
    ) {
      top =
        rect.top -
        EDITOR_HEIGHT -
        4;
    }

    left = Math.max(
      VIEWPORT_GAP,
      left,
    );

    top = Math.max(
      VIEWPORT_GAP,
      top,
    );

    /*
     * Set the ref immediately.
     *
     * This is important because classification polling is
     * asynchronous and can happen before the next React render.
     */
    editingEventIdRef.current = eventId;

    setEditorPos({
      top,
      left,
    });

    setEditingEventId(eventId);
    setSaveError(null);
  };

  /*
   * Save classification.
   */
  const handleSaveClassification = async (
    eventId: number,
    edit: EventClassificationEdit,
    newContextName?: string,
  ) => {
    setSavingEventId(eventId);
    setSaveError(null);

    const previousCls =
      classificationMap.get(eventId);

    let contextId = edit.contextId;

    try {
      /*
       * Create Context if requested.
       */
      if (newContextName) {
        const newId = `act_${Date.now()}`;

        await window.timeline.saveActivity({
          id: newId,
          name: newContextName,
          color:
            deterministicColorForName(
              newContextName,
            ),
        });

        contextId = newId;

        await onActivitiesChange?.();
      }

      const next: LocalClassification = {
        eventId,
        contextId,
        areaId: edit.areaId,
        intentId: edit.intentId,
        qualityId: edit.qualityId,
      };

      /*
       * Update local state BEFORE persistence.
       *
       * This keeps the row stable and also gives the next
       * polling cycle the correct local value to preserve.
       */
      setClassificationMap(
        (prev) => {
          const nextMap = new Map(prev);

          nextMap.set(
            eventId,
            next,
          );

          return nextMap;
        },
      );

      await window.categorization.saveEventClassification(
        {
          eventId,
          contextId,
          areaId: edit.areaId,
          intentId: edit.intentId,
          qualityId: edit.qualityId,
          source: 'user_override',
          ruleId: null,
        },
      );

      /*
       * Persistence succeeded.
       *
       * Close only after the DB save has completed.
       */
      closeEditor();
    } catch (e) {
      setSaveError(
        (e as Error)?.message ??
          'Failed to save classification',
      );

      /*
       * Revert only this event.
       */
      setClassificationMap(
        (prev) => {
          const restored =
            new Map(prev);

          if (previousCls) {
            restored.set(
              eventId,
              previousCls,
            );
          } else {
            restored.delete(eventId);
          }

          return restored;
        },
      );
    } finally {
      setSavingEventId(null);
    }
  };

  /*
   * Remember current classification as a rule.
   */
  const handleRememberAsRule = async (
    event: TrackerEventDto,
  ) => {
    const cls =
      classificationMap.get(event.id);

    if (!cls?.contextId) {
      return;
    }

    setRememberingEventId(event.id);

    try {
      await window.categorization.rememberEventAsRule(
        {
          eventId: event.id,
          contextId: cls.contextId,
          areaId: cls.areaId,
          intentId: cls.intentId,
          qualityId: cls.qualityId,
          app: event.app,
          title: event.title,
          url: event.url,
        },
      );

      await onRulesChange?.();
    } catch (e) {
      console.error(
        'Failed to remember rule',
        e,
      );

      setSaveError(
        (e as Error)?.message ??
          'Failed to create rule',
      );
    } finally {
      setRememberingEventId(null);
    }
  };

  const renderDimension = (
    id: string | null,
    type:
      | 'area'
      | 'intent'
      | 'quality',
  ) => {
    if (!id) {
      return (
        <span className="text-muted">
          —
        </span>
      );
    }

    const pool =
      type === 'area'
        ? dimensions.areas
        : type === 'intent'
          ? dimensions.intents
          : dimensions.qualities;

    const dim = pool.find(
      (d) => d.id === id,
    );

    return (
      <span className="text-default">
        {dim?.name ?? id}
      </span>
    );
  };

  const renderContext = (
    id: string | null,
  ) => {
    if (!id) {
      return (
        <span className="text-muted">
          —
        </span>
      );
    }

    const act = activities.find(
      (a) => a.id === id,
    );

    const colorObj =
      CURATED_COLORS.find(
        (c) => c.name === act?.color,
      ) ??
      CURATED_COLORS[0];

    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold"
        style={{
          background:
            colorObj.hex + '22',
          color: colorObj.hex,
        }}
      >
        {act?.name ?? id}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search / top controls */}
      <div className="flex justify-between items-center mb-3">
        <div className="relative w-64">
          <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
            <Search size={13} />
          </span>

          <input
            type="text"
            placeholder="Search raw events..."
            value={searchQuery}
            onChange={(e) =>
              setSearchQuery(
                e.target.value,
              )
            }
            className="w-full pr-3 py-1 bg-default border border-default rounded-md text-[12.5px] text-default placeholder-muted focus:outline-none focus:border-accent"
            style={{
              paddingLeft: '28px',
            }}
          />
        </div>

        {saveError && (
          <span className="text-[12px] text-danger">
            {saveError}
          </span>
        )}
      </div>

      {/* Events table */}
      <div className="card flex-1 min-h-0 overflow-hidden flex flex-col rounded-xl border border-default">
        <div className="card-section border-b border-default bg-secondary py-2 px-4">
          <div className="text-[12px] text-muted">
            Showing{' '}
            {filteredEvents.length}{' '}
            event(s) today.
          </div>
        </div>

        <div className="flex-1 overflow-auto relative">
          <table
            className="text-[12.5px]"
            style={{
              width: '100%',
              minWidth: '1320px',
              tableLayout: 'fixed',
              borderCollapse:
                'separate',
              borderSpacing: 0,
            }}
          >
            <colgroup>
              <col
                style={{ width: '78px' }}
              />
              <col
                style={{ width: '72px' }}
              />
              <col
                style={{ width: '82px' }}
              />
              <col
                style={{ width: '150px' }}
              />
              <col
                style={{ width: '280px' }}
              />
              <col
                style={{ width: '180px' }}
              />
              <col
                style={{ width: '125px' }}
              />
              <col
                style={{ width: '105px' }}
              />
              <col
                style={{ width: '115px' }}
              />
              <col
                style={{ width: '105px' }}
              />
              <col
                style={{ width: '88px' }}
              />
            </colgroup>

            <thead>
              <tr className="border-b border-default text-muted font-bold">
                {[
                  'Time',
                  'Duration',
                  'Watcher',
                  'App',
                  'Title',
                  'URL',
                  'Context',
                  'Area',
                  'Intent',
                  'Quality',
                  'Actions',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2.5 whitespace-nowrap"
                    style={{
                      color:
                        'var(--text-muted)',
                      background:
                        'var(--bg-secondary)',
                      position: 'sticky',
                      top: 0,
                      zIndex: 20,
                      boxShadow:
                        '0 1px 0 var(--border-default)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {filteredEvents.length ===
                0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-16 text-center text-muted"
                  >
                    <div className="flex flex-col items-center justify-center gap-1">
                      <span className="font-semibold text-default">
                        {events.length ===
                        0
                          ? 'No events today'
                          : 'No matching events'}
                      </span>

                      {events.length >
                        0 && (
                        <span className="text-[12px] text-faint">
                          Try adjusting your
                          search terms.
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {filteredEvents.map(
                (e) => {
                  const started =
                    new Date(
                      e.startedAt,
                    );

                  const ended =
                    new Date(
                      e.endedAt,
                    );

                  const dur =
                    humanDuration(
                      ended.getTime() -
                        started.getTime(),
                    );

                  const eventDomain =
                    e.url
                      ? getDomain(e.url)
                      : null;

                  const cls =
                    classificationMap.get(
                      e.id,
                    );

                  return (
                    <tr
                      key={e.id}
                      className="border-b border-default hover:bg-hover transition-colors"
                    >
                      {/* Time */}
                      <td className="px-3 py-2 whitespace-nowrap text-muted font-mono">
                        {fmtTime(
                          started,
                        )}
                      </td>

                      {/* Duration */}
                      <td className="px-3 py-2 whitespace-nowrap text-default font-mono font-bold">
                        {dur}
                      </td>

                      {/* Watcher */}
                      <td className="px-3 py-2 whitespace-nowrap font-medium text-muted">
                        {e.watcher}
                      </td>

                      {/* App */}
                      <td className="px-3 py-2 font-semibold text-default">
                        <div className="flex items-center gap-2">
                          {eventDomain ? (
                            <WebsiteFavicon
                              domain={
                                eventDomain
                              }
                              size={14}
                            />
                          ) : (
                            <AppIcon
                              appName={
                                e.app ??
                                ''
                              }
                              size={14}
                            />
                          )}

                          <span>
                            {e.app ??
                              '—'}
                          </span>
                        </div>
                      </td>

                      {/* Title */}
                      <td className="px-3 py-2 text-default">
                        <div
                          className="truncate"
                          title={
                            e.title ??
                            ''
                          }
                        >
                          {e.title ??
                            '—'}
                        </div>
                      </td>

                      {/* URL */}
                      <td className="px-3 py-2">
                        {e.url ? (
                          <span
                            className="block text-[12px] text-accent font-mono truncate"
                            title={e.url}
                          >
                            {e.url}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>

                      {/* Context */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {renderContext(
                          cls?.contextId ??
                            null,
                        )}
                      </td>

                      {/* Area */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {renderDimension(
                          cls?.areaId ??
                            null,
                          'area',
                        )}
                      </td>

                      {/* Intent */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {renderDimension(
                          cls?.intentId ??
                            null,
                          'intent',
                        )}
                      </td>

                      {/* Quality */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {renderDimension(
                          cls?.qualityId ??
                            null,
                          'quality',
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <button
                            className="btn btn-ghost p-1"
                            title="Edit classification"
                            onClick={(
                              ev,
                            ) =>
                              startEdit(
                                e.id,
                                ev.currentTarget,
                              )
                            }
                            disabled={
                              savingEventId ===
                              e.id
                            }
                          >
                            <Pencil
                              size={13}
                            />
                          </button>

                          <button
                            className="btn btn-ghost p-1"
                            title="Remember as Rule"
                            onClick={() =>
                              handleRememberAsRule(
                                e,
                              )
                            }
                            disabled={
                              !cls?.contextId ||
                              rememberingEventId ===
                                e.id
                            }
                          >
                            <Tag
                              size={13}
                            />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Classification editor */}
      {editingEventId !== null &&
        editorPos &&
        editingEvent && (
          <div
            className="fixed max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-auto"
            style={{
              top: editorPos.top,
              left: editorPos.left,
              zIndex: 50,
              width:
                'min(340px, calc(100vw - 24px))',
            }}
            onClick={(e) =>
              e.stopPropagation()
            }
          >
            <div
              className="rounded-xl border border-default overflow-hidden shadow-2xl"
              style={{
                background:
                  'var(--bg-default)',
              }}
            >
              {/* Editor Header */}
              <div
                className="px-4 py-3 border-b border-default"
                style={{
                  background:
                    'var(--bg-secondary)',
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
                      style={{
                        background:
                          'var(--bg-default)',
                        border:
                          '1px solid var(--border-default)',
                      }}
                    >
                      {editingEvent.url ? (
                        <WebsiteFavicon
                          domain={getDomain(
                            editingEvent.url,
                          )}
                          size={17}
                        />
                      ) : (
                        <AppIcon
                          appName={
                            editingEvent.app ??
                            ''
                          }
                          size={17}
                        />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {editingEvent.url ? (
                          <Globe
                            size={11}
                            className="text-muted shrink-0"
                          />
                        ) : (
                          <Monitor
                            size={11}
                            className="text-muted shrink-0"
                          />
                        )}

                        <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">
                          {editingEvent.url
                            ? 'Website Event'
                            : 'Application Event'}
                        </span>
                      </div>

                      <div
                        className="text-[13px] font-bold text-default truncate mt-0.5"
                        title={
                          editingEvent.app ??
                          ''
                        }
                      >
                        {editingEvent.app ??
                          'Unknown App'}
                      </div>

                      <div
                        className="text-[11px] text-muted truncate mt-0.5 max-w-[245px]"
                        title={
                          editingEvent.title ??
                          ''
                        }
                      >
                        {editingEvent.title ??
                          'Untitled event'}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={
                      closeEditor
                    }
                    title="Close"
                    aria-label="Close editor"
                    className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-hover transition-colors shrink-0"
                    style={{
                      color:
                        'var(--text-muted)',
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="flex items-center gap-3 mt-3 ml-12">
                  {editingEvent.url && (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Globe
                        size={11}
                        className="text-muted shrink-0"
                      />

                      <span
                        className="text-[10.5px] text-accent font-mono truncate max-w-[190px]"
                        title={
                          editingEvent.url
                        }
                      >
                        {editingEvent.url}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Clock3
                      size={11}
                      className="text-muted"
                    />

                    <span className="text-[10.5px] text-muted font-mono">
                      {fmtTime(
                        new Date(
                          editingEvent.startedAt,
                        ),
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Editor content */}
              <div className="p-1">
                <EventClassificationEditor
                  /*
                   * Key guarantees a fresh editor instance when
                   * switching to a different event, but NOT when
                   * the parent re-renders due to polling.
                   */
                  key={editingEventId}
                  eventId={
                    editingEventId
                  }
                  initialClassification={
                    classificationMap.get(
                      editingEventId,
                    ) ??
                    EMPTY_CLASSIFICATION
                  }
                  activities={
                    activities
                  }
                  dimensions={
                    dimensions
                  }
                  onSave={(
                    edit,
                    newContextName,
                  ) =>
                    handleSaveClassification(
                      editingEventId,
                      edit,
                      newContextName,
                    )
                  }
                  onCancel={
                    closeEditor
                  }
                  disabled={
                    savingEventId ===
                    editingEventId
                  }
                />
              </div>
            </div>
          </div>
        )}
    </div>
  );
}