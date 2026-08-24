# 0002. ObservedState collapses duplicate watch events

- **Status:** accepted
- **Date:** 2026-08-15
- **Issue:** [#12](https://github.com/GenvidTechnologies/mcp-utils/issues/12)

## Context

`OptimisticWatcher` already suppresses self-triggered `fs.watch` events on two layers:
a synchronous `suppress(fn)` window (L1) and `expect(path)` pre-registration backed by
`ExpectedChanges` (L2, `consume()` is check-and-remove — single-shot,
`src/expectedChanges.ts:41`). Every event that survives both layers calls `bump()` and
forwards to `onExternalChange`.

Measured on Windows 11 / NTFS / node v24.11.1, against the real filesystem and the real
`OptimisticWatcher` with its default `fs.watch` factory: a single `fs.writeFileSync`
consistently delivers **two** `fs.watch` events, 1.9–3.9 ms apart (6/6 runs). For a
**create**, the pair is `rename` then `change` — distinguishable. For an **overwrite** of
an existing file, the pair is `change` then `change`, identical on `filename`, `size` and
`mtimeMs` — nothing in the event itself tells the two apart.

The result, measured against current code:

| Scenario | `txId` delta | Wanted |
|---|---|---|
| external create | 2 | 1 |
| `expect()`-then-write self write | 1 | 0 |
| external overwrite | 2 | 1 |
| four distinct external writes, 200 ms apart | 8 | 4 |

L1 cannot be the fix: `suppress()` is async and unwinds `suppressDepth` in a `finally`,
while `fs.watch` delivers asynchronously, so L1 is always back to `0` before either event
of a pair arrives.

L2 cannot be the fix either, and the reason is worth stating precisely because it rules
out the obvious repair. For a **self** write, `expect()` registers the path, event 1's
`consume()` matches and deletes the entry, and event 2 finds nothing — so it falls through
and bumps. Making `consume()` multi-shot would fix exactly that case. But for an
**external** write nothing was ever registered, so `consume()` returns `false` for *both*
events and both reach `bump()` — there is no entry for a multi-shot `consume()` to keep.
The external double-bump is therefore not a `consume()` defect at all, which the measured
external-overwrite delta of 2 confirms.

The problem both existing layers answer is "was *this event* one we caused?" — a
question about timing and provenance. The duplicate-bump problem needs a different
question: "does the file now hold something other than what was already accounted for?"
— a question about the *file's content*, with no timing term.

## Decision

Add a third suppression layer, `ObservedState` — a path → content-fingerprint ledger.
`isChanged(path)` is check-and-record, mirroring `consume()`'s check-and-remove: it
compares the current fingerprint against the last recorded one, records the new
fingerprint either way, and returns whether they differed. Two consecutive events over
the same unchanged content therefore report change only once; a real change in between
still reports change. `ExpectedChanges` is unmodified and neither existing layer's
suppression logic changes — `ObservedState` sits alongside them as an additional gate
before `bump()`, not a replacement for either.

L1 and L2 do gain one line each: when either suppresses an event, it also `record()`s
that path's fingerprint. This is load-bearing rather than incidental. Suppressing a
self-write without recording it would leave the ledger holding whatever preceded the
write, so the *duplicate* of that self-write would read as a genuine change at L3 and
bump — which is the bug, relocated one layer down. Recording at the point of
suppression is what seals a self-write as accounted for.

The default fingerprint is a content hash, not `stat`-derived. A `size:mtimeMs`
fingerprint was measured to collide 12/200 (6%) on distinct same-size back-to-back
writes in a tight stat-only loop, and 0/60 once writes were spaced at least 1 ms apart —
collision-free only under a timing assumption, which is the same defect this layer
exists to remove. Fingerprinting is pluggable: a `Fingerprinter` seam lets a consumer
supply its own three-line function and own whatever tradeoff it prefers. No
`stat`-derived fingerprint is shipped at all — not exported, and not implemented
internally (see Compromise).

## Compromise

**Rejected: make `ExpectedChanges.consume` multi-shot.** Fixes only the self-write path.
The external path never consults `ExpectedChanges`, so the external-overwrite case
(measured: still 2 bumps) is untouched.

**Rejected: discriminate on the event.** Works for create (`rename` vs. `change`) but not
overwrite, where both events are `change` and identical on every field Node exposes. A
fix that only handles create leaves the more common case — editing an existing file —
unfixed.

**Rejected: a time window / debounce.** The gap measured here was 1.9–3.9 ms, on a machine
different from the one behind issue #12's original report, and the two reports do not
agree — issue #12's own body has been corrected to reflect that its original figures did
not reproduce. A window tuned to either measurement is calibrated to one machine, which
is exactly the failure mode a sound fix must avoid.

**Rejected: ship the `size:mtimeMs` fingerprint as the default** (or export it as a
documented perf opt-in, as originally proposed). Every collision is a **silently missed
genuine change** — staleness, the one failure mode the optimistic-concurrency contract
exists to prevent. 6% is well below the figure originally cited for this proposal (that
figure did not reproduce and has been corrected in issue #12's body); the corrected rate
is still disqualifying for a primitive whose job is correctness, not speed. No
`stat`-derived fingerprint is implemented here at all: exporting one as a sanctioned
choice would mean publishing a collision figure to justify it, and the figure that
motivated proposing it in the first place was overstated by roughly an order of
magnitude. A consumer that wants that tradeoff can write the equivalent three-line
`Fingerprinter` and own it explicitly, which is what the seam is for.

**Fail-open asymmetry, by design.** Every residual imprecision in `ObservedState` degrades
toward an *extra* bump — today's status quo — never toward staleness: a partial-write
hash mismatches the prior fingerprint and bumps; a file that fails to read gets a unique
per-failure token and bumps; an entry evicted from the ledger's bounded cache bumps on
its next event, exactly as if it were being observed for the first time. The single case
that does *not* bump is an external writer restoring byte-identical content, which is
benign by construction — a consumer re-reading the file gets exactly what it already
believes it holds.

**Hashing cost.** Content hashing is not free, though this session did not measure it
directly; issue #12 cites (claimed, not independently verified this session) roughly
105.6 µs at 2 KB, 190.3 µs at 32 KB, and 577.9 µs at 512 KB per event. This is accepted as
the cost of a correctness-preserving default; a consumer for whom this matters can supply
a cheaper `Fingerprinter`.

**No Windows CI leg.** The shared reusable workflow this repo's CI depends on
(`public-github-actions`, per `CLAUDE.md`) runs a single OS
(`node-gate.yml:17: runs-on: ubuntu-latest`, per issue #12 — not independently confirmed
this session) with no OS input, so adding a Windows leg would mean changing a third
repo's shared recipe. `watcherFactory` and `Fingerprinter` are both injectable seams
specifically so the behavioral tests exercising this feature are platform-independent
rather than dependent on real `fs.watch` semantics, which is what made the Windows-only
measurement in this record necessary in the first place.

## Consequences

- **Ships on by default.** `ObservedState` is active unless a consumer opts out with
  `observed: null`. Because this changes the observable output of an existing exported
  API (fewer duplicate `onExternalChange` calls / `txId` bumps per genuine change) with
  no signature break, it ships as **0.7.0**, a minor bump, per `CLAUDE.md`'s
  version-choice rule — the same reasoning applied to `walkFiles`' 0.6.0 release
  (see [ADR-0001](0001-walkfiles-returns-only-regular-files.md)).
- A consumer that was relying on two bumps per external write (unlikely, but possible if
  something counted `txId` deltas as an event-count proxy rather than a change-count
  proxy) sees that count roughly halve. No such consumer is currently known.
- `ObservedState`'s ledger is bounded (LRU-evicted), so long-running watchers over large
  trees do not grow it unboundedly; the cost of eviction is an occasional extra bump,
  not a correctness gap (see fail-open asymmetry above).
- If a future caller needs a cheaper-than-hash fingerprint and accepts the collision
  risk, that is a matter of supplying a custom `Fingerprinter`. Should a maintainer later
  decide this package should ship one itself, that decision needs its own freshly measured
  collision figure — not a re-litigation of this one, and not the figure from issue #12's
  original body, which did not reproduce.
