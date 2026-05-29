# Work Request → `genvid-mcp-utils`

> **For:** the agent/maintainer working in the **`genvid-mcp-utils`** repo.
> **From:** the `construct3-chef` repo (a downstream consumer).
> **Type:** additive API. **No breaking changes** to existing exports.
> **Status:** proposal / not yet started.

## Context

`genvid-mcp-utils` is the generic MCP/server plumbing layer. It already exports `ReadWriteLock`, `ExpectedChanges`, `paginateText`, `exposeDocs`, and the `Logger` type. `construct3-chef` is one consumer — it builds an MCP server (`src/mcp/server.ts`) and a CLI on top.

An audit of `construct3-chef` found a body of **generic plumbing with zero C3-domain knowledge** that has been written inline and duplicated across tools. It is a natural fit for `genvid-mcp-utils` because (a) it has no project-specific logic and (b) several items are direct companions to helpers you already own (`ExpectedChanges`, `paginateText`, `Logger`).

Each item lists **consumer evidence** (the `construct3-chef` call sites that collapse once the API exists) as justification only — you don't need that repo to implement anything here. After each item ships, `construct3-chef` bumps `.packages-version` and removes its local copy in a follow-up PR.

Items are priority-ordered: §1–6 are small, mechanical, low-risk; §7 is the larger, concurrency-sensitive one.

---

## 1. `walkFiles` — recursive directory walk by extension/predicate

```ts
export function walkFiles(dir: string, match: string | ((path: string) => boolean)): string[];
```
Recursively collect files under `dir`. A `string` argument is treated as an extension filter (e.g. `".json"`); a function is a predicate. **Returns `[]` if `dir` does not exist** (callers rely on this — don't throw). Pure FS plumbing, no C3 knowledge.

**Consumer evidence — 6 near-identical copies today:** `generators.ts:510` (`findJsonFiles`), `spriteScaffold.ts:13` (a second `findJsonFiles`), `search.ts:57` (`walkFiles(dir, ext)`), `navigationGraph.ts:28` (`findDslFiles`), `mcp/server.ts:236` (`globRelative`), `cli.ts:343` (`walkSearch`).

---

## 2. Small string/path utilities

```ts
export function escapeRegExp(str: string): string;   // str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
export function toPosixPath(p: string): string;       // p.replace(/\\/g, "/")
```

**Consumer evidence:** `escapeRegExp` is defined **3× byte-identically** (`recipeInterpreter.ts:1758`, `recipeApplier.ts:393`, `instVarMutator.ts:143`). The `\\ → /` slash idiom is open-coded ~10× (`generators.ts` lines 62/67/183/285/318/381/384/540, `dslFormatter.ts:424/427`, `includeTree.ts:30`).

---

## 3. `resolveWithin` — path-traversal guard

```ts
/** Returns the resolved absolute path if `rel` stays inside `base`, else null. */
export function resolveWithin(base: string, rel: string): string | null;
// implemented via path.relative + reject startsWith("..") || path.isAbsolute(...)
```
Generic containment guard for any tool that reads/writes user-supplied relative paths.

**Consumer evidence — 4 copies with slightly drifted rejection shapes:** `mcp/server.ts:1047-1051` (read-addon), `:1109-1120` and `:1122-1133` (scaffold-layout source + out), and a `startsWith` variant in `readExtracted` (`:132-134`).

---

## 4. MCP error-response mapping

```ts
/** Build the standard MCP error content array from any thrown value. */
export function mcpError(e: unknown, extraLines?: string[]): { content: {type:"text"; text:string}[]; isError: true };

/** Wrap a tool handler so thrown values become mcpError(...) responses. */
export function withMcpErrors<T extends (...a: any[]) => Promise<any>>(fn: T, extraLines?: () => string[]): T;
```
The `extraLines` hook lets callers append tool-specific footers (e.g. a `txId: N` line) without baking that concept into the helper.

**Consumer evidence — the `catch (e) { … e instanceof Error ? e.message : String(e) …, isError:true }` block is repeated in ~9 tools:** `mcp/server.ts` validate-recipe(762), apply-recipe(835), generate-sids(571), regenerate(879), validate-project(915), sync-project(969), scaffold-layout(1190), scaffold-sprite(1313), runWorkflowRecipe(1383). The `txId`-carrying variant alone recurs ~7×.

---

## 5. `bufferingLogger` — capture `Logger` output into a string

```ts
export function bufferingLogger(): { log: Logger; text(): string };
// log(...args) pushes args.map(String).join(" "); text() returns lines.join("\n")
```
Companion to the existing `Logger` type. Lets a tool capture progress logs and return them in the MCP response.

**Consumer evidence — the `const lines: string[] = []; const log: Logger = (...a) => lines.push(a.map(String).join(" "))` idiom is verbatim in 8 tools:** `mcp/server.ts` lines 741, 801, 865, 905, 943, 1094, 1227, 1351.

---

## 6. Paginated MCP content helper + annotation presets

### 6a. `paginatedContent` — companion to `paginateText`
```ts
export function paginatedContent(
  fullText: string,
  options: PaginationOptions,
  footer?: (r: PaginatedResult) => string,   // optional extra footer line(s)
): { content: { type: "text"; text: string }[] };
```
Wraps the existing `paginateText`, formats the `lines: A-B / total` range footer, and lets the caller append extra footer text (e.g. a freshness/stale warning) via the hook. **Consumer evidence:** `mcp/server.ts:219-234` (`paginatedResponse`) does exactly this, with the stale-warning part being the only project-specific piece (supplied via the hook).

### 6b. Tool annotation presets
```ts
export const READ_ONLY  = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true  } as const;
export const REGENERATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true  } as const;
export const MUTATE     = { readOnlyHint: false, destructiveHint: true,  idempotentHint: false } as const;
export const NON_IDEMPOTENT_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: false } as const;
```
Standard MCP `tools` annotation presets. **Consumer evidence:** `mcp/server.ts:59-64` defines this exact set.

---

## 7. `OptimisticWatcher` — txId + file-watcher + self-write suppression (larger, concurrency-sensitive)

This is the biggest item and the natural companion to your existing `ExpectedChanges`. `construct3-chef` implements an optimistic-concurrency layer that is entirely generic except for one project-specific decision (what counts as "dirty"), which should be a callback.

Proposed shape:
```ts
export interface OptimisticWatcherOptions {
  watchDirs: string[];
  expected: ExpectedChanges;                 // reuse the existing class
  onExternalChange?: (path: string) => void; // caller decides dirty semantics
}
export class OptimisticWatcher {
  constructor(opts: OptimisticWatcherOptions);
  get txId(): number;
  bump(): void;                              // increment txId after a self-write
  expect(path: string): void;               // register a self-write (delegates to ExpectedChanges)
  suppress<T>(fn: () => Promise<T>): Promise<T>; // run a write with watcher events masked
  start(): void;
  stop(): void;
}
```
Behavior to preserve from the consumer's current implementation:
- `txId` increments on every source mutation; read tools return current `txId`, mutate tools accept an expected `txId` and reject if it moved (optimistic concurrency).
- `fs.watch` (recursive) on `watchDirs` bumps `txId` / fires `onExternalChange` on **external** edits only.
- Self-induced writes are masked via `ExpectedChanges.add(...)` **and** a suppress-depth counter around the write, so the watcher doesn't spuriously mark state dirty.
- A cancelled/interrupted write that already touched disk must still bump `txId` (the consumer's `CancelledError` path does this).

**Consumer evidence:** `mcp/server.ts:48-55` (state decls) + `:258-286` (`setupWatchers`), plus the `txId++` / `suppressWatcherDepth++` / `expectedChanges.add` pattern woven through every mutate tool. The project's `extractedDirty` flag and the "project.c3proj vs source dirty" distinction (`server.ts:276-282`) stay downstream as the `onExternalChange` callback body.

⚠️ This is concurrency-sensitive. Ship behind tests; the consumer's `CLAUDE.md` documents the exact contract and can inform test cases. Lower priority than §1–6 — do those first.

---

## Summary / suggested order

| # | Item | Effort | Consumer copies removed |
|---|------|--------|-------------------------|
| 1 | `walkFiles` | low | 6 |
| 2 | `escapeRegExp` / `toPosixPath` | trivial | 3 + ~10 |
| 3 | `resolveWithin` (path guard) | low | 4 |
| 4 | `mcpError` / `withMcpErrors` | low | ~9 |
| 5 | `bufferingLogger` | trivial | 8 |
| 6 | `paginatedContent` + annotation presets | low | 1 + 1 |
| 7 | `OptimisticWatcher` | medium, concurrency-sensitive | the whole watcher/txId machinery |

**Acceptance criteria (all items):** additive only — existing `genvid-mcp-utils` exports unchanged; each new export covered by unit tests (especially §7's suppress/bump/external-change paths and §1's "missing dir returns `[]`" contract). `construct3-chef` consumes via a follow-up PR after a version bump.
