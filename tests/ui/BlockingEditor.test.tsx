import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockingEditorView, type BlockingEditorViewProps } from '../../src/ui/Focus/BlockingEditor';
import { blockingCounts, blockingEditorModel, isBlockingStartFailure } from '../../src/ui/Focus/focusView';
import { profile } from './focusFixtures';

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function findAll(node: unknown, match: (el: ReactElement) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return found;
  const el = node as ReactElement;
  if (typeof el.type === 'function') return found;
  if (match(el)) found.push(el);
  findAll((el.props as { children?: unknown }).children, match, found);
  return found;
}
const label = (el: ReactElement) => text(renderToStaticMarkup(el));

let seq = 0;
function rule(type: FocusRuleDto['type'], target: string, labelText: string, overrides: Partial<FocusRuleDto> = {}): FocusRuleDto {
  seq += 1;
  return { id: `r${seq}`, type, target, action: 'block', enabled: true, label: labelText, createdAt: '', updatedAt: '', ...overrides };
}

const social = rule('category', 'social-media', 'Social media');
const youtube = rule('website', 'youtube.com', 'youtube.com');
const reddit = rule('website', 'reddit.com', 'reddit.com');
const discord = rule('app', 'discord.exe', 'Discord');
const steam = rule('app', 'steam.exe', 'Steam', { enabled: false });
const github = rule('website', 'github.com', 'github.com', { action: 'allow' });
const RULES = [social, youtube, reddit, discord, steam, github];

const OPTIONS: FocusBlockingOptionsDto = {
  categories: [
    { id: 'social-media', label: 'Social media', siteCount: 30, appCount: 0 },
    { id: 'entertainment', label: 'Entertainment', siteCount: 50, appCount: 2 },
    { id: 'gaming', label: 'Games', siteCount: 20, appCount: 9 },
  ],
  openApps: [
    { name: 'Discord', process: 'discord.exe' },
    { name: 'Spotify', process: 'spotify.exe' },
    { name: 'Visual Studio Code', process: 'code.exe' },
  ],
  recentSites: ['youtube.com', 'news.ycombinator.com', 'reddit.com'],
};

// Deep Work has: Social media, youtube.com, Discord, and allows github.com.
const deepWork = profile({ ruleIds: [social.id, youtube.id, discord.id, steam.id, github.id], blocking: { enabled: true, ruleCount: 3, siteCount: 34, appCount: 1 } });

function props(overrides: Partial<BlockingEditorViewProps> = {}): BlockingEditorViewProps {
  return {
    profile: deepWork,
    rules: RULES,
    options: OPTIONS,
    siteDraft: '',
    allowDraft: '',
    problem: null,
    busy: false,
    onSiteDraftChange: vi.fn(),
    onAllowDraftChange: vi.fn(),
    onAdd: vi.fn(),
    onToggle: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

const tree = (p: BlockingEditorViewProps) => BlockingEditorView(p) as ReactElement;
const buttons = (t: ReactElement) => findAll(t, (el) => el.type === 'button') as ReactElement<{ onClick?: () => void; disabled?: boolean; 'aria-pressed'?: boolean; 'aria-label'?: string; type?: string }>[];
const byText = (t: ReactElement, name: string) => {
  const hit = buttons(t).find((b) => label(b) === name);
  if (!hit) throw new Error(`no button "${name}"; have: ${buttons(t).map(label).join(' | ')}`);
  return hit;
};
const checkboxes = (t: ReactElement) =>
  findAll(t, (el) => el.type === 'label').map((l) => {
    const input = findAll(l, (el) => el.type === 'input')[0] as ReactElement<{ checked: boolean; onChange: (e: unknown) => void }>;
    return { name: label(l), checked: input.props.checked, toggle: (checked: boolean) => input.props.onChange({ target: { checked } }) };
  });

describe('blocking editor model', () => {
  const model = blockingEditorModel(deepWork, RULES, OPTIONS);

  it('lists every available block and marks the ones this preset enforces', () => {
    expect(model.websites.map((w) => [w.rule.label, w.on])).toEqual([['reddit.com', false], ['youtube.com', true]]);
    expect(model.apps.map((a) => [a.rule.label, a.on])).toEqual([['Discord', true], ['Steam', false]]);
    expect(model.allowed.map((a) => [a.rule.label, a.on])).toEqual([['github.com', true]]);
  });

  it('a block that is attached but disabled is not shown as on', () => {
    expect(model.apps.find((a) => a.rule.label === 'Steam')?.on).toBe(false);
  });

  it('offers every category, on or off', () => {
    expect(model.categories.map((c) => [c.label, c.on])).toEqual([['Social media', true], ['Entertainment', false], ['Games', false]]);
  });

  it('suggests only what is not already blocked by this preset', () => {
    expect(model.suggestedSites).toEqual(['news.ycombinator.com', 'reddit.com']);
    expect(model.suggestedApps.map((a) => a.name)).toEqual(['Spotify', 'Visual Studio Code']);
  });

  it('works before suggestions have loaded', () => {
    const bare = blockingEditorModel(deepWork, RULES, null);
    expect(bare.suggestedSites).toEqual([]);
    expect(bare.categories.map((c) => c.label)).toEqual(['Social media']);
  });
});

describe('Blocking editor', () => {
  it('speaks in human terms: names, not identifiers or internals', () => {
    const read = label(tree(props()));
    expect(read).toContain('3 rules · 34 sites · 1 app');
    for (const word of ['Categories', 'Websites', 'Apps', 'Always allowed', 'Discord', 'Social media']) expect(read).toContain(word);
    for (const word of ['.exe', 'lease', 'rule pool', 'global rule', 'profile rule', 'social-media']) expect(read).not.toContain(word);
    expect(read).toContain('Allowed sites stay open even when a category would block them.');
  });

  it('a category is one click on, one click off', () => {
    const p = props();
    const t = tree(p);
    expect(byText(t, 'Social media').props['aria-pressed']).toBe(true);
    expect(byText(t, 'Games').props['aria-pressed']).toBe(false);
    byText(t, 'Games').props.onClick?.();
    expect(p.onAdd).toHaveBeenCalledWith({ type: 'category', target: 'gaming', action: 'block' }, 'site');
    byText(t, 'Social media').props.onClick?.();
    expect(p.onToggle).toHaveBeenCalledWith(social, false);
  });

  it('checked means this preset blocks it; one click changes it, with no save step', () => {
    const p = props();
    const boxes = checkboxes(tree(p));
    expect(boxes.map((b) => [b.name, b.checked])).toEqual([
      ['reddit.com', false],
      ['youtube.com', true],
      ['Discord', true],
      ['Steam', false],
      ['github.com', true],
    ]);
    boxes[0].toggle(true);
    expect(p.onToggle).toHaveBeenCalledWith(reddit, true);
    boxes[2].toggle(false);
    expect(p.onToggle).toHaveBeenCalledWith(discord, false);
    expect(buttons(tree(p)).some((b) => /save/i.test(label(b)))).toBe(false);
  });

  it('adds a typed website through the form (Enter works), and not when empty', () => {
    const submit = (draft: string) => {
      const p = props({ siteDraft: draft });
      const form = findAll(tree(p), (el) => el.type === 'form')[0] as ReactElement<{ onSubmit: (e: unknown) => void }>;
      form.props.onSubmit({ preventDefault: () => {} });
      return p.onAdd as ReturnType<typeof vi.fn>;
    };
    expect(submit('https://www.youtube.com/watch?v=1')).toHaveBeenCalledWith({ type: 'website', target: 'https://www.youtube.com/watch?v=1', action: 'block' }, 'site');
    expect(submit('   ')).not.toHaveBeenCalled();
    expect(byText(tree(props()), 'Block').props.disabled).toBe(true);
    expect(byText(tree(props({ siteDraft: 'x.com' })), 'Block').props.disabled).toBe(false);
  });

  it('blocks a recently visited site or an open app in one click, without typing', () => {
    const p = props();
    const t = tree(p);
    byText(t, '+ news.ycombinator.com').props.onClick?.();
    expect(p.onAdd).toHaveBeenCalledWith({ type: 'website', target: 'news.ycombinator.com', action: 'block' }, 'site');
    byText(t, '+ Spotify').props.onClick?.();
    expect(p.onAdd).toHaveBeenCalledWith({ type: 'app', target: 'spotify.exe', action: 'block' }, 'app');
    // Already blocked here → not offered again.
    expect(buttons(t).map(label)).not.toContain('+ youtube.com');
    expect(buttons(t).map(label)).not.toContain('+ Discord');
  });

  it('allowing a site is its own simple form', () => {
    const p = props({ allowDraft: 'coursera.org' });
    const forms = findAll(tree(p), (el) => el.type === 'form') as ReactElement<{ onSubmit: (e: unknown) => void }>[];
    forms[1].props.onSubmit({ preventDefault: () => {} });
    expect(p.onAdd).toHaveBeenCalledWith({ type: 'website', target: 'coursera.org', action: 'allow' }, 'allow');
  });

  it('removing a block is one labelled click', () => {
    const p = props();
    const remove = buttons(tree(p)).find((b) => b.props['aria-label'] === 'Remove youtube.com');
    remove?.props.onClick?.();
    expect(p.onRemove).toHaveBeenCalledWith(youtube);
  });

  it('shows why an add was refused next to the field it came from', () => {
    const read = label(tree(props({ problem: { field: 'site', message: 'Enter a website like youtube.com.' }, siteDraft: 'nonsense' })));
    expect(read).toContain('Enter a website like youtube.com.');
  });

  it('locks while a change is being saved', () => {
    const t = tree(props({ busy: true, siteDraft: 'x.com', allowDraft: 'y.com' }));
    expect(buttons(t).every((b) => b.props.disabled)).toBe(true);
  });

  it('guides the user when there are no apps to offer yet', () => {
    const empty = props({ rules: [], profile: profile({ ruleIds: [], blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } }), options: { ...OPTIONS, openApps: [], recentSites: [] } });
    const read = label(tree(empty));
    expect(read).toContain('Nothing is blocked');
    expect(read).toContain('Open the app you want to block and it will be offered here.');
  });
});

describe('small helpers', () => {
  it('summarizes what a preset blocks', () => {
    expect(blockingCounts(profile({ blocking: { enabled: true, ruleCount: 2, siteCount: 80, appCount: 2 } }))).toBe('2 rules · 80 sites · 2 apps');
    expect(blockingCounts(profile({ blocking: { enabled: true, ruleCount: 1, siteCount: 0, appCount: 1 } }))).toBe('1 rule · 1 app');
    expect(blockingCounts(profile({ blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } }))).toBe('Nothing is blocked');
  });

  it('recognizes a start that failed because of blocking', () => {
    expect(isBlockingStartFailure('Administrator permission was declined. Focus was not started.')).toBe(true);
    expect(isBlockingStartFailure('A Focus session is already running.')).toBe(false);
    expect(isBlockingStartFailure(null)).toBe(false);
  });
});
