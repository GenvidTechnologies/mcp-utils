---
type: decision-context
title: 0006. resolveRootFolders ships as an additive plural, not a field on the ambiguous error
description: Why ambiguous discovery becomes a success on a new `resolveRootFolders({ paths, source })` rather than a `matches` field on `resolveRootFolder`'s error result, and why both rejected error-payload options were probed end-to-end before being rejected on design merit.
tags: [resolveRootFolder, mcp-error, decision]
status: stable
generated: { by: human:ninoles, at: 2026-08-28T00:00:00Z }
sources:
  - id: issue-20
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/20
    title: "#20 — resolveRootFolder: surface the computed ambiguous-discovery candidates as structure"
    last_modified: 2026-08-28
  - id: construct3-chef-adr-0034
    resource: https://github.com/GenvidTechnologies/construct3-chef/blob/main/wiki/decisions/0034-mcp-server-multi-project-support.md
    title: "construct3-chef ADR 0034 — MCP server multi-project support (decline 6: don't scrape resolveRootFolder's error text; decline 7: deferred multi-root auto-discovery)"
    last_modified: 2026-08-28
  - id: construct3-chef-213
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/213
    title: "construct3-chef#213 — docs(decisions): ADR 0034 decline 6 misdescribes resolveRootFolder's ambiguity output"
    last_modified: 2026-08-28
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0006. resolveRootFolders ships as an additive plural, not a field on the ambiguous error

- **Status:** accepted
- **Date:** 2026-08-28
- **Issue:** [#20](https://github.com/GenvidTechnologies/mcp-utils/issues/20)

## Context

`resolveRootFolder` already computes the full candidate set during ambiguous
discovery — it has to, in order to know discovery is ambiguous — but offered
no structured access to it.

**The real current shape.** Before this change the candidates DID reach the
caller, but only as untyped text. `src/resolveRootFolder.ts` passes `matches`
as `mcpError`'s legacy `string[]` `extraLines` argument; the `Error` message
itself carries only the match **count** and the marker name. `src/mcpError.ts`
renders that as `[baseMessage, ...extraLines].join("\n")`, so the candidate
paths already arrived as one absolute path per line after the message.

**This is a premise correction, not a restatement of the request.** Issue #20,
and the upstream record it was filed from (`construct3-chef` ADR 0034 decline
6), both originally described the candidates as surfaced "only as prose
interpolated into the returned `mcpError` string." That is wrong. A consumer's
extraction would have been `text.split("\n").slice(1)` — a line split, not a
regex over prose. Of the three reasons #20 gave for declining to scrape it,
two survive unchanged: "first place treating an error message as structured
data," and "upstream may reword at any patch with no version signal a
consumer could act on." The third — "a regex that stops matching degrades
silently" — is weaker as written, since a line split doesn't stop matching
the way a regex would, though it isn't void either: a reworded message or an
added trailing line still degrades the extraction silently. The decision not
to scrape stands on the first two reasons alone. #20's body has been
corrected in place; the upstream copy is tracked as
[construct3-chef#213](https://github.com/GenvidTechnologies/construct3-chef/issues/213).

**Why this matters now, not just as a correction.** The consumer motivating
this request is `construct3-chef`'s deferred multi-root auto-discovery (its
ADR 0034 decline 7), which registers *every* ambiguous candidate as its own
project. For that caller, two-or-more matches is the **success** case, not a
failure.

## Decision

Ship an additive plural `resolveRootFolders`, returning `{ paths: string[];
source }`, in which two-or-more candidates is a **success**. Leave
`resolveRootFolder`'s observable output unchanged — same message, same
`extraLines`, same error shape for the ambiguous case.

```ts
export interface ResolvedRoots {
  paths: string[];
  source: "explicit" | "env" | "discovery" | "cwd";
}

export function resolveRootFolders(
  opts: ResolveRootFolderOpts,
  env?: NodeJS.ProcessEnv,
  readdir?: ReaddirSync,
): ResolvedRoots | CallToolResult;
```

Attaching the candidate list to an `mcpError` would force the motivating
consumer to reach a success through `isMcpError` — semantically backwards,
and it would cement ambiguity-as-error against the one use case the request
exists to serve. `resolveRootFolder` is now implemented **on top of**
`resolveRootFolders`: the plural owns the discovery walk, and the singular
narrows a `paths.length === 1` result to `{ path, source }` and formats the
existing ambiguous `mcpError` for `paths.length >= 2`. One discovery walk, not
two — the same composition pattern already used by `paginatedContent` over
`paginateText` and `exposeDocs` over `walkFiles`.

Per construct3-chef ADR 0034 decline 7, discovery "produces bare paths, with
no id-derivation step," so a plain `string[]` of absolute paths is the right
payload — id derivation stays the consumer's job, the same scope line ADR-0005
drew between the wire codec and each consumer's own id rules.

A private `isErrorResult` type guard narrows `resolveRootFolders`' return
type inside `resolveRootFolder`, rather than importing `isMcpError` from
`loadProjectConfig.ts`. This avoids introducing the first dependency between
two utility modules in a deliberately flat, independent-utilities package.

## Compromise

Three shapes were weighed for carrying the candidate list. The two rejected
error-payload options were probed **end-to-end** before being rejected — real
`McpServer` → `InMemoryTransport` → real `Client`
(`@modelcontextprotocol/sdk` 1.29.0, the version this repo's `package.json`
range `^1.27.1` currently resolves to), the established pattern this repo
uses for testing an MCP surface. That probe drove the **integrated** client
path, not a component in isolation — the distinction ADR-0003's original,
now-corrected probe got wrong (see
`wiki/process/code-review-context.md`). Result: on a result with
`isError: true`, **both** `structuredContent` and a bare top-level field
survived the round trip intact, and no `outputSchema` was required. So both
were technically viable. That establishes only that the two channels
*transport* correctly — it says nothing about whether doing so is good
design, which is what actually decided this.

- **Rejected: `structuredContent` on the ambiguous `mcpError`.** The
  SDK-blessed channel, and what #20 literally asked for as one option.
  Rejected because it cements ambiguity-as-error (see Decision above), it
  needs a third option channel on `mcpError` — which already carries a
  deliberate dual-form API (legacy `string[]` vs. `McpErrorOptions`) — and the
  payload types as `Record<string, unknown>`, so the consumer casts.
- **Rejected: a bare extra top-level field on the `CallToolResult`.**
  Permitted because `CallToolResultSchema` closes with `z.core.$loose`
  (passthrough), which is why it round-tripped in the probe at all. Rejected
  for the same ambiguity-as-error reason as `structuredContent`, plus one of
  its own: it is not an SDK-sanctioned contract, so it would break silently
  if the schema ever tightened.
- **Rejected: make ambiguity a success on the existing `resolveRootFolder`**
  by adding `source: "ambiguous"` and a `matches` field to `ResolvedRoot`.
  Rejected as a breaking observable change to a shipped public API: a current
  consumer's `isMcpError` branch would stop firing on the ambiguous case, and
  they would silently proceed with whatever single `path` came back instead.
  Below 1.0.0 a minor bump does not protect them here, because the break is
  in code (a caller's own branch stops firing), not merely in release cadence
  — the caret-range protection a minor buys only covers *whether* a consumer
  picks the version up, not what happens once they do.

**Accepted costs, recorded honestly:**

- **Naming.** `resolveRootFolder` and `resolveRootFolders` differ by one
  character — a real autocomplete hazard. The only mitigation is doc text:
  both the README and `CLAUDE.md` entries open by stating which of the two to
  reach for.
- **Shared implementation.** `resolveRootFolder` is now implemented on top of
  `resolveRootFolders`, so a bug in the shared discovery walk reaches both
  exports where previously only one implementation existed. The safety net:
  all 32 pre-existing `resolveRootFolder` tests pass **unmodified** — the
  change added 8 new cases (250 → 258 passing, 1 pending throughout, matching
  the documented `test/resolveWithin.test.ts:49` POSIX-only skip).

## Consequences

- **No observable change to `resolveRootFolder`.** Its message, its
  `extraLines`, and every other returned shape are byte-identical to before
  this change — confirmed by the 32 unmodified pre-existing tests continuing
  to pass.
- **Ships as a minor bump.** `resolveRootFolders` and `ResolvedRoots` are new
  exports; nothing existing was removed or renamed. `^0.8.0` — the range
  existing consumers pin today — **excludes** `0.9.0`: below 1.0.0 a caret
  permits patch updates only. So this does not reach existing caret-pinned
  consumers silently; picking it up is deliberate work, same as `0.8.0` was
  for `^0.7.0` consumers.
- A future `construct3-chef` multi-root auto-discovery consumer can register
  every `resolveRootFolders` candidate as its own project without going
  through an error branch, which is the capability this record exists to
  unblock.

## Related

- [0003. exposeDocs addresses nested docs by path, guarded by resolveWithin](0003-exposedocs-path-shaped-resource-names.md) — the record whose original, since-corrected probe conflated a component-isolated result with the integrated path; this decision's probe deliberately drove the integrated client instead.
- [0005. The tx-token wire format is a shared codec, not a per-consumer implementation](0005-tx-token-wire-format.md) — draws the same id-derivation-stays-local scope line this decision reuses for candidate paths.
