# A fix that preserves an invariant opens a new route around it — captured 2026-10-13

Session-local capture from the `#27` (ObservedState directory events and start-up
baseline) implementation and review run. Recorded the same day. There is no
public upstream for the session transcript. The reproductions lived in the
session scratchpad and were discarded, so this file is their only record. Every
commit named below is on branch `feat/observedstate-directory-baseline`, and the
behaviour it describes is re-runnable from those commits.

Environment: Windows 11, Node 24.11.1, `@genvidtech/mcp-utils` at `0.10.0`
(+ unreleased branch), `gvt-dev` plugin cache `4.34.0` then `4.35.0`.

---

## 1. The invariant

`ObservedState` (the content-fingerprint ledger behind `OptimisticWatcher`'s
Layer 3) has one rule every design decision on this branch defers to: an
imprecision must degrade toward an **extra** `txId` bump, never toward a
**missed** change (ADR-0002, restated in ADR-0008).

## 2. The fix

Round 3 of code review (HEAD `74d81a2`) reported **W-1**. On a ledger shared
across watchers, a path recorded as a file and later replaced by a directory,
while no watcher ran, kept its stale file entry through a second `prime()`. A
later move-out and move-back with identical content then read as unchanged.

Commit `b7d58f4` fixed it by **reconciling** in `prime()`'s walk. An existing
entry whose kind, identity or link flag conflicted with the disk was treated as
stale: its subtree was dropped and the on-disk state recorded in its place.
Test O44 was written for it and asserted the reconciliation: after the second
`prime()`, `isChanged(D)` returns `false`.

## 3. Every gate passed

At HEAD `169888d` (`b7d58f4` plus docs):

- `npm run lint && npm run typecheck && npm run test && npm run build`: exit 0,
  332 passing, 1 pending.
- Mutation harness: 26 mutations, all caught, with the no-op control clean.
  The reconcile's own mutation (M24, "prime keeps a conflicting entry") was
  caught by O44.
- Windows end-to-end run against the real `fs.watch`: 18 of 18 scenarios
  matched the design.
- `gvt-dev:validator` round 4: Overall PASS on every behavioural row.

## 4. What the fix broke

The round-4 `gvt-dev:code-reviewer` modelled something no earlier check had:
**two watchers sharing one ledger, with one watcher's events still queued.** Its
reproduction used two `OptimisticWatcher`s, an injected factory that held watcher
A's events back, and one shared `ObservedState`:

1. Watcher A starts and primes the tree. An event for path P is pending.
2. P changes from a file to a directory.
3. Watcher B starts. Its `prime()` reconciles P, recording the directory.
4. A's queued event for P is dispatched. It compares equal to the freshly
   recorded state, and **A's `txId` does not move**.

Measured: at HEAD (with the reconcile), A's `txId` delta was **0**. The same
script against `74d81a2` (before the reconcile) gave **1**. The fix had turned
an extra bump into a missed change. A second route with the same root cause
(B's `prime()` recording a file created between the two starts) also gave 0.

The test written for the fix, O44, **asserted the regressed behaviour**, so the
suite actively defended the bug.

## 5. Resolution

Commit `5d0dc8e` reverted the reconciliation. `prime()` now never overwrites an
entry, never descends into a conflicting one, and skips any subtree already
under a primed root. W-1 turned out to have been caused by `prime()`
*descending* into a directory recorded as a file, not by the stale entry
itself. O44's expected value was inverted, with the reason given in the commit.
Tests W21/W22 pin the two-watcher routes (A's delta 1).

Later commits added `test/observedState.fuzz.test.ts` (`1037623`), a seeded
random-sequence test against ground truth. Run against the mutation harness, it
catches 7 of 29 mutations by itself.

## 6. Why no gate saw it

- The suite, the mutation harness and the end-to-end run each check the
  scenarios and rules someone wrote down. None of them modelled concurrent
  watchers on one ledger, so none could see a route that exists only there.
- A mutation harness proves that each *existing* rule is pinned. It cannot
  notice that a new rule broke an *unlisted* property. M24 being caught by O44
  confirmed the reconcile was pinned, exactly as written.
- The test authored with the fix encoded the fix's assumption. A green O44 was
  evidence that the code did what the fix intended, not that the intention was
  safe.
