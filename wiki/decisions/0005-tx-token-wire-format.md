---
type: decision-context
title: 0005. The tx-token wire format is a shared codec, not a per-consumer implementation
description: Why `formatTxToken`/`parseTxToken`/`compareTxToken`/`isValidProjectId` ship as one `${projectId}:${n}` codec in this package, and why lenient `n`-parsing and a branded token type were both rejected.
tags: [txtoken, optimisticwatcher, wire-format, decision]
status: stable
generated: { by: human:ninoles, at: 2026-08-28T00:00:00Z }
sources:
  - id: issue-19
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/19
    title: "#19 — add a transaction-token codec for multi-project optimistic concurrency"
    last_modified: 2026-08-27
  - id: c3-domain-manager-77
    resource: https://github.com/GenvidTechnologies/c3-domain-manager/issues/77
    title: "c3-domain-manager#77 — MCP server multi-project support (multiple C3 roots, project-selection tool param)"
    last_modified: 2026-08-27
  - id: construct3-chef-95
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/95
    title: "construct3-chef#95 — MCP server multi-project support (multiple C3 roots, project-selection tool param)"
    last_modified: 2026-08-27
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0005. The tx-token wire format is a shared codec, not a per-consumer implementation

- **Status:** accepted
- **Date:** 2026-08-28
- **Issue:** [#19](https://github.com/GenvidTechnologies/mcp-utils/issues/19)

## Context

`OptimisticWatcher` holds `private _txId = 0` per instance, exposed as a bare
`get txId(): number`. A server hosting a single project root emits that
integer to clients as-is, who hold it and pass it back on a mutating call for
a stale-write comparison.

A server hosting **N** project roots holds N independent `OptimisticWatcher`
instances, each with its own counter starting at 0. A bare integer no longer
says which project's counter it names: a token minted against project `alpha`
compares equal against project `beta` whenever their counters happen to
coincide, so the stale-write guard **accepts a write it should reject** — it
has not failed, it has silently stopped guarding. Collapsing to one shared
counter is not a fix either: it makes the integer unambiguous again, but then
any project's write invalidates every client's outstanding token, so
optimistic concurrency becomes unusable at N busy projects.

Two consumers need per-project tokens at the same time and must agree
byte-for-byte on the wire shape: `c3-domain-manager#77` and
`construct3-chef#95`, both shipping in the `gvt-construct3` Claude Code plugin
and launched identically.

## Decision

Ship a `` `${projectId}:${n}` `` token codec — `formatTxToken`, `parseTxToken`,
`compareTxToken`, `isValidProjectId` — in this package rather than have each
consumer implement its own. The reason it belongs upstream rather than in
each consumer is the failure mode: if the two servers disagree about the
delimiter or the comparison, an agent driving both in one turn holds two
incompatible tokens and one server accepts a write the other would have
rejected — **silently, at the point of a mutation**, not loudly at a call
boundary. The `:` delimiter is therefore recorded here as a **wire contract
with two named consumers**, so a future change to it reads as breaking rather
than cosmetic.

`parseTxToken` never throws (its input is a client-supplied wire value) and
returns `null` on any malformed input, including non-string input.
`compareTxToken` returns `false`, never `null`/`undefined`, so a consumer's
`!== true` and `=== false` guard spellings agree. `formatTxToken` throws
`TypeError` on an invalid `projectId` or `n` — the deliberate exception to
this module's otherwise never-throw contract, because its input comes from
the server's own construction path, not off the wire. `n` is validated with
`Number.isSafeInteger`, so a value beyond `Number.MAX_SAFE_INTEGER` is
rejected rather than silently truncated — see Consequences.

**Scope line, deliberately drawn:** the **id-derivation** rules (basename,
lowercase, hyphenate, collision suffix) stay local to each consumer and are
not part of this codec. Their drift mode is visible and harmless — a
`list-projects` call on the two servers would return different ids for the
same directory immediately, before any write. Only the silent-failure half —
the wire shape and the comparison — needed a shared implementation.

`src/txToken.ts` has zero runtime imports (requirement #4: both consumers
plan to import this codec into a project registry module whose purity is
itself an asserted property, so the codec must be structurally incapable of
touching the filesystem).

## Compromise

**Rejected: lenient `n`-parsing (accepting zero-padding, e.g. `"alpha:03"`).**
The real motive for leniency would be that fixed-width zero-padding makes
tokens lexicographically sortable. Blocked because `formatTxToken` mints
**unpadded** and is pinned byte-exact — by this issue's own test matrix and by
`construct3-chef#95`'s acceptance row T-X4, which asserts `txId:'alpha:12'` on
the wire. Since this codec is the sole minter, a lenient parser would only
ever accept padded tokens nothing can produce. Revisiting this would require
`formatTxToken` to pad too — a breaking wire change for both consumers.

The cost leniency would have introduced is concrete, not just aesthetic:
`format(parse(t)) === t` would no longer hold for every token that parses,
and string-equality and `compareTxToken` would disagree on `"alpha:03"` vs.
`"alpha:3"` — precisely the silent cross-consumer divergence this codec
exists to prevent. Measured against the shipped implementation: 44 tests in
`test/txToken.test.ts` include the round-trip invariant
`format(parse(t)) === t` and the 7-case malformed-shape matrix (of which
`"alpha:03"` is one), all passing.

**Rejected: a branded `TxToken` type** (`string & { __brand }`) instead of a
plain `string` alias. Tokens arrive off the wire as plain strings, so the
brand would be cast away at exactly the boundary where it would have helped,
and it would diverge from the API both waiting consumers were promised in
this issue's proposed signatures.

**Moot, not chosen: reject-on-multiple-colons vs. split-on-first for
`"a:b:c"`.** The issue calls this its one genuinely open question. Given
constraints the issue already fixes — `isValidProjectId` bans `:`, and the
right half must match a canonical-numeric shape — reject-on-multiple,
split-on-first, and split-on-last all produce `null` for both `"a:b:c"` and
`"a:b:3"`. They are extensionally identical, so the choice between them is
not observable from outside the module. The implementation uses split-on-first
(`token.indexOf(":")`) and reuses `isValidProjectId` on the left half, which
yields reject semantics by construction rather than by a separate branch.

## Consequences

- **`n` has an upper bound after all**, despite requirement #8's "no upper
  bound assumed": a JS number is exact only to `Number.MAX_SAFE_INTEGER`
  (`2^53 - 1`). Values beyond it are rejected by `parseTxToken` rather than
  silently truncated — confirmed by the shipped matrix, which includes
  `"alpha:9007199254740993"` (`MAX_SAFE_INTEGER + 2`) parsing to `null`. This
  correction is already recorded in issue #19's body; it is restated here
  because both consumers pin against this contract, not shipped text alone.
- **Ships as a minor bump.** New exports, nothing removed or renamed. Per
  `wiki/process/code-review-context.md`, naming the target version in an ADR
  is a version-*choice* record, not an instruction to bump `package.json` in
  this PR — the bump is its own `chore(release)` commit at release time.
- Measured against the shipped tree: `src/txToken.ts` has 0 `^\s*import`
  lines (requirement #4), `test/txToken.test.ts` has 44 tests (9 static +
  table-driven cases across `formatTxToken`, `parseTxToken`, and
  `compareTxToken`), and the full suite reports 250 passing / 1 pending (the
  documented POSIX-only `resolveWithin` skip, unrelated to this change).

## Related

- [0002. ObservedState collapses duplicate watch events](0002-observed-state-collapses-duplicate-watch-events.md) — the `OptimisticWatcher`/`txId` machinery this codec's tokens are minted against.
