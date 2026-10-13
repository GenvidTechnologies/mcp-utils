---
type: decision-context
title: 0008. ObservedState classifies directories and primes a baseline at start
description: Why `ObservedState` classifies each path so directory events stop bumping `txId`, why `OptimisticWatcher.start()` primes a baseline once, and why a watcher-side filter and a custom fingerprinter were rejected.
tags: [optimisticwatcher, observedstate, fs-watch, decision]
status: stable
generated: { by: human:ninoles, at: 2026-10-13T00:00:00Z }
sources:
  - id: issue-27
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/27
    title: "#27 — read-only activity and directory events bump txId"
    last_modified: 2026-10-13
  - id: chef-issue-284
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/284
    title: "construct3-chef#284 — the consumer that reported the spurious bumps"
    last_modified: 2026-10-13
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0008. ObservedState classifies directories and primes a baseline at start

- **Status:** accepted
- **Date:** 2026-10-13
- **Issue:** [#27](https://github.com/GenvidTechnologies/mcp-utils/issues/27); consumer [construct3-chef#284](https://github.com/GenvidTechnologies/construct3-chef/issues/284)

## Context

This record **refines** [ADR-0002](0002-observed-state-collapses-duplicate-watch-events.md);
it does not supersede it. What ADR-0002 decided still holds: the default
fingerprint is a content hash (never `size`+`mtime`), L1 and L2 suppressions
also `record()` into the ledger, an unreadable file produces a unique token so
it fails open, and every failure degrades toward an extra bump, never toward
staleness. This record adds two things ADR-0002 did not cover.

On Windows with last-access updates enabled, a recursive `fs.watch` reports
events that are not content changes:

- **Directory events.** Listing a directory fires one.
- **First-read events.** The first read of a file fires an access-time event.

Through the default stack both read as content changes. A directory reaching
`readFileSync` raises `EISDIR`, which `contentFingerprint` turns into a unique
`error:N` token that never matches anything. A file the ledger had never seen
had no prior entry, and `isChanged` treats "never seen" as changed. So a
read-only tool moved `txId`.

## Decision

**The ledger classifies each path before fingerprinting it.** `lstat` runs
first. A directory is a `dir` marker. A symlink or junction that resolves to a
directory is a `dir` marker flagged as a link. Anything else, including any
error while classifying, falls back to "file", so the fingerprinter is what
fails open. No `Fingerprinter` is ever called with a directory.

`isChanged` on a path that is now a directory:

| Stored entry | Result |
|---|---|
| directory marker | unchanged; a directory-to-link or link-to-directory flip is **changed** |
| live file | changed (a file was replaced by a directory) |
| none, or recorded absent | changed, unless the path lies under a primed root, the ledger is not lossy and it is not a link; then every file beneath it is evaluated and the directory is changed only if one of them is |

On a path that is now a file or missing, a stored directory marker drops every
entry beneath it, and the result is changed if the path is now a file, a
dropped entry was a live file, the ledger is lossy, or the marker was a link.
The directory/link flip rule was added during implementation rather than
designed up front; it fails toward an extra bump.

**`prime(roots)` builds a baseline.** It walks the roots, recording directories
and links as markers and files as fingerprints. It fills gaps only (an existing
entry is never overwritten), never throws, and does not descend into links. The
ledger turns **lossy** when a directory cannot be read, a fingerprinter throws,
or an eviction drops an entry holding a real fingerprint. Lossy never clears,
and a lossy ledger stops vouching for never-seen directories. `PrimeSummary`
reports `files`, `directories` and `complete`.

**`OptimisticWatcher.start()` primes once per instance, after creating the
watch handles.** `fs.watch` callbacks run on the event loop, so none fire during
the synchronous walk. A write landing before the walk reaches its file is
already in the stored fingerprint; one landing after compares unequal and bumps.
Priming before watching would leave a window in which a write is never
reported. A restart does not re-prime. The summary is logged, with a separate
line when the baseline is incomplete. The L1/L2 `record` calls are now guarded
so a throwing fingerprinter cannot escape `handleEvent`.

**`observed: null` is unchanged.** Every event not suppressed by L1/L2 bumps,
including directory and first-read events, and no baseline is taken. The reason
not to bolt a directory filter onto that mode: a filter without a ledger cannot
detect a file replaced by a directory, because every event for that path
already reads as a directory when it is delivered.

**`maxEntries` stays at 1000.** Size it to at least files plus directories. An
incomplete baseline is logged and degrades to today's extra bumps, never to a
missed change. There is no `prime: false` option. Adding an option or raising
the default later is additive, and consumers' tree sizes are unknown.

### Why "skip directory events" is wrong

A plain rule that ignores directory events misses real changes. Measured on
Windows during design: moving a non-empty directory into the tree fires events
only for the directory and its parent, none for the file inside; moving one
out fires one event for the directory; a file replaced by a directory delivers
every event already classified as a directory. Each would be a missed change.
The ledger has to remember what was beneath a directory to report these.

### Measurements

Measured on one Windows machine (Windows 11, Node 24.11.1, last-access updates
enabled), real watcher, default `fs.watch` factory, aged tree, two runs
identical. `txId` delta per scenario, before this change then after. The
"before" figures come from the design-time probe at f8b12a0 and were not re-run;
the "after" figures were re-measured with the shipped code.

| Scenario | Before | After |
|---|---|---|
| list a directory twice | 1 | 0 |
| first read of a pre-existing file | 2 | 0 |
| modify a file | 2 | 1 |
| create a file | 3 | 1 |
| create an empty directory | 3 | 0 |
| remove an empty directory | 1 | 0 |
| replace a file with a directory | 4 | 1 |
| move a non-empty directory in | 2-3 | 1 |
| move a non-empty directory out | 1 | 1 |
| create a junction in the tree | 4 | 1 |

`start()` now costs a synchronous walk and hash (first run on a newly written
tree / second run): 1000 files of 2 KB, 170 / 134 ms; 1000 of 32 KB, 1709 /
216 ms; 5000 of 2 KB, 705 / 585 ms; this repo's `src`, `test` and `wiki` (49
files, 2 directories), 12 ms. The first-pass slowness on freshly written files
is not isolated; antivirus scanning is a possibility, not an established cause.

## Compromise

**Option A (recommended): directory-aware ledger plus a start-up baseline.**
Chosen. One new public method, `prime`, and every directory rule lives in one
class where standalone `ObservedState` users get it too.

**Option B: filter in the watcher.** Rejected. It needs new public methods on
`ObservedState` (something like `has`, `peek`, `forgetUnder`, a lossy getter)
so the watcher can decide. The directory rules end up split across two
classes, standalone `ObservedState` users don't get them, and the public
surface is larger than A's single `prime`.

**Option C: change the fingerprinter.** Rejected. It is the smallest diff, but
the default fingerprinter is not the only one in use: a custom fingerprinter
keeps today's behaviour. A new directory would still bump once, because it has
no prior entry, and it does nothing for the first read.

Alternatives weighed and rejected for the first-read part:

- **Compare modification time with start time on first sight.** Stale under
  mtime-preserving tools (`cp -p`, `tar`, `unzip`, `rsync -t`), and it
  reintroduces a timing term that ADR-0002 argued against.
- **Record on first sight without bumping.** Misses the first external edit of
  a never-seen file.
- **Prime per directory when its first event arrives.** The baseline would be
  taken after the content may already have changed.

## Consequences

- **`start()` does a synchronous walk-and-hash** of every watched tree, once per
  instance. See the measurements above for cost.
- **Observable output changes, so this ships as a minor bump, 0.11.0.** A
  `^0.10.0` caret resolves as `>=0.10.0 <0.11.0` and does not reach it;
  consumers widen their range deliberately.
- **Paths from a custom `watcherFactory` must match the
  `toPosixPath(path.resolve(...))` key form.** Otherwise they never match a
  ledger entry and fall back to never-seen bumps, which fails open.
- **Event loss on OS buffer overflow is a pre-existing gap**, not addressed
  here.
- **Linux and macOS directory-event shapes were not measured.** The design
  classifies the path when the event is handled, so it does not depend on them.

## Related

- [0002. ObservedState collapses duplicate watch events](0002-observed-state-collapses-duplicate-watch-events.md) — the record this refines.
