import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  ActivityDto,
  DimensionDto,
  EventClassificationEdit,
} from './activityTypes';

interface EventClassificationEditorProps {
  eventId: number;
  initialClassification: EventClassificationEdit;
  activities: ActivityDto[];
  dimensions: {
    areas: DimensionDto[];
    intents: DimensionDto[];
    qualities: DimensionDto[];
  };
  onSave: (
    classification: EventClassificationEdit,
    newContextName?: string,
  ) => void;
  onCancel: () => void;
  disabled?: boolean;
}

type ContextMode = 'none' | 'existing' | 'new';

const NEW_CONTEXT_VALUE = '__new__';

/*
 * IMPORTANT:
 * Do not use bg-default/bg-secondary here.
 * The editor explicitly paints its own surfaces so content underneath
 * cannot visually bleed through.
 */

const SOLID_BACKGROUND = 'var(--bg)';
const SOLID_SECONDARY = 'var(--bg-secondary)';
const BORDER_COLOR = 'var(--border)';
const TEXT_COLOR = 'var(--text)';
const MUTED_COLOR = 'var(--text-muted)';

const SELECT_BASE =
  'w-full px-2.5 py-2 rounded-md text-[12px] border text-default focus:outline-none focus:border-accent disabled:opacity-50';

const INPUT_BASE =
  'w-full px-2.5 py-2 rounded-md text-[12px] border text-default placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50';

const CONTROL_STYLE: CSSProperties = {
  backgroundColor: SOLID_BACKGROUND,
  backgroundImage: 'none',
  color: TEXT_COLOR,
  borderColor: BORDER_COLOR,
  opacity: 1,
};

const OPTION_STYLE: CSSProperties = {
  backgroundColor: SOLID_BACKGROUND,
  color: TEXT_COLOR,
  opacity: 1,
};

export function EventClassificationEditor({
  eventId,
  initialClassification,
  activities,
  dimensions,
  onSave,
  onCancel,
  disabled = false,
}: EventClassificationEditorProps) {
  const initialState = useMemo(
    () => ({
      draft: {
        ...initialClassification,
      },
      mode: initialClassification.contextId
        ? ('existing' as ContextMode)
        : ('none' as ContextMode),
      newName: '',
    }),
    [eventId, initialClassification],
  );

  const [draft, setDraft] =
    useState<EventClassificationEdit>(initialState.draft);

  const [contextMode, setContextMode] =
    useState<ContextMode>(initialState.mode);

  const [newContextName, setNewContextName] =
    useState(initialState.newName);

  useEffect(() => {
    setDraft({
      ...initialClassification,
    });

    setContextMode(
      initialClassification.contextId
        ? 'existing'
        : 'none',
    );

    setNewContextName('');
  }, [eventId, initialClassification]);

  const update = <K extends keyof EventClassificationEdit>(
    key: K,
    value: EventClassificationEdit[K],
  ) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleContextChange = (value: string) => {
    if (value === NEW_CONTEXT_VALUE) {
      setContextMode('new');
      update('contextId', null);
      return;
    }

    if (value === '') {
      setContextMode('none');
      update('contextId', null);
      setNewContextName('');
      return;
    }

    setContextMode('existing');
    update('contextId', value);
    setNewContextName('');
  };

  const handleSave = () => {
    if (
      contextMode === 'new' &&
      !newContextName.trim()
    ) {
      return;
    }

    onSave(
      draft,
      contextMode === 'new'
        ? newContextName.trim()
        : undefined,
    );
  };

  const contextSelectValue =
    contextMode === 'new'
      ? NEW_CONTEXT_VALUE
      : draft.contextId ?? '';

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        /*
         * These are intentional.
         * The editor creates its own isolated, opaque painting layer.
         */
        position: 'relative',
        isolation: 'isolate',
        zIndex: 1,

        width: '100%',

        backgroundColor: SOLID_BACKGROUND,
        backgroundImage: 'none',

        color: TEXT_COLOR,

        opacity: 1,

        /*
         * Prevent anything inside/outside the editor from visually
         * mixing with the editor surface.
         */
        overflow: 'hidden',

        /*
         * Make the painted surface explicit.
         */
        boxSizing: 'border-box',
      }}
    >
      {/* =========================
          FIELDS
          ========================= */}

      <div
        style={{
          backgroundColor: SOLID_BACKGROUND,
          backgroundImage: 'none',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxSizing: 'border-box',
        }}
      >
        {/* CONTEXT */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <label
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED_COLOR,
              lineHeight: 1.2,
            }}
          >
            Context
          </label>

          <select
            value={contextSelectValue}
            onChange={(e) =>
              handleContextChange(e.target.value)
            }
            disabled={disabled}
            className={SELECT_BASE}
            style={CONTROL_STYLE}
          >
            <option value="" style={OPTION_STYLE}>
              (None)
            </option>

            {activities.map((activity) => (
              <option
                key={activity.id}
                value={activity.id}
                style={OPTION_STYLE}
              >
                {activity.name}
              </option>
            ))}

            <option
              value={NEW_CONTEXT_VALUE}
              style={OPTION_STYLE}
            >
              + Create new Context
            </option>
          </select>

          {contextMode === 'new' && (
            <input
              type="text"
              value={newContextName}
              onChange={(e) =>
                setNewContextName(e.target.value)
              }
              placeholder="New context name"
              disabled={disabled}
              className={INPUT_BASE}
              style={CONTROL_STYLE}
              autoFocus
            />
          )}
        </div>

        {/* AREA */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <label
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED_COLOR,
              lineHeight: 1.2,
            }}
          >
            Area
          </label>

          <select
            value={draft.areaId ?? ''}
            onChange={(e) =>
              update(
                'areaId',
                e.target.value || null,
              )
            }
            disabled={disabled}
            className={SELECT_BASE}
            style={CONTROL_STYLE}
          >
            <option value="" style={OPTION_STYLE}>
              (None)
            </option>

            {dimensions.areas.map((dimension) => (
              <option
                key={dimension.id}
                value={dimension.id}
                style={OPTION_STYLE}
              >
                {dimension.name}
              </option>
            ))}
          </select>
        </div>

        {/* INTENT */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <label
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED_COLOR,
              lineHeight: 1.2,
            }}
          >
            Intent
          </label>

          <select
            value={draft.intentId ?? ''}
            onChange={(e) =>
              update(
                'intentId',
                e.target.value || null,
              )
            }
            disabled={disabled}
            className={SELECT_BASE}
            style={CONTROL_STYLE}
          >
            <option value="" style={OPTION_STYLE}>
              (None)
            </option>

            {dimensions.intents.map((dimension) => (
              <option
                key={dimension.id}
                value={dimension.id}
                style={OPTION_STYLE}
              >
                {dimension.name}
              </option>
            ))}
          </select>
        </div>

        {/* QUALITY */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <label
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED_COLOR,
              lineHeight: 1.2,
            }}
          >
            Quality
          </label>

          <select
            value={draft.qualityId ?? ''}
            onChange={(e) =>
              update(
                'qualityId',
                e.target.value || null,
              )
            }
            disabled={disabled}
            className={SELECT_BASE}
            style={CONTROL_STYLE}
          >
            <option value="" style={OPTION_STYLE}>
              (None)
            </option>

            {dimensions.qualities.map((dimension) => (
              <option
                key={dimension.id}
                value={dimension.id}
                style={OPTION_STYLE}
              >
                {dimension.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* =========================
          FOOTER
          ========================= */}

      <div
        style={{
          position: 'relative',
          zIndex: 2,

          backgroundColor: SOLID_BACKGROUND,
          backgroundImage: 'none',

          borderTop: `1px solid ${BORDER_COLOR}`,

          padding: '12px 20px',

          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <button
            type="button"
            className="btn btn-secondary py-1.5 px-3 text-[11px]"
            onClick={onCancel}
            disabled={disabled}
            style={{
              opacity: 1,
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="btn btn-primary py-1.5 px-3 text-[11px]"
            onClick={handleSave}
            disabled={
              disabled ||
              (contextMode === 'new' &&
                !newContextName.trim())
            }
            style={{
              opacity: 1,
            }}
          >
            {disabled ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}