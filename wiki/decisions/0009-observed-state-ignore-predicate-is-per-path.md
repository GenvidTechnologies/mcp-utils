---
type: decision-context
title: 0009. ObservedState ignore predicate decides per path and does not prune
description: Why `ObservedState` takes a per-path `ignore` predicate that receives the normalized ledger key, why entries beneath an ignored path are still evaluated, why a throwing predicate counts as not ignored, and why pruning ignored directories was rejected.
tags: [observedstate, optimisticwatcher, ignore, decision]
status: stable
generated: { by: human:ninoles, at: 2026-11-04T00:00:00Z }
sources:
  - id: issue-35
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/35
    title: "#35 — a newly created editor-local file in a watched subfolder still bumps txId"
    last_modified: 2026-11-04
  - id: chef-issue-299
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/299
    title: "construct3-chef#299 — the consumer that reported the bump"
    last_modified: 2026-11-04
  - id: chef-issue-298
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/298
    title: "construct3-chef#298 — a consumer that wants the same predicate to exclude a whole directory"
    last_modified: 2026-11-04
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0009. ObservedState ignore predicate decides per path and does not prune

- **Status:** accepted
- **Date:** 2026-11-04
- **Issue:** [#35](https://github.com/GenvidTechnologies/mcp-utils/issues/35); consumer [construct3-chef#299](https://github.com/GenvidTechnologies/construct3-chef/issues/299)

## Context

This record **extends** [ADR-0008](0008-observed-state-classifies-directories-and-primes-at-start.md);
it does not supersede it. The directory classification, the ctime re-check and
the start-up baseline described there still hold.

construct3-chef watches source folders in which Construct 3 writes editor-local
files. Since mcp-utils 0.12.0, chef fingerprints those files as `"absent"`, so
an atomic save or a delete of one reads as unchanged.

A *newly created* editor-local file in a watched subfolder still bumped `txId`:

1. The subfolder's ctime moves.
2. The directory event re-checks the subtree.
3. `isChanged` reports the never-seen path as changed (`prev === undefined`)
   before any fingerprint is compared.

No consumer hook reaches that walk. chef pins the behaviour with its
characterization test MU12-D11. construct3-chef#298 wants the same predicate to
exclude a whole directory.

## Decision

**`ObservedState` takes `ignore?: (filePath: string) => boolean`.** The default
is no predicate, and behaviour without one is unchanged.

**The predicate decides each path on its own; ignored directories are not
pruned.** `prime` and the child walk that `record` and the re-check use still
descend into an ignored directory and filter its files one at a time, so
`walkFiles` is unchanged. An ignored path never gets an entry, is never
fingerprinted, and does not count toward `maxEntries`.

**Entries beneath an ignored path are still evaluated.** This follows from the
per-path rule. Take a predicate that ignores directory `D` but not `D/x`. If `D`
is renamed out, `D/x` is edited and `D` is renamed back, the only event arrives
on `D`. Reporting "unchanged" for `D` would miss the edit. So:

- `isChanged` on an ignored directory under a primed, non-lossy root evaluates
  its non-ignored subtree.
- An ignored path that is now a link, a file, or missing drops every entry
  beneath it, and `isChanged` reports changed if a live entry went, or while
  the ledger is lossy. With no marker,
  the ledger cannot know the path was a directory whose unrecorded children are
  gone. `record` on an ignored file, link or missing path drops what is beneath
  it; on an ignored directory it re-records the non-ignored subtree silently.
- When the ledger cannot vouch for an ignored directory (it is lossy, or the
  directory is outside a primed root), `isChanged` re-records the children
  silently and reports changed. This is the module's fail-open direction.

The fail-open branch came out of the fuzz. An earlier version reported changed
only when the walk found a file or dropped a live entry. On a lossy ledger whose
entries had been evicted, that missed a change: seed 26, `maxEntries` 5,
`rmdir cb; mkdir cb`. Test O79 pins it.

**The predicate receives the normalized POSIX ledger key**: forward slashes,
trailing slashes stripped. A walk (`path.join`, backslashes on Windows) and an
event can produce different spellings of one path. The predicate sees one, so
its decision cannot differ between the two.

**A throwing predicate counts as not ignored.** The path is then tracked, which
costs an extra bump and never a missed change. It also keeps the rule in
`CLAUDE.md` that a caller-supplied callback must not escape a helper.

**`OptimisticWatcher` gets no new option.** Pass
`observed: new ObservedState({ ignore })`. With `observed: null` there is no
ledger, so the predicate does not apply.

## Compromise

**Prune ignored directories.** Rejected. Walks would not enter an ignored
directory, so a large ignored tree (`node_modules`, a construct3-chef#298
`extractedDir`) would cost nothing to walk. Three things count against it:

- It requires that an ignored directory implies an ignored subtree. The
  per-path rule above does not assume that.
- It needs either a directory filter on the public `walkFiles`, which has none
  and always recurses, or a private walk that duplicates `walkFiles`'
  regular-file rules.
- The cost is unmeasured for the consumer at hand. chef's editor-local
  predicate matches by path segment, and `uistate/` is small.

Pruning can be added later behind the same option.

**Hand the predicate the path as received.** Rejected. One path could then reach
the predicate in two spellings, and a string-based predicate could ignore it on
one side and not the other. That gives extra bumps.

**Treat a never-seen path with an `"absent"` fingerprint as unchanged.**
Rejected. It would take over the fingerprinter's sentinel for every consumer
and change default behaviour.

## Consequences

- The default is unchanged. A consumer that passes no predicate sees no
  difference.
- Every event on an ignored directory walks its subtree: a `readdir` per
  directory, plus a `stat` only for an entry that is not a plain file and that
  the predicate does not ignore. Ignored entries are never stat'd or hashed
  there. `prime`'s walk still `lstat`s every entry to classify it, but never
  hashes an ignored one.
- A never-seen directory under a primed root that holds only ignored files
  reads as unchanged.
- The fuzz, `test/observedState.fuzz.test.ts`, covers the predicate: O77 uses a
  closed predicate and O78 a non-closed one. It checks that no change to
  non-ignored content is missed, and that no ledger key satisfies the
  predicate.
- This ships as a minor release, because it adds to the public API. Below 1.0.0
  a caret range allows patch updates only, so a consumer pinned to `^0.12.0`
  does not receive it until they widen the range.

## Related

- [0008. ObservedState classifies directories and primes a baseline at start](0008-observed-state-classifies-directories-and-primes-at-start.md) — the record this extends.
- [0002. ObservedState collapses duplicate watch events](0002-observed-state-collapses-duplicate-watch-events.md) — the fail-open direction every ledger rule follows.
