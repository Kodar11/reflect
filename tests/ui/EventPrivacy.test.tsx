import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DELETE_EVENT_WARNING,
  DeleteEventDialogView,
  EventPrivacyMenuItems,
  EventPrivacyToast,
  eventPrivacyMessage,
  withoutRemoved,
} from '../../src/ui/components/EventPrivacy';
import { HiddenEventsPanel } from '../../src/ui/pages/Activity/HiddenEventsPanel';
import { staleMessage, staleNote } from '../../src/ui/Reflection/reflectionView';

/**
 * The hide / delete controls, rendered for real (server-side, no DOM needed).
 * Interaction is covered by invoking the handlers on the rendered element
 * tree, the way a click would.
 */

type AnyElement = ReactElement<Record<string, any>>;

/** Every element of a rendered tree, depth first. */
function elements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (node && typeof node === 'object' && 'props' in (node as AnyElement)) {
    const el = node as AnyElement;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}

const buttons = (tree: ReactElement) => elements(tree).filter((el) => el.type === 'button');
const textOf = (el: AnyElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, '');

describe('event menu', () => {
  it('offers Hide first and permanent deletion second', () => {
    const onHide = vi.fn();
    const onDelete = vi.fn();
    const [hide, remove] = buttons(EventPrivacyMenuItems({ onHide, onDelete }));

    expect(textOf(hide)).toBe('Hide event');
    expect(textOf(remove)).toBe('Delete permanently…');

    hide.props.onClick();
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    remove.props.onClick();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('delete confirmation', () => {
  const props = { target: { id: 7, label: 'Chrome · Inbox' }, busy: false, onCancel: vi.fn(), onConfirm: vi.fn() };

  it('says what deleting does and that it cannot be undone', () => {
    const html = renderToStaticMarkup(<DeleteEventDialogView {...props} />);
    expect(html).toContain('Delete this event permanently?');
    expect(html).toContain(DELETE_EVENT_WARNING);
    expect(DELETE_EVENT_WARNING).toBe('This permanently removes this tracked event and may change your timeline, activities, and reflections.');
    expect(html).toContain('This cannot be undone.');
    expect(html).toContain('Chrome · Inbox');
    expect(html).toContain('role="alertdialog"');
  });

  it('keeping the event is the primary action; deleting takes its own click', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const [keep, remove] = buttons(DeleteEventDialogView({ ...props, onCancel, onConfirm }));

    expect(textOf(keep)).toBe('Keep event');
    expect(keep.props['data-variant']).toBe('primary');
    expect(textOf(remove)).toBe('Delete permanently');
    expect(remove.props['data-variant']).toBe('danger');

    keep.props.onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    remove.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cannot be answered twice while the deletion is running', () => {
    const [keep, remove] = buttons(DeleteEventDialogView({ ...props, busy: true }));
    expect(keep.props.disabled).toBe(true);
    expect(remove.props.disabled).toBe(true);
    expect(textOf(remove)).toBe('Deleting…');
  });
});

describe('toast', () => {
  it('names what happened and that the timeline is catching up', () => {
    expect(eventPrivacyMessage({ kind: 'hidden', eventIds: [7], updating: true })).toBe('Event hidden · Updating your timeline…');
    expect(eventPrivacyMessage({ kind: 'hidden', eventIds: [7], updating: false })).toBe('Event hidden');
    expect(eventPrivacyMessage({ kind: 'restored', updating: true })).toBe('Event restored · Updating your timeline…');
    expect(eventPrivacyMessage({ kind: 'deleted', updating: false })).toBe('Event deleted');
    expect(eventPrivacyMessage({ kind: 'error', message: 'That change could not be saved.' })).toBe('That change could not be saved.');
  });

  it('offers Undo only where it is given one — hiding, never deleting', () => {
    const onUndo = vi.fn();
    const hidden = EventPrivacyToast({ notice: { kind: 'hidden', eventIds: [7], updating: true }, onUndo });
    const [undo] = buttons(hidden);
    expect(textOf(undo)).toBe('Undo');
    undo.props.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);

    expect(buttons(EventPrivacyToast({ notice: { kind: 'deleted', updating: true } }))).toEqual([]);
  });
});

describe('immediate removal from the current view', () => {
  const events = [{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }];

  it('drops what was just hidden without waiting for a refresh', () => {
    expect(withoutRemoved(events, new Set([2]))).toEqual([events[0], events[2]]);
    expect(withoutRemoved(events, new Set([1, 2, 3]))).toEqual([]);
  });

  it('is the same list when nothing was removed', () => {
    expect(withoutRemoved(events, new Set())).toBe(events);
  });
});

describe('hidden events list', () => {
  const hidden: HiddenEventDto = {
    id: 9,
    watcher: 'window',
    startedAt: new Date(2026, 9, 5, 9, 20).toISOString(),
    endedAt: new Date(2026, 9, 5, 9, 30).toISOString(),
    app: 'Chrome',
    browser: null,
    title: 'Inbox',
    url: null,
    payload: null,
    createdAt: null,
    hiddenAt: new Date(2026, 9, 5, 10).toISOString(),
  };

  it('lists each hidden event with Restore and Delete permanently', () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const tree = HiddenEventsPanel({ events: [hidden], onRestore, onDelete, onClose: vi.fn() });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Chrome · Inbox');
    expect(html).toContain('10m 0s');

    const [, restore, remove] = buttons(tree);
    expect(textOf(restore)).toBe('Restore');
    restore.props.onClick();
    expect(onRestore).toHaveBeenCalledWith(9);
    remove.props.onClick();
    expect(onDelete).toHaveBeenCalledWith({ id: 9, label: 'Chrome · Inbox' });
  });

  it('says so when nothing is hidden', () => {
    const html = renderToStaticMarkup(<HiddenEventsPanel events={[]} onRestore={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('No hidden events.');
  });
});

describe('a reflection that lost a removed event', () => {
  it('says why it is stale, and does not claim to still describe what was seen', () => {
    expect(staleMessage('events_removed')).toBe('An event this reflection was written from was hidden or deleted.');
    expect(staleNote('events_removed')).toContain('has been removed');
    expect(staleNote('activity_changed')).toBe('It still describes what Reflect saw at the time.');
    expect(staleNote(null)).toBe('It still describes what Reflect saw at the time.');
  });
});
