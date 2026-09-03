---
type: decision-context
title: 0007. parseTxToken returns a discriminated result with a parse-failure reason
description: Why `parseTxToken` returns `{ ok: true; projectId; n } | { ok: false; reason }` with a five-member `TxTokenParseFailure` union instead of bare `null`, and why a three-member union, an additive `parseTxTokenDetailed` sibling, and an exported predicate trio were all rejected.
tags: [txtoken, wire-format, decision]
status: stable
generated: { by: human:ninoles, at: 2026-09-03T00:00:00Z }
sources:
  - id: issue-25
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/25
    title: "#25 — parseTxToken discards the failure reason — consumers must re-derive the accept set to render diagnostics"
    last_modified: 2026-09-03
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0007. parseTxToken returns a discriminated result with a parse-failure reason

- **Status:** accepted
- **Date:** 2026-09-03
- **Issue:** [#25](https://github.com/GenvidTechnologies/mcp-utils/issues/25)

## Context

`parseTxToken` returned bare `null` for every malformed input, discarding
which of its reject branches fired. A consumer that wants to render a
diagnostic (rather than a generic "bad token" message) has to re-derive the
accept set locally — exactly the duplication [ADR-0005](0005-tx-token-wire-format.md)
shipped this module to remove. This record **extends** ADR-0005; it does not
supersede it. ADR-0005's `null`-returning contract was not wrong for what it
covered — it is being widened to carry a reason.

Issue #25 as filed carried three premises that did not reproduce when both
parsers were run over one shared input matrix (36 fixed rows plus 20,000
fuzzed inputs, 20,036 total; 112 of those were accepted by the pre-change
parser, with zero disagreements against the post-change parser on either
validity or the parsed halves):

| Issue claim | Measured |
|---|---|
| construct3-chef's local parser produces 8 distinct messages | **7** distinct error strings, collapsing to **3** message templates |
| a 3-member union (`no-separator \| invalid-project-id \| invalid-counter`) covers it | upstream has **5** distinguishable reject branches; folding the safe-integer check into a generic counter error loses the distinction ADR-0005's own Consequences section calls out ("rejected rather than silently truncated"), and drops `not-a-string`, which is reachable off the wire from untyped JS |
| both named consumers need this | `parseTxToken` has **zero** importing consumers today. construct3-chef imports `compareTxToken`/`formatTxToken` from its own local `src/mcp/txToken.ts`, not this package. c3-domain-manager imports `formatTxToken`/`compareTxToken` from here (`src/mcp/server.ts:7`) and never calls `parseTxToken`. Both pin `^0.9.0`, both locked to `0.9.0`. |

The four accept-set rows where chef's local parser diverges from this
module — all still rejected here — sharpen why the distinction matters: chef
**silently truncates** `"alpha:9007199254740993"` to `9007199254740992` and
reports success, exactly the failure mode a folded "generic counter error"
reason would have made harder to tell apart from a shape rejection.

## Decision

`parseTxToken` returns a discriminated result instead of `T | null`:

```ts
export type TxTokenParseFailure =
  | "not-a-string"
  | "no-separator"
  | "invalid-project-id"
  | "invalid-counter-shape"
  | "counter-out-of-range";

export type TxTokenParseResult =
  | { ok: true; projectId: string; n: number }
  | { ok: false; reason: TxTokenParseFailure };

export function parseTxToken(token: string): TxTokenParseResult;
```

One reason per reject branch, in the order the checks run: input isn't a
`string`; no `:` found; the left half fails `isValidProjectId`; the right
half doesn't match the canonical-integer shape; the right half is
shape-valid but exceeds `Number.MAX_SAFE_INTEGER`.

**The accept set does not move.** Every `{ ok: false }` sits exactly where a
`return null` sat before this change. The one structural edit splits the
previously-combined `if (!isValidProjectId(projectId) || !TX_N.test(rest))`
condition into two branches, in the same order, so the two reasons are
distinguishable — same verdict, finer report.

**`compareTxToken` is observably unchanged.** It narrows on `parsed.ok` in
place of the old truthiness check and still returns the same `boolean`, same
truth table. This is the function c3-domain-manager — the one consumer that
actually imports from this module today — calls; it sees no change.

## Compromise

**Rejected — a three-member union**, as issue #25 proposed
(`no-separator | invalid-project-id | invalid-counter`). It folds the
safe-integer rejection into a generic counter error, losing the distinction
ADR-0005 already calls out as consequential, and it drops `not-a-string`,
which is reachable off the wire from untyped JS callers. See Context above
for the measured gap between the issue's 3-member proposal and the 5
branches the implementation actually has.

**Rejected — an additive sibling** (`parseTxTokenDetailed`, leaving
`parseTxToken` returning `null`). Its selling point was avoiding a breaking
change, but that cost is close to zero here: `parseTxToken` has zero
importing consumers today, and a pre-1.0 caret (`^0.9.0`) admits patch
updates only, so nobody picks this up without deliberately widening their
range (see Consequences). Against that near-zero saving, the sibling's own
cost is real — two parsers would ship, and a consumer reaching for the
familiar name would silently keep the status-quo bug the issue was filed
about.

**Rejected — an exported predicate trio** (expose the counter-shape check
as its own function, alongside `isValidProjectId`). This asks every consumer
to re-assemble the classification themselves, relocating the drift the issue
objects to rather than removing it.

## Consequences

- **Ships as 0.10.0, a minor.** New shape on an existing exported function's
  return type is an observable output change even though nothing was
  removed. Below 1.0.0 a caret excludes every minor: `^0.9.0` resolves as
  `>=0.9.0 <0.10.0`, permitting **patch** updates only, so this does **not**
  reach either consumer on their next install — both must widen to
  `^0.10.0` deliberately. (A 2026-08-28 draft of the 0.9.0 CHANGELOG entry
  asserted the exact inverse direction for a different release, and every
  automated gate was green over it — see
  `wiki/failure-modes-that-report-success.md`. Nothing in this repo reads
  prose, so the direction has to be checked by hand each time it's stated.)
- **The accept set does not move.** Confirmed by the differential probe in
  Context: 20,036 inputs, 112 previously-accepted, zero disagreements
  post-change.
- **`compareTxToken`'s truth table is unchanged** — the one live consumer
  (c3-domain-manager) observes no behavior change from this release.
- Naming 0.10.0 here is a version-*choice* record, not an instruction to bump
  `package.json` in this PR — per `wiki/process/code-review-context.md`, the
  bump is its own `chore(release)` commit at release time.

## Related

- [0005. The tx-token wire format is a shared codec, not a per-consumer implementation](0005-tx-token-wire-format.md) — the record this decision extends; the `null`-returning contract it shipped is widened here, not superseded.
