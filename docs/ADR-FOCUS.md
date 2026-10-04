# Focus Mode V2 — Architectural Decisions

Code comments explain *what* each module does; this file records *why* Focus
is built the way it is.

Product rule everything below serves: **easy to start, easy to stay in,
deliberate to break, actually enforced.**

```
Focus page (renderer)        display + requests only
        │  IPC
        ▼
FocusService (main)          state machine, timers, recovery — the authority
        │  lease: start / heartbeat / stop
        ▼
HelperBlockingManager        owns a named pipe, launches the helper via UAC
        │  newline-delimited JSON
        ▼
blocker helper (elevated)    BlockerCore: hosts file + process termination
```

## 1. Enforcement runs in an elevated helper, not a Windows service

**Choice.** The app executable doubles as the blocker: started with
`--focus-blocker` through `Start-Process -Verb RunAs`, it runs only
`BlockerCore` — no window, tray, database or tracking. The unprivileged app
talks to it over a named pipe.

**Rejected — an installed Windows service.** It would avoid the UAC prompt,
but needs an installer-time registration step that cannot run in `npm run dev`,
a service wrapper dependency, and an always-running LocalSystem process for a
feature used a few times a day. (The repository's old installer script
referenced such a service from a predecessor project; its source was never
part of this repository.)

**Cost.** One UAC prompt the first time a blocking session starts in each app
run. The helper then stays alive for later sessions. `IBlockingManager` is the
seam: a service-backed manager can replace `HelperBlockingManager` without
touching `FocusService`.

**Why the app is the pipe server.** An elevated process can always connect to
a pipe created by an unprivileged one; the reverse depends on the pipe's ACL
and integrity label. The helper proves it is the process the app launched by
echoing a random token passed on its command line.

**The helper is deliberately narrow.** It accepts only validated hostnames and
process image names — never a path, an IP address or a command — always sinks
names to `0.0.0.0` / `::`, never terminates a protected process, and only
touches the Windows session of the person who started Focus.

## 2. Blocking is lease-based and self-releasing

A lease means "this Focus session owns this blocking state". The helper
releases a lease that is not heartbeated within its TTL (45 s; time asleep
does not count), so an app that crashed can never leave the machine blocked.
If the helper loses the app it keeps enforcing until the TTL runs out, then
restores the hosts file and exits. Every exit path of the helper restores
first.

`FocusService` heartbeats every 5 s — **also while paused**. When a heartbeat
fails it makes one automatic attempt to re-acquire; if that fails the session
continues but reports `degraded`, and the UI offers "Restore". It never keeps
saying "Blocking active" on a lease it cannot confirm.

## 3. Hosts-file editing: tagged lines, not marker pairs

Every line Reflect writes ends with `# reflect-focus`. Applying is "drop every
tagged line, append the new block"; removing is "drop every tagged line". The
user's lines are never parsed as ours, repeated or overlapping sessions cannot
duplicate entries, and a half-deleted block cannot confuse cleanup. Line
endings, a BOM and the trailing-newline state are preserved, so apply + remove
restores the file byte for byte. A hosts file that is not UTF-8 text is left
alone. The resolver cache is flushed (`ipconfig /flushdns`) after each change.

**Known limits of hosts-based blocking.** No wildcards — a site rule is
expanded to its known hostnames (`www.`, `m.` and a small table of aliases).
Browsers keep their own DNS cache and open connections for up to a minute or
so, so a tab that is already open may keep working briefly after Focus starts.
A browser using DNS-over-HTTPS with hosts-file bypass is not covered.

## 4. Allow beats block

Rules are compiled once into explicit hostnames and process names:

1. every `block` rule is expanded and unioned;
2. every `allow` rule then removes what it covers.

An explicit allow always wins, regardless of rule order in the database
(`BlockingConfig.ts`, tested with shuffled rule lists). Categories resolve
through the existing default classification dataset rather than a second list.

## 5. A session enforces a snapshot

The compiled blocking config is stored on the session
(`focus_sessions.blocking_config`) when it starts and is what gets re-acquired
after a lost lease or a restart. Editing a profile during a session changes
future sessions only.

## 6. The countdown counts active work; pausing stops it

A countdown ends when active work (`elapsedMs`) reaches the planned duration.
Manual pauses, idle time, sleep and time the app was not running are not
active work: they stop the timer and push the end back by the same amount, so
a paused timer shows a frozen number and a 25-minute session is always 25
minutes of work. Pausing cannot shorten the commitment, and it never releases
blocking — so it is not a way around Focus either.

(An earlier version ran the countdown on the wall clock, so the number kept
falling while paused. That read as a broken pause and was changed.)

**Completion is produced by the backend.** `FocusService` completes the
session when the remaining time reaches zero — with the window hidden or not.
A paused session never completes; it waits to be resumed. The renderer derives its display
from the session's timestamps and never reports expiry.

**Expiry behaviour.** The old `continue | ask | stop-blocking` preference was
removed: reaching zero completes the session and releases blocking. A
commitment that has been fulfilled should not keep blocking.

## 7. Ending early needs a service-issued challenge

`requestEnd` returns a token (and, for a countdown with time left, the phrase
to type). `confirmEnd` is the only way to end a session and verifies both.
There is no `stop` method on the service and no IPC channel that sets a
session's state, so the renderer, the tray and keyboard shortcuts all go
through the same flow. A stopwatch has no planned end, so finishing it needs
the confirmation but not the phrase.

How a session ended is recorded in `end_reason`:

| end_reason  | state     | meaning                                         |
|-------------|-----------|-------------------------------------------------|
| completed   | completed | countdown ran its whole planned duration        |
| finished    | completed | stopwatch deliberately ended                    |
| ended-early | cancelled | countdown ended before its planned end          |
| abandoned   | cancelled | app went away and the session was not resumable |

## 8. Idle comes from real input, not window polling

Idle detection uses `powerMonitor.getSystemIdleTime()`. The tracker's window
polling reports a foreground app every second whether or not anyone is at the
machine, so it could neither detect idleness nor a return. An idle pause is
back-dated to when input stopped. Only an idle pause auto-resumes; a manual
pause waits for the user — including after a restart (the kind is recovered
from the interruption log).

## 9. One operation queue

Every mutating operation (start, pause, resume, end, expiry, recovery,
shutdown) runs on a single promise queue in `FocusService`, so they cannot
interleave across the awaits around the blocking manager. Start is
transactional: the session is persisted as `planned`, becomes `active` only
after blocking is confirmed, and is deleted if blocking cannot be acquired.
The start screen then offers "Try again" or "Start without blocking"; the
latter starts a session that enforces nothing and reports blocking as off.

## 10. Startup recovery policy

| Found on startup                                              | Result                               |
|---------------------------------------------------------------|--------------------------------------|
| `planned` (never started)                                     | removed                              |
| countdown, back within the time it had left                   | restored, blocking re-acquired       |
| countdown, running with ≤ 2 min left when last seen           | completed                            |
| countdown, away longer than it had left                       | abandoned at last-seen               |
| stopwatch last seen ≤ 2 min ago                               | restored, blocking re-acquired       |
| stopwatch older                                               | abandoned at last-seen               |

Quitting the app (or Windows shutting down) releases blocking but leaves the
session open, so this policy decides on the next launch. While Focus is
running the tray's Quit entry opens the exit flow instead of quitting.

If Reflect's entries are found in the hosts file with no session to own them
(a crash plus power loss), the app says so and offers to remove them — that
needs elevation, so it is not done silently.

## 11. Blocking is edited per preset, in human terms

The UI never shows the rule pool. `focus:addBlock` normalizes what the user
gave ("https://www.youtube.com/watch…" → `youtube.com`, "Discord" →
`discord.exe`, "social" → `social-media`), reuses an equivalent block if one
exists, and switches it on for the preset being edited — one step, no
duplicates. `focus:setProfileBlock` switches a block off for one preset
without deleting it. A preset's `blocksDistractions` flag is derived: it is on
exactly when a block rule is attached.

Apps are offered from the windows that are open right now
(`active-win.getOpenWindows`) and sites from the last day of tracked visits,
so nobody has to know an executable name. Rules carry a display label
(`Discord`, `Social media`) computed in the main process.
