import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { AppIcon, WebsiteFavicon } from './ActivityIcons';
import { useDialog } from '../../Focus/useDialog';
import {
  COLLAPSED_LIST,
  USAGE_LIST_INITIAL,
  USAGE_PERIODS,
  barPercent,
  dateKey,
  defaultCustomRequest,
  describeChange,
  formatRange,
  formatShare,
  formatUsageDuration,
  formatWhen,
  kindLabel,
  listRows,
  opensText,
  parseStoredRequest,
  periodNames,
  refreshIntervalMs,
  requestKey,
  type UsageListState,
} from './usageView';

const STORAGE_KEY = 'reflect_usage_period';

type ListStates = Record<UsageKindDto, UsageListState>;
type ItemRef = { kind: UsageKindDto; key: string };

/**
 * Activity → Usage. Owns what is selected (period, expanded lists, search,
 * the item being inspected) and reads the report for it; every figure on the
 * page is computed in the main process.
 */
export function UsageTab() {
  const [request, setRequest] = useState<UsageRequestDto>(
    () => parseStoredRequest(localStorage.getItem(STORAGE_KEY)) ?? { type: 'day' },
  );
  const [report, setReport] = useState<UsageReportDto | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lists, setLists] = useState<ListStates>({ app: COLLAPSED_LIST, website: COLLAPSED_LIST });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ItemRef | null>(null);
  // Only the answer to the latest question is shown, whatever order they return in.
  const latest = useRef(0);

  const load = useCallback(async (req: UsageRequestDto) => {
    const id = ++latest.current;
    try {
      const next = await window.usage.getReport(req);
      if (id !== latest.current) return;
      setReport(next);
      setLoadedKey(requestKey(req));
      setError(null);
    } catch (e) {
      if (id !== latest.current) return;
      setError((e as Error)?.message || 'The usage data could not be read.');
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(request));
    setSelected(null);
    setError(null);
    void load(request);
  }, [request, load]);

  const current = loadedKey === requestKey(request);
  const refreshEvery = current && report ? refreshIntervalMs(report.window) : null;
  useEffect(() => {
    if (!refreshEvery) return;
    const refresh = () => void load(request);
    const timer = setInterval(refresh, refreshEvery);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refreshEvery, request, load]);

  const selectedItem =
    selected && report && current
      ? ([...report.apps, ...report.websites, ...report.movers].find((i) => i.kind === selected.kind && i.key === selected.key) ?? null)
      : null;

  return (
    <>
      <UsageView
        request={request}
        report={report}
        loading={!current && !error}
        stale={!current}
        error={error}
        lists={lists}
        query={query}
        now={new Date()}
        onRequest={setRequest}
        onRetry={() => {
          setError(null);
          void load(request);
        }}
        onToggleList={(kind) => setLists((s) => ({ ...s, [kind]: s[kind].open ? COLLAPSED_LIST : { open: true, showAll: false } }))}
        onShowAll={(kind, showAll) => setLists((s) => ({ ...s, [kind]: { open: true, showAll } }))}
        onQuery={setQuery}
        onSelect={(item) => setSelected({ kind: item.kind, key: item.key })}
      />
      {selectedItem && report && (
        <UsageDetailDrawer item={selectedItem} report={report} request={request} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

export interface UsageViewProps {
  request: UsageRequestDto;
  /** The last report read; while `stale`, it belongs to the period shown before. */
  report: UsageReportDto | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  lists: ListStates;
  query: string;
  now: Date;
  onRequest: (request: UsageRequestDto) => void;
  onRetry: () => void;
  onToggleList: (kind: UsageKindDto) => void;
  onShowAll: (kind: UsageKindDto, showAll: boolean) => void;
  onQuery: (query: string) => void;
  onSelect: (item: UsageItemDto) => void;
}

/** The page itself, as a function of what to show. No state, no data access. */
export function UsageView(props: UsageViewProps) {
  const { request, report, loading, stale, error, now } = props;
  // A report for another period is kept on screen while the new one loads, so
  // nothing jumps or flashes empty — but never next to an error about the new one.
  const shown = stale && error ? null : report;

  return (
    <div className="usage-root">
      <div className="usage-page">
        <PeriodBar request={request} report={stale ? null : report} loading={loading} now={now} onRequest={props.onRequest} />

        {error && (
          <div className="usage-banner" role="alert">
            <span>Usage could not be loaded{shown ? ' — showing the last figures read' : ''}. {error}</span>
            <button className="btn btn-ghost" onClick={props.onRetry}>
              <RefreshCw size={13} /> Try again
            </button>
          </div>
        )}

        {shown ? (
          <div className="usage-body" data-loading={loading || undefined} aria-busy={loading}>
            <SummaryCards report={shown} onSelect={props.onSelect} />
            <Comparison report={shown} now={now} onSelect={props.onSelect} />
            {shown.trackedMs > 0 ? (
              <>
                <TopLists report={shown} onSelect={props.onSelect} />
                <FullLists {...props} report={shown} />
              </>
            ) : (
              <div className="usage-empty">
                <strong>No tracked activity {emptyPhrase(shown.window.type)}.</strong>
                <span>
                  {shown.trackingSince
                    ? 'Applications and websites appear here once Reflect has tracked time in this period.'
                    : 'Reflect has not recorded any activity yet. Usage appears here once tracking has run.'}
                </span>
              </div>
            )}
          </div>
        ) : error ? null : (
          <UsageSkeleton />
        )}
      </div>
    </div>
  );
}

function emptyPhrase(type: UsagePeriodTypeDto): string {
  return type === 'custom' ? 'in this range' : periodNames(type).current.toLowerCase();
}

function PeriodBar({
  request,
  report,
  loading,
  now,
  onRequest,
}: {
  request: UsageRequestDto;
  report: UsageReportDto | null;
  loading: boolean;
  now: Date;
  onRequest: (request: UsageRequestDto) => void;
}) {
  const today = dateKey(now);
  return (
    <div className="usage-toolbar">
      <div className="usage-periods" role="group" aria-label="Period">
        {USAGE_PERIODS.map(({ type, label }) => (
          <button
            key={type}
            className="usage-period"
            aria-pressed={request.type === type}
            onClick={() => {
              if (request.type === type) return;
              onRequest(type === 'custom' ? defaultCustomRequest(now) : { type });
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {request.type === 'custom' && (
        <div className="usage-dates">
          <input
            type="date"
            className="usage-date"
            aria-label="Range start"
            value={request.startDate}
            max={today}
            onChange={(e) => {
              const startDate = e.target.value;
              if (startDate) onRequest({ type: 'custom', startDate, endDate: startDate > request.endDate ? startDate : request.endDate });
            }}
          />
          <span aria-hidden="true">–</span>
          <input
            type="date"
            className="usage-date"
            aria-label="Range end"
            value={request.endDate}
            max={today}
            onChange={(e) => {
              const endDate = e.target.value;
              if (endDate) onRequest({ type: 'custom', endDate, startDate: endDate < request.startDate ? endDate : request.startDate });
            }}
          />
        </div>
      )}

      <div className="usage-toolbar-meta" aria-live="polite">
        {loading ? 'Loading…' : report ? formatRange(report.window.current, now) : ''}
      </div>
    </div>
  );
}

function ItemIcon({ item, size = 16 }: { item: UsageItemDto; size?: number }) {
  return item.kind === 'website' ? <WebsiteFavicon domain={item.name} size={size} /> : <AppIcon appName={item.name} size={size} />;
}

/** A difference from the previous range. Direction is shown, never judged: no red, no green. */
function Change({ change, previousName }: { change: UsageChangeDto | null; previousName: string }) {
  const c = describeChange(change, previousName);
  return (
    <span className="usage-change" data-direction={c.direction} title={c.label} aria-label={c.label}>
      {c.direction === 'up' && <ArrowUp size={11} aria-hidden="true" />}
      {c.direction === 'down' && <ArrowDown size={11} aria-hidden="true" />}
      {c.direction === 'new' ? (
        <>
          {c.delta} <span className="usage-new">new</span>
        </>
      ) : (
        c.text
      )}
    </span>
  );
}

function SummaryCards({ report, onSelect }: { report: UsageReportDto; onSelect: (item: UsageItemDto) => void }) {
  const names = periodNames(report.window.type);
  const topApp = report.apps[0] ?? null;
  const topSite = report.websites[0] ?? null;
  const opened = report.mostOpened;
  const usedLine = (item: UsageItemDto) => `${formatUsageDuration(item.ms)} · ${formatShare(item.share)} of tracked time`;

  return (
    <section className="usage-cards" aria-label="Summary">
      <div className="usage-card">
        <div className="usage-label">Total tracked time</div>
        <div className="usage-card-value usage-card-total">{formatUsageDuration(report.trackedMs)}</div>
        <div className="usage-card-sub">
          {report.totals.tracked ? (
            <>
              <Change change={report.totals.tracked} previousName={names.previous} /> vs {names.previous.toLowerCase()}
            </>
          ) : (
            'No earlier period to compare'
          )}
        </div>
      </div>
      <ItemCard label="Most used application" item={topApp} sub={topApp && usedLine(topApp)} empty="No applications tracked" onSelect={onSelect} />
      <ItemCard label="Most used website" item={topSite} sub={topSite && usedLine(topSite)} empty="No websites tracked" onSelect={onSelect} />
      <ItemCard
        label="Most opened"
        item={opened}
        sub={opened && `${kindLabel(opened.kind)} · brought to the front ${opened.opens.toLocaleString('en-US')} ${opened.opens === 1 ? 'time' : 'times'}`}
        empty="Nothing opened"
        onSelect={onSelect}
      />
    </section>
  );
}

function ItemCard({
  label,
  item,
  sub,
  empty,
  onSelect,
}: {
  label: string;
  item: UsageItemDto | null;
  sub: string | null;
  empty: string;
  onSelect: (item: UsageItemDto) => void;
}) {
  if (!item) {
    return (
      <div className="usage-card">
        <div className="usage-label">{label}</div>
        <div className="usage-card-value usage-card-none">—</div>
        <div className="usage-card-sub">{empty}</div>
      </div>
    );
  }
  return (
    <button className="usage-card" onClick={() => onSelect(item)} title={item.name}>
      <div className="usage-label">{label}</div>
      <div className="usage-card-value">
        <ItemIcon item={item} size={16} />
        <span className="usage-truncate">{item.name}</span>
      </div>
      <div className="usage-card-sub">{sub}</div>
    </button>
  );
}

function Comparison({ report, now, onSelect }: { report: UsageReportDto; now: Date; onSelect: (item: UsageItemDto) => void }) {
  const names = periodNames(report.window.type);
  const { totals, window } = report;
  const since = report.trackingSince ? formatWhen(report.trackingSince, now) : null;
  const metrics: { label: string; hint: string; currentMs: number; change: UsageChangeDto | null }[] = [
    { label: 'Total tracked', hint: 'All tracked foreground time', currentMs: report.trackedMs, change: totals.tracked },
    { label: 'On websites', hint: 'Time with a website in the foreground browser tab', currentMs: report.websiteMs, change: totals.websites },
    {
      label: 'Outside websites',
      hint: 'Tracked time that was not on a website: other applications, and browser pages without a site',
      currentMs: report.trackedMs - report.websiteMs,
      change: totals.outsideWebsites,
    },
  ];

  return (
    <section className="usage-section" aria-label="Comparison with the previous period">
      <header className="usage-section-head">
        <h2 className="usage-title">
          {names.current} vs {names.previous.toLowerCase()}
        </h2>
        <span className="usage-ranges">
          <span title={`${names.current}: the range measured`}>{formatRange(window.current, now)}</span>
          <span className="usage-ranges-vs">compared with</span>
          <span title={`${names.previous}: the equivalent range before it`}>{formatRange(window.previous, now)}</span>
        </span>
      </header>

      {report.history === 'none' && (
        <p className="usage-note">
          {since
            ? `No comparison yet: tracking began ${since}, after the earlier range ended.`
            : 'No comparison yet: nothing has been tracked before this period.'}
        </p>
      )}
      {report.history === 'partial' && (
        <p className="usage-note">
          Tracking began {since}, part-way through the earlier range, so its figures cover only part of it.
        </p>
      )}
      {report.history !== 'none' && window.inProgress && (
        <p className="usage-note">
          {names.current} is still in progress, so both ranges stop at the same point.
        </p>
      )}

      <div className="usage-metrics">
        {metrics.map((m) => (
          <div className="usage-metric" key={m.label} title={m.hint}>
            <div className="usage-label">{m.label}</div>
            <div className="usage-metric-values">
              <span className="usage-metric-now">{formatUsageDuration(m.currentMs)}</span>
              <Change change={m.change} previousName={names.previous} />
            </div>
            <div className="usage-metric-was">
              {m.change ? `${names.previous}: ${formatUsageDuration(m.change.previousMs)}` : `${names.previous}: not available`}
            </div>
          </div>
        ))}
      </div>

      {report.movers.length > 0 && (
        <div className="usage-movers">
          <div className="usage-label">Largest changes</div>
          <div className="usage-mover-list">
            {report.movers.map((item) => (
              <button key={`${item.kind}:${item.key}`} className="usage-mover" onClick={() => onSelect(item)} title={item.name}>
                <ItemIcon item={item} size={14} />
                <span className="usage-truncate">{item.name}</span>
                <Change change={item.change} previousName={names.previous} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function UsageRow({
  item,
  rank,
  longestMs,
  previousName,
  showOpens,
  onSelect,
}: {
  item: UsageItemDto;
  rank?: number;
  longestMs: number;
  previousName: string;
  showOpens?: boolean;
  onSelect: (item: UsageItemDto) => void;
}) {
  return (
    <button className="usage-row" data-opens={showOpens || undefined} onClick={() => onSelect(item)} title={item.name}>
      <span className="usage-rank">{rank ?? ''}</span>
      <ItemIcon item={item} />
      <span className="usage-row-main">
        <span className="usage-truncate usage-name">{item.name}</span>
        <span className="usage-bar" aria-hidden="true">
          <span style={{ width: `${barPercent(item.ms, longestMs)}%` }} />
        </span>
      </span>
      <span className="usage-duration">{formatUsageDuration(item.ms)}</span>
      <span className="usage-share" title={`${formatShare(item.share)} of tracked time`}>
        {formatShare(item.share)}
      </span>
      {showOpens && <span className="usage-opens">{opensText(item.opens)}</span>}
      <Change change={item.change} previousName={previousName} />
    </button>
  );
}

function TopLists({ report, onSelect }: { report: UsageReportDto; onSelect: (item: UsageItemDto) => void }) {
  const previousName = periodNames(report.window.type).previous;
  const panel = (title: string, items: UsageItemDto[], empty: string) => (
    <div className="usage-section usage-top-panel">
      <header className="usage-section-head">
        <h2 className="usage-title">{title}</h2>
        <span className="usage-hint">time · share of tracked time · vs {previousName.toLowerCase()}</span>
      </header>
      {items.length === 0 ? (
        <div className="usage-none">{empty}</div>
      ) : (
        <div className="usage-rows">
          {items.map((item, i) => (
            <UsageRow key={item.key} item={item} rank={i + 1} longestMs={items[0].ms} previousName={previousName} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
  return (
    <>
      <div className="usage-top">
        {panel('Top applications', report.topApps, 'No applications tracked in this period.')}
        {panel('Top websites', report.topWebsites, 'No websites tracked in this period.')}
      </div>
      <p className="usage-footnote">
        Shares are of total tracked time. Time on a website is also part of its browser&apos;s time, so the two lists overlap and are not added together.
      </p>
    </>
  );
}

function FullLists(props: UsageViewProps & { report: UsageReportDto }) {
  const { report, query } = props;
  return (
    <section className="usage-all" aria-label="All applications and websites">
      <div className="usage-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search applications and websites"
          placeholder="Search all applications and websites…"
          value={query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
      </div>
      <UsageList {...props} kind="app" title="All applications" items={report.apps} />
      <UsageList {...props} kind="website" title="All websites" items={report.websites} />
    </section>
  );
}

export function UsageList({
  kind,
  title,
  items,
  report,
  lists,
  query,
  onToggleList,
  onShowAll,
  onSelect,
}: Pick<UsageViewProps, 'lists' | 'query' | 'onToggleList' | 'onShowAll' | 'onSelect'> & {
  kind: UsageKindDto;
  title: string;
  items: UsageItemDto[];
  report: UsageReportDto;
}) {
  const state = lists[kind];
  const view = listRows(items, state, query);
  const previousName = periodNames(report.window.type).previous;
  const negligible = items.filter((item) => item.negligible).length;
  const noun = kind === 'app' ? 'applications' : 'websites';
  const bodyId = `usage-list-${kind}`;

  return (
    <div className="usage-section usage-list">
      <button className="usage-list-toggle" aria-expanded={view.visible} aria-controls={bodyId} onClick={() => onToggleList(kind)}>
        <ChevronRight size={14} className="usage-chevron" aria-hidden="true" />
        <span className="usage-title">{title}</span>
        <span className="usage-count">{view.searching ? `${view.matched} of ${items.length}` : items.length}</span>
        {negligible > 0 && (
          <span className="usage-hint" title="Counted in every total; left out of the overview above">
            {negligible} under {formatUsageDuration(report.negligibleBelowMs)}
          </span>
        )}
      </button>

      {view.visible && (
        <div id={bodyId} className="usage-list-body">
          {view.rows.length === 0 ? (
            <div className="usage-none">{view.searching ? `No ${noun} match “${query.trim()}”.` : `No ${noun} tracked in this period.`}</div>
          ) : (
            <div className="usage-rows">
              {view.rows.map((item) => (
                <UsageRow
                  key={item.key}
                  item={item}
                  longestMs={items[0].ms}
                  previousName={previousName}
                  showOpens
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
          {view.remaining > 0 && (
            <button className="usage-more" onClick={() => onShowAll(kind, true)}>
              Show all {view.matched} {noun}
            </button>
          )}
          {!view.searching && state.showAll && items.length > USAGE_LIST_INITIAL && (
            <button className="usage-more" onClick={() => onShowAll(kind, false)}>
              Show top {USAGE_LIST_INITIAL} only
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Same blocks as the loaded page, so nothing moves when the figures arrive. */
function UsageSkeleton() {
  return (
    <div className="usage-body" aria-busy="true" aria-label="Loading usage">
      <div className="usage-cards">
        {[0, 1, 2, 3].map((i) => (
          <div className="usage-card usage-skeleton" key={i} />
        ))}
      </div>
      <div className="usage-section usage-skeleton" style={{ height: 132 }} />
      <div className="usage-top">
        <div className="usage-section usage-skeleton" style={{ height: 268 }} />
        <div className="usage-section usage-skeleton" style={{ height: 268 }} />
      </div>
    </div>
  );
}

type DetailState = { status: 'loading' } | { status: 'ready'; detail: UsageItemDetailDto } | { status: 'error' };

function UsageDetailDrawer({
  item,
  report,
  request,
  onClose,
}: {
  item: UsageItemDto;
  report: UsageReportDto;
  request: UsageRequestDto;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, onClose);
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const reqKey = requestKey(request);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    window.usage
      .getItemDetail(request, item.kind, item.key)
      .then((detail) => live && setState({ status: 'ready', detail }))
      .catch(() => live && setState({ status: 'error' }));
    return () => {
      live = false;
    };
    // The request is identified by its key, not by object identity.
  }, [reqKey, item.kind, item.key]);

  return (
    <div
      className="focus-drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className="focus-drawer usage-drawer" role="dialog" aria-modal="true" aria-label={`Usage of ${item.name}`}>
        <UsageDetail item={item} report={report} state={state} now={new Date()} onClose={onClose} />
      </div>
    </div>
  );
}

export function UsageDetail({
  item,
  report,
  state,
  now,
  onClose,
}: {
  item: UsageItemDto;
  report: UsageReportDto;
  state: DetailState;
  now: Date;
  onClose: () => void;
}) {
  const names = periodNames(report.window.type);
  const change = describeChange(item.change, names.previous);
  const ofCategory = item.kind === 'website' && report.websiteMs > 0 ? item.ms / report.websiteMs : null;
  const detail = state.status === 'ready' ? state.detail : null;
  const longestTitleMs = detail?.titles[0]?.ms ?? 0;

  return (
    <>
      <header className="usage-drawer-head">
        <div className="usage-drawer-name">
          <span className="usage-label">{kindLabel(item.kind)}</span>
          <h2>
            <ItemIcon item={item} size={18} />
            <span>{item.name}</span>
          </h2>
        </div>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Close details" autoFocus>
          <X size={15} />
        </button>
      </header>

      <dl className="usage-facts">
        <div>
          <dt>{names.current}</dt>
          <dd>{formatUsageDuration(item.ms)}</dd>
        </div>
        <div>
          <dt>{names.previous}</dt>
          <dd>{item.change ? formatUsageDuration(item.change.previousMs) : 'Not available'}</dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd title={change.label}>{change.text}</dd>
        </div>
        <div>
          <dt>Share of tracked time</dt>
          <dd>{formatShare(item.share)}</dd>
        </div>
        {ofCategory !== null && (
          <div>
            <dt>Share of website time</dt>
            <dd>{formatShare(ofCategory)}</dd>
          </div>
        )}
        <div>
          <dt>Brought to the front</dt>
          <dd>{item.ms > 0 ? `${item.opens.toLocaleString('en-US')} ${item.opens === 1 ? 'time' : 'times'}` : '—'}</dd>
        </div>
        <div>
          <dt>Last active</dt>
          <dd>{item.lastActiveAt ? formatWhen(item.lastActiveAt, now) : '—'}</dd>
        </div>
      </dl>
      <p className="usage-note">
        {formatRange(report.window.current, now)}, compared with {formatRange(report.window.previous, now)}.
      </p>

      <section>
        <div className="usage-label">Window titles with the most time</div>
        {state.status === 'loading' && <div className="usage-none">Loading…</div>}
        {state.status === 'error' && <div className="usage-none">The window titles could not be read.</div>}
        {detail && detail.titles.length === 0 && <div className="usage-none">No window titles recorded in this period.</div>}
        {detail && detail.titles.length > 0 && (
          <>
            <ul className="usage-titles">
              {detail.titles.map((t) => (
                <li key={t.title} title={t.title}>
                  <span className="usage-row-main">
                    <span className="usage-truncate">{t.title}</span>
                    <span className="usage-bar" aria-hidden="true">
                      <span style={{ width: `${barPercent(t.ms, longestTitleMs)}%` }} />
                    </span>
                  </span>
                  <span className="usage-duration">{formatUsageDuration(t.ms)}</span>
                </li>
              ))}
            </ul>
            {detail.titleCount > detail.titles.length && (
              <p className="usage-note">
                {detail.titles.length} of {detail.titleCount} titles shown.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
