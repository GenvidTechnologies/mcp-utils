---
type: decision-context
title: 0010. mcpStructuredContent is a sibling helper that lets a throwing builder propagate
description: Why structured tool output ships as a new `mcpStructuredContent` export beside `mcpContent` instead of an option on it, and why a throwing payload builder propagates instead of becoming an `mcpError` result.
tags: [mcpcontent, structuredcontent, outputschema, decision]
status: stable
generated: { by: human:ninoles, at: 2026-11-05T00:00:00Z }
sources:
  - id: issue-37
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/37
    title: "#37 — feat: let mcpContent attach structuredContent built from the joined text"
    last_modified: 2026-11-05
  - id: chef-issue-349
    resource: https://github.com/GenvidTechnologies/construct3-chef/issues/349
    title: "construct3-chef#349 — fix: MCP validate-project reports success on manifest drift (the consumer whose fix wraps mcpContent)"
    last_modified: 2026-11-05
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0010. mcpStructuredContent is a sibling helper that lets a throwing builder propagate

- **Status:** accepted
- **Date:** 2026-11-05
- **Issue:** [#37](https://github.com/GenvidTechnologies/mcp-utils/issues/37); consumer [construct3-chef#349](https://github.com/GenvidTechnologies/construct3-chef/issues/349)

## Context

`mcpContent(text, footer?)` builds a `CallToolResult` with one text block. It
sets no `structuredContent`.

A tool that declares an `outputSchema` needs `structuredContent`. In MCP SDK
1.29.0, `validateToolOutput` in `dist/esm/server/mcp.js` skips results with
`isError`. For any other result it throws `Output validation error` when
`structuredContent` is missing or does not match the schema. The CallTool
handler catches that throw and returns an `isError` result that holds only the
error text.

construct3-chef wraps `mcpContent` for this (`cleanReportContent` in
`src/mcp/structuredReport.ts`). It calls `mcpContent`, reads `content[0].text`
back, and adds `structuredContent: { clean, report }`. Issue #37 asks for that
plumbing here. What goes in the payload stays with the consumer.

## Decision

**Sibling helper.** A new export:

```ts
mcpStructuredContent<T extends Record<string, unknown>>(
  text: string,
  footer: string | undefined,
  structured: T | ((body: string) => T),
): CallToolResult & { structuredContent: T }
```

It calls `mcpContent(text, footer)`, so the rule that joins text and footer has
one home. When `structured` is a function, it receives the joined text once.
`mcpContent` is unchanged.

The return type is the reason for the choice. It guarantees that
`structuredContent` is present, and it keeps the payload type `T`. An
`outputSchema` tool needs both.

**Let it propagate.** A builder that throws is not guarded. The error leaves
`mcpStructuredContent`, as with the footer callback of `paginatedContent`.
`mcpContent` is not one of the never-throw helpers (`mcpError`, `withMcpErrors`,
`loadProjectConfig`, `resolveRootFolder`). Inside `withMcpErrors` the throw
becomes an `isError` result. The SDK does not validate such a result, so the
real message stays visible.

## Compromise

**Option on `mcpContent`.** Rejected. The form would be
`mcpContent(text, footer?, { structured })`. It adds no export and mirrors the
options object of `mcpError`. Two things count against it:

- The return type stays a plain `CallToolResult` with `structuredContent`
  optional. The compiler cannot tell an `outputSchema` tool that it forgot the
  payload.
- A call with no footer reads `mcpContent(text, undefined, { structured })`.

**Guard the builder and return `mcpError`.** Rejected. It brings error
formatting into a success helper. A programming bug in the builder then looks
the same to the consumer as a tool failure.

## Consequences

- One more export to document and to keep in the README and `CLAUDE.md` lists.
- `mcpError` is unchanged. Results with `isError` carry no `structuredContent`.
- `T` must be assignable to `Record<string, unknown>`. An `interface` without an
  index signature is rejected. A type alias works.
- This ships as a minor release (0.14.0), because it adds to the public API.
  Below 1.0.0 a caret range allows patch updates only, so a consumer pinned to
  `^0.13.0` does not receive it until they widen the range.

## Related

- [0006. resolveRootFolders ships as an additive plural, not a field on the ambiguous error](0006-resolve-root-folders-plural.md) — another additive sibling chosen over changing an existing signature.
