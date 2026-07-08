# Stage 1 — Activity Capture: Architectural Decisions

This file records the non-obvious trade-offs made while implementing the Stage 1
activity capture engine. Code comments explain *what* each module does; this
file explains *why* it was done that way instead of the alternatives.

## 1. SQLite driver: `better-sqlite3` (native, synchronous)

**Choice.** Use `better-sqlite3` directly in the Electron main process.

**Rejected.** `sql.js` (WASM) avoids native builds but needs manual
periodic flush-to-disk and serializes every call. For a write-heavy tracker
that crashes the moment the user force-quits, a real native DB with WAL journal
is materially safer and simpler to reason about.

**Cost.** Requires Python + VS Build Tools on the dev machine for
`@electron/rebuild`. Paid once; documented in the build flow.
`npm run rebuild` rebuilds `better-sqlite3` and `active-win` against
Electron's V8 ABI. `postinstall` attempts the same for fresh clones.

**Run-location note.** All SQLite calls run in the main process (off the
renderer thread), so synchronous calls never jank the UI. This is the classic
Electron pattern and the reason a sync API is acceptable here.

## 2. Browser URL capture is deferred to a sub-stage

**Problem.** There is no reliable, general, native way to read the active tab
URL of an already-running Chrome/Edge/Firefox. The three real options are:

- a companion browser extension + native messaging host (robust, but
  substantial scope);
- relaunch browsers with `--remote-debugging-port` and read CDP (intrusive —
  won't see the user's normal browsing session);
- window-title parsing (lossy and fragile).

**Decision.** Ship Stage 1 with the `WindowWatcher` fully working and leave a
compliant `BrowserWatcher` stub that is *not registered* in `TrackingService`.
The `IWatcher` seam is the proof that the second watcher slots in with no
changes elsewhere; when browser capture is a focused sub-stage, the work is
localized entirely inside `BrowserWatcher`.

## 3. Foreground window: `active-win` (native) via injected poll

**Choice.** `active-win` polled at 1s.

**Rejected — PowerShell bridge.** A long-lived `powershell.exe` polling
`GetForegroundWindow` emits JSON-on-change and needs zero native build. We
chose `active-win` because the user prefers the cleanest production
implementation and is willing to install build tools once. The watcher is
designed so the poll function is injected — swapping the strategy later is a
one-constructor-arg change with no watcher edits.

**Polling vs. events.** Windows offers no reliable foreground-changed event a
Node process can subscribe to without a native addon; 1s polling is a fine
Stage 1 granularity and keeps the stack dependency-free of fragile hook DLLs.

## 4. Heartbeat engine: one merge authority, one open event per watcher

**Design.** Watchers emit raw `ActivitySample`s on every tick. Many ticks are
the *same* activity. The `HeartbeatEngine` keeps an open event per watcher and
collapses an identical run into ONE row: `started_at` at the first sample,
`ended_at` advanced as time passes. A periodic `flush()` (default 5s) writes
`ended_at` to the DB so an abrupt exit loses at most that tail — never a whole
run.

**Identity.** `eventKey = (watcher, app, browser, title, url)`. `payload` is
deliberately excluded so watcher-specific noise (scroll position, a counter)
cannot fragment a run.

**Seam.** The engine implements `IEventSink`; watchers accept `IEventSink`,
never the engine class. A future non-merging watcher could substitute a
write-through sink with zero changes to existing watchers.

## 5. Background lifecycle: minimize-to-tray

**Problem.** The success criterion says "closing the UI does not stop
tracking," which conflicts with the starter's `window-all-closed → app.quit()`.

**Choice.** `window-all-closed` hides windows to the tray on Windows. Real
quit is only via the tray's "Quit" menu, which drives `TrackingService.stop()`
(flushing all open events) and `Database.close()`. A `quitting` guard prevents
re-entry between `before-quit` and the final `app.quit()`.

## 6. Interfaces everywhere practical (testability)

Extra instruction from the spec: every module communicates through interfaces.

- `IEventRepository` — repository seam (tests use `FakeEventRepository`).
- `IEventSink` — heartbeat seam watchers depend on.
- `IWatcher` — watcher seam `TrackingService` depends on.
- `WindowWatcher` takes an injected `poll` function so unit tests never import
  `active-win` or Electron.
- `HeartbeatEngine` takes an injected `now()` clock so tests are deterministic.

Result: 17 unit tests cover engine merging, watcher error isolation, service
lifecycle, and repository CRUD — none of them spin up Electron or SQLite-via-Electron.

## 7. Database is the sole SQLite touchpoint

Only `Database.ts` imports `better-sqlite3`. `EventRepository` consumes it via
a `prepare` helper and implements `IEventRepository`. Swapping the storage
back-end (sql.js, a remote sync target) is a one-class rewrite behind the
interface.

## 8. Schema: one `events` table with dedicated searchable columns

Per spec: `app`, `browser`, `title`, `url` are real columns (frequently
filtered), `payload` is a JSON string for watcher-specific extras. Indexes on
`started_at`, `watcher`, `app` cover the dev viewer's "newest today" query and
future filtering. `user_version` pragma is reserved for additive migrations;
Stage 1 is v1.

## 9. ADR schema decisions

- `started_at`/`ended_at` are full ISO-8601 strings at the boundary so
  timezone is preserved exactly and SQLite DATETIME round-trips trivially.
- "today" is local-wall-clock day (user-facing concept), not UTC day.
- `payload` is excluded from identity (see §4).