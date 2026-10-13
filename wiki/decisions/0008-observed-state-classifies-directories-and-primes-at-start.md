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
it fails open, and every failure degrades toward an extra bump rather than
toward staleness (the pre-`start()` window and the round-trip known limit
below excepted). This record adds two things ADR-0002 did not cover.

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
fails open. So a `Fingerprinter` is not called with a directory, except when
`lstat` itself fails: the path then reaches the fingerprinter, which fails
open.

`isChanged` on a path that is now a directory:

| Stored entry | Result |
|---|---|
| directory marker with the same identity | unchanged |
| directory marker with a different identity, or a directory/link flip | the old subtree is dropped, then evaluated as in the last row; **changed** if a live file was dropped or the kind flipped |
| live file | changed (a file was replaced by a directory) |
| none, or recorded absent | changed, unless the path lies under a primed root, the ledger is not lossy and it is not a link; then every file beneath it is evaluated and the directory is changed only if one of them is |

On a path that is now a file or missing, a stored directory marker drops every
entry beneath it, and the result is changed if the path is now a file, a
dropped entry was a live file, the ledger is lossy, the marker was a link, or
the marker was not `scanned`. The directory/link flip rule was added during
implementation rather than designed up front; it fails toward an extra bump.

**A marker stores identity and a `scanned` flag.** Code review found two more
routes to a missed change, and each needed state the first design lacked.

- *A directory swapped by rename.* Two renames that replace a directory, with
  the events handled after both (classification sees only the final state),
  left a known marker on a path that was still a directory, which read as
  unchanged. The marker now stores the directory's identity: its inode from
  the `lstat` that classification already makes. Only a marker with the same
  identity is unchanged; a different one drops the old subtree and evaluates
  the new directory like a never-seen one. An inode of 0 means unknown and
  never matches, so a filesystem without usable inodes re-evaluates every
  directory event (see Consequences).
- *A directory moved in by a self-write.* Layers 1 and 2 `record()` every
  suppressed path, and `record()` stored a directory without its children. An
  atomic install that renames a staging directory into place inside
  `suppress()` therefore left a childless marker, and moving it out later
  dropped nothing live and read as unchanged. A marker now has a `scanned`
  flag, true when its children are known: created by `prime`, by a vouched
  scan, or the directory was empty when recorded. An unscanned marker whose
  directory goes missing or becomes a file reports changed.
- *Nothing to compare against.* With no marker (never seen, or evicted while
  its children survived), the vouched scan now also drops recorded files it
  did not find and reports that as a change; otherwise a swap that removed a
  file while the marker was evicted would match the surviving fingerprints.

Entries are indexed by parent, so dropping a subtree walks that subtree rather
than the whole ledger. Without the index each new-file event scanned every
entry.

**Descendants are dropped whenever a path stops being a live file.** Code
review found a missed change: a directory marker could leave the ledger
(`forget(dir)`, LRU eviction of the marker, or `record()` of a directory that
had become a file or gone missing) while its children's entries survived.
Moving that directory out and back in with identical files then scanned as
"never seen", matched the orphaned fingerprints and read as unchanged. So
when a path is a file or missing and its stored entry is not a live file
(none, `"absent"`, or a directory marker), `isChanged` and `record` drop every
entry beneath it, and `isChanged` reports changed if a dropped entry was a live
file. An ordinary modify of a known live file skips the drop, so it stays O(1).
`forget(path)` now removes the path and everything beneath it, an observable
change from removing only the key.

Evicting a directory marker deliberately does **not** set the ledger lossy: a
marker holds no content, and lossy would make every later directory scan
unvouched. Staleness is still prevented because the orphaned children are
dropped by the next file-or-missing event on that path, and the next event on a
still-present directory is decided by the scan (when the ledger vouches for it)
or reports changed. "An evicted path reports changed again" is therefore true
of files; for a directory it is the scan or a changed report.

**`prime(roots)` builds a baseline.** It walks the roots, recording directories
and links as markers and files as fingerprints. It fills gaps only (an existing
entry is never overwritten), never throws, and does not descend into links. The
ledger turns **lossy** when a directory cannot be read, a fingerprinter throws,
or an eviction drops an entry holding a real fingerprint. Lossy never clears,
and a lossy ledger stops vouching for never-seen directories. `PrimeSummary`
reports `files`, `directories` and `complete`.

`prime` also reconciles stale entries. An existing entry whose kind, identity
or link flag conflicts with the disk (a path recorded as a file that became a
directory while no watcher ran, on a ledger shared across watchers) has its
subtree dropped and what is on disk recorded; otherwise a later move-out and
move-back with identical content would read as unchanged. An entry of the same
kind and identity is still never overwritten.

A dropped link marker counts as a dropped live entry, so removing a directory
that holds only a junction reads as changed, consistent with removing the
junction itself. Keys are POSIX-normalized with trailing slashes stripped, so
`D/` and `D` are one key.

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
incomplete baseline is logged and degrades to today's extra bumps rather than a
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

This table is a subset: 10 of the 18 scenarios measured. The other eight (a
nested read, deleting a file, `rm -r` of a non-empty directory, a directory
replaced by a file, moving an empty directory in, renaming a directory within
the tree, a self-write via `expect()`, reading through a junction) measured 0
or 1, except the rename, which measured 2 as expected: one directory leaving
and one arriving.

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

Directory identity, measured on the same machine (Windows 11, NTFS) with a
throwaway probe: a directory's inode stays the same across listing it, reading
files in it, and writing or deleting files in it; a directory renamed into
place has a different inode; a directory renamed elsewhere keeps its inode.
Linux and macOS were not measured.

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
- **A write between a consumer's own read of the tree and `start()` is not
  reported.** It becomes part of the baseline. Start the watcher before reading
  the tree.
- **A never-seen directory under a primed root is scanned on the event path.**
  Its files are hashed synchronously when the event arrives, at a cost
  proportional to that subtree and separate from the `start()` cost.
- **Observable output changes, so this ships as a minor bump, 0.11.0.** A
  `^0.10.0` caret resolves as `>=0.10.0 <0.11.0` and does not reach it;
  consumers widen their range deliberately.
- **Paths from a custom `watcherFactory` must match the
  `toPosixPath(path.resolve(...))` key form.** Otherwise they never match a
  ledger entry and fall back to never-seen bumps, which fails open.
- **Event loss on OS buffer overflow is a pre-existing gap**, not addressed
  here.
- **Linux and macOS directory-event shapes were not measured**, nor was their
  inode behaviour. The design classifies the path when the event is handled, so
  it does not depend on event shapes.
- **Without inodes, directory events bump.** Where the inode is 0 or absent,
  identity is unknown and never matches, so every directory event re-evaluates
  the directory: it drops the old subtree and scans the new one. That means
  extra bumps and O(subtree) cost per event, and a recorded directory's
  repeated events will bump rather than read as unchanged (the measured
  quiet-listing result does not hold on such a volume). Not measured; no such
  volume was available.
- **Path spelling is part of the key.** The ledger is keyed by the path string
  (POSIX-normalized, trailing slashes stripped). A caller mixing spellings of
  one path, such as drive-letter case (`C:` versus `c:`) on Windows, gets
  separate keys and can miss a change. `OptimisticWatcher` uses one spelling
  for priming and events, so this needs a caller that mixes spellings or two
  watchers sharing a ledger. It is the pre-existing behaviour of a
  string-keyed ledger.
- **Known limit: a directory renamed out, edited, and renamed back reads as
  unchanged.** If a directory is renamed out of the watched tree, changed
  outside it (a file edited, added or removed), and renamed back to the same
  path before the watcher handles the move-out event (for example in one
  synchronous block, since `fs.watch` callbacks run afterwards), it keeps its
  inode. The same-identity rule skips any child comparison, and the edit
  happened outside the root, so no file event arrives. If the move-out event
  is handled before the move-back, the change is caught (measured). Closing it
  would mean re-hashing a directory's subtree on every directory event, and
  on Windows listing a directory fires one, which is the read-only hot path
  this record exists to keep quiet. It is deliberately not done;
  [#29](https://github.com/GenvidTechnologies/mcp-utils/issues/29) tracks it.
- **Known limit: identity is only as good as the filesystem's inode reuse.** A
  filesystem that hands a deleted directory's inode straight to a directory
  created in its place would let a swapped-in directory pass as the recorded
  one. That is plausible on filesystems that recycle inode numbers eagerly,
  but it was not measured on any filesystem here. The swap is caught only
  when the inode differs, so this is a limit of the check, not a claim that it
  occurs.

## Related

- [0002. ObservedState collapses duplicate watch events](0002-observed-state-collapses-duplicate-watch-events.md) — the record this refines.
