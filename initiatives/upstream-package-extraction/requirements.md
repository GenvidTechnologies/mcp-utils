# Requirements: Upstream Extraction of 7 Generic MCP/FS Utilities

> Source: `work-request.md` (from `construct3-chef`). Analysis grounded in current `genvid-mcp-utils` repo state.

## Problem Statement

The downstream consumer `construct3-chef` has accumulated generic MCP/filesystem plumbing — code with zero project-specific domain knowledge — written inline and duplicated across many tool handlers. This request asks `genvid-mcp-utils` (the shared MCP plumbing layer) to absorb 7 such utilities so the consumer can delete its copies after a version bump. Several items are direct companions to helpers this package already owns (`ExpectedChanges`, `paginateText`, `Logger`).

Additive-API request. No breaking changes.

## Current State (grounding)

- `src/index.ts` surfaces every public export; types re-exported with the `type` modifier; all relative imports use explicit `.js` extensions.
- `src/expectedChanges.ts` — class with TTL; `private static normalize(p)` already inlines `p.replace(/\\/g, "/")` (the §2 `toPosixPath` idiom).
- `src/pagination.ts` — `paginateText(fullText, options): PaginatedResult`; exports `PaginationOptions`/`PaginatedResult` (§6a reuses these).
- `src/types.ts` — `Logger = (...args: unknown[]) => void` (§5, §7 build on this).
- `src/exposeDocs.ts` — only file importing `@modelcontextprotocol/sdk`; uses sync FS (`existsSync`/`readdirSync`) — precedent for §1.
- Tests: mocha + chai via `tsx`, real temp dirs (`fs.mkdtempSync` + `afterEach` cleanup), `deferred<T>()` + microtask flushing for concurrency (`rwlock.test.ts`), privates accessed via `(obj as any)`.
- Deps already present: `@modelcontextprotocol/sdk ^1.27.1`, `zod ^3.23.0`. Node >= 22, pnpm, strict TS, NodeNext.
- `node_modules` not installed in working tree — exact SDK type shapes (`CallToolResult`, `ToolAnnotations`) unverified.

## Requirements

### General (all items)
- **R-G1.** Additive only — existing exports and their signatures/behavior unchanged.
- **R-G2.** Each utility in its own `src/<name>.ts`, re-exported from `src/index.ts` (types via `type`).
- **R-G3.** Each new export gets `test/<name>.test.ts` (mocha + chai) and a README section.
- **R-G4.** ESM/NodeNext: explicit `.js` extensions on relative imports.
- **R-G5.** Must pass `lint` (`--max-warnings 0`), `typecheck` (strict), `test`, `build`.

### §1 `walkFiles(dir, match)`
- R1.1 Recursively collect file paths under `dir`.
- R1.2 `match` is `string | ((path) => boolean)`; string = extension filter, function = predicate.
- R1.3 **Return `[]` (not throw) when `dir` does not exist** — callers depend on this (required test).
- R1.4 Pure FS plumbing, no domain knowledge.
- R1.5 Must subsume 6 consumer variants (extension-filter, predicate, relative-glob).

### §2 `escapeRegExp` / `toPosixPath`
- R2.1 `escapeRegExp(str)` = exactly `str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` (byte-identical across 3 copies).
- R2.2 `toPosixPath(p)` = exactly `p.replace(/\\/g, "/")`.
- R2.3 Optional: refactor `ExpectedChanges.normalize` to consume the helper without changing external behavior (see OQ-2).

### §3 `resolveWithin(base, rel)`
- R3.1 Return resolved absolute path if `rel` stays inside `base`, else `null` (no throw).
- R3.2 Check via `path.relative` + reject when result `startsWith("..")` or is absolute.
- R3.3 Cover the 4 drifted consumer rejection shapes with one consistent contract.

### §4 `mcpError` / `withMcpErrors`
- R4.1 `mcpError(e, extraLines?)` builds standard MCP error content from any thrown value, using `e instanceof Error ? e.message : String(e)`.
- R4.2 Result shape: `{ content: { type: "text"; text: string }[]; isError: true }`.
- R4.3 `extraLines?: string[]` appends footer lines (e.g. `txId: N`) without baking in domain concepts.
- R4.4 `withMcpErrors(fn, extraLines?)` wraps an async handler so throws become `mcpError(...)`; here `extraLines` is a `() => string[]` thunk (evaluated at catch time).
- R4.5 Wrapper preserves the handler's normal return value unchanged.

### §5 `bufferingLogger()`
- R5.1 Returns `{ log: Logger; text(): string }`.
- R5.2 `log(...args)` pushes `args.map(String).join(" ")` as one line.
- R5.3 `text()` returns lines joined by `"\n"`.
- R5.4 Uses the existing `Logger` type.

### §6a `paginatedContent(fullText, options, footer?)`
- R6a.1 Wraps `paginateText`; returns `{ content: { type: "text"; text: string }[] }`.
- R6a.2 Formats a `lines: A-B / total` range footer.
- R6a.3 `footer?: (r: PaginatedResult) => string` appends extra footer text (e.g. stale warning) — project-specific piece kept downstream.

### §6b Annotation presets
- R6b.1 Export `READ_ONLY`, `REGENERATE`, `MUTATE`, `NON_IDEMPOTENT_READ` `as const` exactly per the request table.
- R6b.2 Align with the MCP SDK tool-annotation type (see OQ-4).

### §7 `OptimisticWatcher` (lower priority, concurrency-sensitive — do last, ship behind tests)
- R7.1 `txId` getter; `bump()`, `expect(path)`, `suppress<T>(fn)`, `start()`, `stop()`.
- R7.2 Reuse existing `ExpectedChanges` (passed via options).
- R7.3 `fs.watch` (recursive) over `watchDirs` bumps `txId` / fires `onExternalChange` only for **external** edits.
- R7.4 Self-writes masked via BOTH `ExpectedChanges.add(...)` AND a suppress-depth counter (two-layer suppression preserved).
- R7.5 A cancelled/interrupted write that already touched disk must still bump `txId`.
- R7.6 `onExternalChange?(path)` is the only project-specific decision (dirty semantics); consumer's `extractedDirty` distinction stays downstream.
- R7.7 Optimistic-concurrency contract: reads observe current `txId`; mutates accept expected `txId` and reject if moved (reject logic stays downstream).
- R7.8 Tests for suppress/bump/external-change paths.

## Constraints
- C1 No breaking changes (additive).
- C2 ESM NodeNext, `.js` extensions mandatory.
- C3 Strict TS; `no-explicit-any` disabled in eslint, so §4's `any` generics are permitted.
- C4 Dual entry points; `src` must not import test-only code; `tsconfig.json` includes only `src/**/*.ts`.
- C5 Dependency-light; prefer Node built-ins; SDK/zod already present; no new runtime deps without a decision.
- C6 CI: `lint → typecheck → test → build`, `--max-warnings 0`.
- C7 `pnpm install` is a prerequisite before local build/test.
- C8 §7 sequenced last, gated on tests.
- C9 `fs.watch` is timing/OS-dependent (Windows dev box); affects how §7 can be tested deterministically.

## Touch Points
- `src/index.ts` — add re-exports.
- New `src/*.ts` (one per item) + mirrored `test/*.test.ts`.
- `README.md` — section per new utility.
- `src/expectedChanges.ts` — only if OQ-2 decided to share `toPosixPath`.
- `package.json` — only if a new dep proves necessary (ideally none).
- Downstream (out of scope): `construct3-chef` `.packages-version` bump + copy deletion in follow-up PRs.

## Open Questions
- **OQ-1 (§4 return type).** Return the SDK's `CallToolResult` type or the structural literal shown in the request? Unverified (node_modules absent).
- **OQ-2 (§2 reuse).** Refactor `ExpectedChanges.normalize` (and other inlined `\\→/` uses) to call `toPosixPath`, or keep this PR purely additive?
- **OQ-3 (§4 typing asymmetry).** Confirm `mcpError` takes `string[]` while `withMcpErrors` takes `() => string[]` (thunk captures mutable `txId` at catch time).
- **OQ-4 (§6b SDK typing).** Type presets against SDK `ToolAnnotations` (`satisfies`) or leave bare `as const`? Where do they live (with §6a or own module)?
- **OQ-5 (§7 testability).** Test `fs.watch` deterministically cross-platform — depend on `fs.watch` directly, or add an injectable watcher to `OptimisticWatcherOptions` (not in the proposed shape)?
- **OQ-6 (§7 error semantics).** `suppress<T>(fn)` on reject: unwind suppress-depth in `finally`; still bump `txId` on cancelled-but-disk-touched path. Consumer `CancelledError` contract lives in `construct3-chef` CLAUDE.md.
- **OQ-7 (§7 watcher granularity).** Debounce? `rename` vs `change` handling? External-vs-self boundary needs confirmation from consumer source.
- **OQ-8 (§1 symlinks/depth).** Follow symlinks? Max-depth / cycle guard?
- **OQ-9 (naming/grouping).** File names; whether §2's two functions share a module; where presets live.
