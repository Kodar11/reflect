import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportDialogView, type ExportDialogViewProps } from '../../src/ui/Settings/ExportDialog';
import {
  clearCategories,
  describeEstimate,
  describePackaging,
  describeRange,
  draftProblem,
  formatBytes,
  formatNote,
  initialExportDraft,
  selectAllCategories,
  toExportRequest,
  toggleCategory,
} from '../../src/ui/Settings/exportView';
import { resolveExportRange, type ExportPreview } from '../../src/export/ExportModels';

const NOW = new Date(2026, 9, 15, 12);

type AnyElement = ReactElement<Record<string, any>>;
function elements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, out);
  else if (node && typeof node === 'object' && 'props' in (node as AnyElement)) {
    const el = node as AnyElement;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const preview: ExportPreview = {
  ok: true,
  range: (resolveExportRange({ preset: 'last7' }, NOW) as { ok: true; range: any }).range,
  fileName: 'reflect-export-2026-10-15.zip',
  estimates: [
    { category: 'timeline', sourceEvents: 1234 },
    { category: 'personalization' },
  ],
  empty: false,
};

function props(overrides: Partial<ExportDialogViewProps> = {}): ExportDialogViewProps {
  return {
    draft: { ...initialExportDraft(NOW), categories: ['timeline', 'personalization'], preset: 'last7' },
    preview,
    problem: null,
    phase: { kind: 'idle' },
    onChange: () => {},
    onExport: () => {},
    onReveal: () => {},
    onClose: () => {},
    ...overrides,
  };
}

describe('export draft', () => {
  it('defaults to useful, unsurprising choices: everything but raw events, all history, JSON', () => {
    const d = initialExportDraft(NOW);
    expect(d.categories).toEqual(['timeline', 'focus', 'reflection', 'personalization']);
    expect(d.preset).toBe('all');
    expect(d.format).toBe('json');
    expect([d.customFrom, d.customTo]).toEqual(['2026-10-09', '2026-10-15']);
  });

  it('select all, clear and toggle keep canonical order', () => {
    const d = initialExportDraft(NOW);
    expect(selectAllCategories(d).categories).toEqual(['timeline', 'events', 'focus', 'reflection', 'personalization']);
    expect(clearCategories(d).categories).toEqual([]);
    expect(toggleCategory(clearCategories(d), 'reflection').categories).toEqual(['reflection']);
    expect(toggleCategory(toggleCategory(clearCategories(d), 'reflection'), 'timeline').categories).toEqual(['timeline', 'reflection']);
  });

  it('builds the request the main process validates', () => {
    const d = { ...initialExportDraft(NOW), preset: 'custom' as const };
    expect(toExportRequest(d).range).toEqual({ preset: 'custom', from: '2026-10-09', to: '2026-10-15' });
    expect(toExportRequest({ ...d, preset: 'today' }).range).toEqual({ preset: 'today' });
  });

  it('explains what is wrong before exporting', () => {
    expect(draftProblem(clearCategories(initialExportDraft(NOW)), NOW)).toMatch(/at least one/);
    expect(draftProblem({ ...initialExportDraft(NOW), preset: 'custom', customFrom: '2026-10-20', customTo: '2026-10-01' }, NOW)).toMatch(/start date is after/);
    expect(draftProblem({ ...initialExportDraft(NOW), preset: 'custom', customFrom: '', customTo: '2026-10-01' }, NOW)).toMatch(/both/);
    expect(draftProblem(initialExportDraft(NOW), NOW)).toBeNull();
  });
});

describe('export wording', () => {
  it('describes ranges compactly', () => {
    const r = (preset: any, extra = {}) => (resolveExportRange({ preset, ...extra }, NOW) as any).range;
    expect(describeRange(r('all'))).toBe('All available data');
    expect(describeRange(r('today'))).toBe('15 Oct 2026');
    expect(describeRange(r('last7'))).toBe('9 – 15 Oct 2026');
    expect(describeRange(r('last30'))).toBe('16 Sep – 15 Oct 2026');
    expect(describeRange(r('custom', { from: '2025-12-30', to: '2026-01-02' }))).toBe('30 Dec 2025 – 2 Jan 2026');
  });

  it('describes counts', () => {
    expect(describeEstimate({ category: 'timeline', sourceEvents: 1234 })).toBe('From 1,234 events');
    expect(describeEstimate({ category: 'timeline', sourceEvents: 0 })).toBe('Nothing recorded in this range');
    expect(describeEstimate({ category: 'events', events: 1 })).toBe('1 event');
    expect(describeEstimate({ category: 'reflection', reports: 2, coachActions: 1, coachMessages: 0 })).toBe('2 reflections · 1 suggestion · 0 messages');
  });

  it('says how the export is packaged and when CSV does not apply', () => {
    expect(describePackaging({ categories: ['timeline'], format: 'csv' })).toBe('One CSV file');
    expect(describePackaging({ categories: ['timeline', 'events'], format: 'csv' })).toMatch(/ZIP/);
    expect(formatNote({ categories: ['timeline'], format: 'csv' })).toBeNull();
    expect(formatNote({ categories: ['timeline', 'reflection'], format: 'csv' })).toBe('Reflection & Coach stays JSON (nested details); the rest is CSV.');
    expect(formatNote({ categories: ['personalization'], format: 'csv' })).toMatch(/exported as JSON/);
    expect(formatNote({ categories: ['reflection'], format: 'json' })).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('export dialog', () => {
  it('walks through the four steps with every category, range and format', () => {
    const t = text(renderToStaticMarkup(<ExportDialogView {...props()} />));
    for (const label of ['What to export', 'Date range', 'Format', 'Summary']) expect(t).toContain(label);
    for (const label of ['Timeline', 'Raw activity events', 'Focus sessions', 'Reflection & Coach', 'Personalization & rules']) expect(t).toContain(label);
    for (const label of ['All available data', 'Today', 'Last 7 days', 'Last 30 days', 'This month', 'Custom range']) expect(t).toContain(label);
    expect(t).toContain('Select all');
    expect(text(renderToStaticMarkup(<ExportDialogView {...props({ draft: selectAllCategories(props().draft) })} />))).toContain('Clear');
    expect(t).toContain('From 1,234 events');
    expect(t).toContain('9 – 15 Oct 2026');
    expect(t).toContain('Not filtered by date: settings and rules are exported as they are now.');
    expect(t).toContain('reflect-export-2026-10-15.zip');
  });

  it('warns about sensitive window titles only when raw events are selected', () => {
    const off = text(renderToStaticMarkup(<ExportDialogView {...props()} />));
    expect(off).not.toContain('Window titles and website addresses can contain private details');
    const on = text(renderToStaticMarkup(<ExportDialogView {...props({ draft: { ...props().draft, categories: ['events'] } })} />));
    expect(on).toContain('Window titles and website addresses can contain private details');
  });

  it('shows date inputs for a custom range', () => {
    const html = renderToStaticMarkup(<ExportDialogView {...props({ draft: { ...props().draft, preset: 'custom' } })} />);
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-10-09"');
  });

  it('disables Export while there is a problem, keeping the choices', () => {
    const html = renderToStaticMarkup(<ExportDialogView {...props({ problem: 'Choose at least one kind of data to export.', preview: null })} />);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">Export…<\/button>/);
  });

  it('while exporting, locks the form and says it may take a while', () => {
    const html = renderToStaticMarkup(<ExportDialogView {...props({ phase: { kind: 'running' } })} />);
    expect(text(html)).toContain('Exporting…');
    expect(text(html)).toContain('large exports can take a minute');
    expect(html.match(/<fieldset class="xp-panel" disabled="">/g)?.length).toBe(3);
  });

  it('on success shows the saved file and folder, and can reveal it', () => {
    const onReveal = vi.fn();
    const tree = ExportDialogView(
      props({ phase: { kind: 'saved', result: { status: 'saved', fileName: 'reflect-export-2026-10-15.zip', folder: 'C:\\Users\\me\\Documents', files: ['a', 'b', 'manifest.json'], bytes: 4096 } }, onReveal }),
    );
    const t = text(renderToStaticMarkup(tree));
    expect(t).toContain('Saved reflect-export-2026-10-15.zip');
    expect(t).toContain('C:\\Users\\me\\Documents · 4.0 KB · 3 files inside');
    elements(tree).find((e) => e.type === 'button' && text(renderToStaticMarkup(e)) === 'Show in folder')!.props.onClick();
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it('reports a failure clearly while keeping every selection', () => {
    const html = renderToStaticMarkup(<ExportDialogView {...props({ phase: { kind: 'error', message: 'There is not enough free disk space for this export.' } })} />);
    expect(text(html)).toContain('There is not enough free disk space');
    expect(html).toMatch(/id="export-category-timeline" type="checkbox" class="xp-check" checked=""/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Export…<\/button>/);
  });

  it('notes an empty range', () => {
    const t = text(renderToStaticMarkup(<ExportDialogView {...props({ preview: { ...preview, empty: true } as ExportPreview })} />));
    expect(t).toContain('Nothing was recorded in this range');
  });

  it('category checkboxes and range choices report changes', () => {
    const onChange = vi.fn();
    const tree = ExportDialogView(props({ onChange }));
    const all = elements(tree);
    const events = elements(all.find((e) => typeof e.type === 'function' && e.props.category === 'events')!.type(all.find((e) => e.props.category === 'events')!.props)).find(
      (e) => e.type === 'input',
    )!;
    events.props.onChange();
    expect(onChange.mock.calls[0][0].categories).toEqual(['timeline', 'events', 'personalization']);
    const today = all.filter((e) => e.type === 'input' && e.props.name === 'export-range')[1];
    today.props.onChange();
    expect(onChange.mock.calls[1][0].preset).toBe('today');
  });
});
