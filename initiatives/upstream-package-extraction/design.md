# Design: Upstream Extraction of 7 Generic MCP/FS Utilities

> Built from `requirements.md` + `work-request.md`. User decisions baked in: all 7 in one branch (§7 last); refactor `ExpectedChanges.normalize` to share `toPosixPath`; SDK return-type typing resolved here.

## SDK-typing decision (resolves OQ-1, OQ-3, OQ-4)

`pnpm install` was run; the SDK types were read at `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`:
- `CallToolResult` (alias at L8089) — `content` is an array of content blocks; `isError?: boolean`. The request's structural literal `{ content: { type: "text"; text: string }[]; isError: true }` **is assignable** to `CallToolResult`.
- `ToolAnnotations` (alias at L8083) — all fields optional booleans (`readOnlyHint?`, `destructiveHint?`, `idempotentHint?`, `openWorldHint?`, `title?`).

**Decision:**
- §4 `mcpError` and §6a `paginatedContent` are typed to **return `CallToolResult`** (type-only import from the SDK). The bodies still construct the exact structural literal, so callers that only read `.content`/`.isError` are unaffected, and the result drops directly into an MCP tool handler with no cast. `withMcpErrors`'s generic stays structural (`T extends (...a: any[]) => Promise<any>`) so it wraps any handler; on throw it returns `mcpError(...)` (a `CallToolResult`).
- §6b presets are declared `as const satisfies ToolAnnotations` — keeps the literal types (so `READ_ONLY.readOnlyHint` is `true`, not `boolean`) while guaranteeing SDK compatibility.
- §4 typing asymmetry (OQ-3) **confirmed intentional**: `mcpError(e, extraLines?: string[])` takes a resolved array; `withMcpErrors(fn, extraLines?: () => string[])` takes a thunk so the wrapper reads a mutable value (e.g. a `txId` counter) at catch time.

Type-only imports (`import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"`) add no runtime dependency surface beyond what `exposeDocs.ts` already pulls. No `package.json` changes.

## Module layout

One utility per file, matching the package's flat style. Eight new source files + eight mirrored tests:

| File | Exports | Group rationale |
|------|---------|-----------------|
| `src/walkFiles.ts` | `walkFiles` | §1, standalone FS helper |
| `src/strings.ts` | `escapeRegExp`, `toPosixPath` | §2 — two tiny pure string transforms; grouping avoids two ~3-line files |
| `src/resolveWithin.ts` | `resolveWithin` | §3, standalone path guard |
| `src/mcpError.ts` | `mcpError`, `withMcpErrors` | §4 — wrapper is a thin layer over `mcpError`; same module |
| `src/bufferingLogger.ts` | `bufferingLogger` | §5, companion to `Logger` |
| `src/mcpContent.ts` | `paginatedContent` | §6a, companion to `paginateText` |
| `src/toolAnnotations.ts` | `READ_ONLY`, `REGENERATE`, `MUTATE`, `NON_IDEMPOTENT_READ` | §6b — data constants, distinct concern from the §6a function; own file |
| `src/optimisticWatcher.ts` | `OptimisticWatcher`, `OptimisticWatcherOptions` | §7 |

Edits: `src/index.ts` (re-exports, types via `type`), `src/expectedChanges.ts:17` (rewire `normalize` to `toPosixPath`), `README.md` (section per utility).

## Per-item design

### §1 `walkFiles(dir, match)` — `src/walkFiles.ts`
```ts
export function walkFiles(dir: string, match: string | ((path: string) => boolean)): string[];
```
- Hand-rolled recursion over `fs.readdirSync(d, { withFileTypes: true })` (sync, matching `exposeDocs.ts` precedent).
- Predicate: `typeof match === "string" ? (p) => p.endsWith(match) : match`. The string form is a suffix/extension test (`".json"`).
- **Missing dir → `[]`:** guard the top-level call — if `!fs.existsSync(dir)` (or catch `ENOENT` on the first `readdirSync`), return `[]`. Other errors (e.g. `EACCES`) propagate.
- Returns absolute-or-as-given paths joined via `path.join(dir, entry.name)` (consistent with how callers pass `dir`). Directories are recursed; files are matched.
- **Symlinks (OQ-8):** do **not** follow symlinked directories — test `entry.isDirectory()` (which is false for symlinks), so symlink cycles can't loop. Documented in JSDoc.

### §2 `escapeRegExp` / `toPosixPath` — `src/strings.ts`
```ts
export function escapeRegExp(str: string): string; // str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
export function toPosixPath(p: string): string;     // p.replace(/\\/g, "/")
```
Byte-identical to the consumer copies (R2.1/R2.2). Pure, no imports.

### §3 `resolveWithin(base, rel)` — `src/resolveWithin.ts`
```ts
export function resolveWithin(base: string, rel: string): string | null;
```
```ts
const resolved = path.resolve(base, rel);
const relToBase = path.relative(path.resolve(base), resolved);
return (relToBase === "" || (!relToBase.startsWith("..") && !path.isAbsolute(relToBase)))
  ? resolved : null;
```
- `relToBase === ""` (rel is `""`/`"."`) → returns `base`. Absolute `rel` inside base → resolved; absolute outside, or `..` escape → `null`. Cross-drive on Windows yields an absolute `relToBase` → `null`.

### §4 `mcpError` / `withMcpErrors` — `src/mcpError.ts`
```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export function mcpError(e: unknown, extraLines?: string[]): CallToolResult;
export function withMcpErrors<T extends (...a: any[]) => Promise<any>>(fn: T, extraLines?: () => string[]): T;
```
- `mcpError`: message = `e instanceof Error ? e.message : String(e)`; text = `[message, ...(extraLines ?? [])].join("\n")`; returns `{ content: [{ type: "text", text }], isError: true }`.
- `withMcpErrors`: returns a function with the same signature that `await`s `fn(...args)`, returns its value on success, and on throw returns `mcpError(err, extraLines?.())`. Cast back to `T`.

### §5 `bufferingLogger()` — `src/bufferingLogger.ts`
```ts
import type { Logger } from "./types.js";
export function bufferingLogger(): { log: Logger; text(): string };
```
- Closure over `const lines: string[] = []`; `log = (...a) => lines.push(a.map(String).join(" "))`; `text = () => lines.join("\n")`.

### §6a `paginatedContent(fullText, options, footer?)` — `src/mcpContent.ts`
```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { paginateText, type PaginationOptions, type PaginatedResult } from "./pagination.js";
export function paginatedContent(
  fullText: string, options: PaginationOptions, footer?: (r: PaginatedResult) => string,
): CallToolResult;
```
- Calls `paginateText`, formats range footer `lines: <offset>-<offset+returned-1> / <totalLines>` (mirroring consumer `paginatedResponse`), appends `footer?.(r)` line(s) if provided. Returns `{ content: [{ type: "text", text: page.text + "\n\n" + footerLine }] }` (exact joining matched to the consumer's `:219-234`).

### §6b annotation presets — `src/toolAnnotations.ts`
```ts
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
export const READ_ONLY          = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true  } as const satisfies ToolAnnotations;
export const REGENERATE         = { readOnlyHint: false, destructiveHint: false, idempotentHint: true  } as const satisfies ToolAnnotations;
export const MUTATE             = { readOnlyHint: false, destructiveHint: true,  idempotentHint: false } as const satisfies ToolAnnotations;
export const NON_IDEMPOTENT_READ= { readOnlyHint: true,  destructiveHint: false, idempotentHint: false } as const satisfies ToolAnnotations;
```

### §7 `OptimisticWatcher` — `src/optimisticWatcher.ts` (last, gated on tests)

**Testability (resolves OQ-5): inject a watcher factory.** The proposed `OptimisticWatcherOptions` is extended with an optional `watcherFactory` that defaults to a thin `fs.watch` adapter. Tests pass a fake factory and fire synthetic events deterministically; production uses the default. This sidesteps `fs.watch`'s OS-dependent, Windows-flaky timing (C9) without changing the production contract.

```ts
import type { Logger } from "./types.js";
import { ExpectedChanges } from "./expectedChanges.js";

export interface WatchHandle { close(): void; }
export type WatcherFactory = (dir: string, onEvent: (filename: string) => void) => WatchHandle;

export interface OptimisticWatcherOptions {
  watchDirs: string[];
  expected: ExpectedChanges;
  onExternalChange?: (path: string) => void;
  watcherFactory?: WatcherFactory; // default: fs.watch(dir, { recursive: true }, (_e, f) => onEvent(...))
  logger?: Logger;
}

export class OptimisticWatcher {
  get txId(): number;
  bump(): void;
  expect(path: string): void;                       // delegates to expected.add(path)
  suppress<T>(fn: () => Promise<T>): Promise<T>;
  start(): void;
  stop(): void;
}
```

**Two-layer self-write suppression (R7.4):** a private `suppressDepth` counter AND `ExpectedChanges`. On a watcher event for `filename`:
1. If `suppressDepth > 0` → suppressed (drop the event). *(covers the synchronous write window)*
2. Else if `expected.consume(filename)` returns true → suppressed. *(covers events that arrive after the suppress window closed but were pre-registered)*
3. Else → external: `bump()` and `onExternalChange?.(resolvedPath)`.

**`suppress<T>(fn)` semantics (R7.5, OQ-6):**
```ts
async suppress(fn) {
  this.suppressDepth++;
  try { return await fn(); }
  finally { this.suppressDepth--; }
}
```
The depth always unwinds (success or throw). The cancelled-write-still-bumps-txId requirement (R7.5) is satisfied by the **caller**: the downstream write path calls `expect(path)` + `bump()` for any disk-touching write inside its own `try/finally`/`CancelledError` path — `OptimisticWatcher` exposes `bump()`/`expect()` as the generic primitives, and the README documents the idiom. `suppress` itself does not auto-bump (auto-bumping would defeat suppression). This keeps the dirty/cancelled policy downstream (R7.6).

**`start()`/`stop()`:** `start()` creates one `WatchHandle` per `watchDirs` entry via `watcherFactory`; idempotent (no-op if already started). `stop()` closes all handles and clears the list. The default factory wraps `fs.watch(dir, { recursive: true }, cb)` and normalizes the filename to an absolute path via `path.join(dir, filename)` then `toPosixPath`.

**External-vs-self boundary (OQ-7):** events are classified solely by the two suppression layers above; no debounce is built in (the consumer's `setupWatchers` debounce/`extractedDirty` logic stays downstream in `onExternalChange`). `rename` vs `change` is collapsed by the adapter (both call `onEvent`), matching the consumer's "any event on a watched path" behavior.

## Friction audit

- **§1 path shape:** consumer call sites mix relative-glob (`globRelative`) and absolute walks. `walkFiles` returns paths rooted at the `dir` argument; the `globRelative` site wants paths relative to a base — downstream wraps with `path.relative(base, p)`. Acceptable: that's a one-liner and project-specific. Documented in README.
- **§4 `withMcpErrors` generic:** returning `T` via cast means the wrapped fn's declared return type is preserved, but a thrown-path returns `CallToolResult` which may be a narrower/wider shape than `T`'s declared return. Since all consumer handlers already return `CallToolResult`-compatible shapes, no friction; noted so reviewers don't expect exhaustive type unification.
- **§6a footer formatting:** the exact whitespace/joining between page text and footer must match the consumer's `:219-234` so downstream snapshot/text expectations don't drift. Pinned in tests.
- **§7 `bump` placement:** the cancelled-write contract puts responsibility on the caller to `bump()` in its `finally`. This is a subtle seam — if a downstream author forgets, a cancelled write that touched disk won't advance `txId`. Mitigated by documenting the idiom prominently in the README and (downstream) keeping it in the shared write helper.

## Footprint audit (refactor directive)

Exactly **one** internal `\\→/` site in `src/`: `src/expectedChanges.ts:17` (body of `private static normalize`). The other ~10 copies cited in the work request live in `construct3-chef` (out of scope). The replacement is exact (no hidden second transform). **Rewire:** add `import { toPosixPath } from "./strings.js";`, make `normalize` a one-line delegator `return toPosixPath(p);` (keeps call sites `add`/`remove`/`consume` untouched, smallest diff). Regression gate: all 9 existing `expectedChanges.test.ts` cases (incl. the two backslash tests) pass unchanged.

**P/F split:** §2 add (`strings.ts` + test) is a pure addition (P-step). The `expectedChanges.ts` rewire is a separate F-step commit, validated by the unchanged `expectedChanges.test.ts`.

## Library vs custom
- **walkFiles:** hand-roll (~20 LOC over `readdirSync withFileTypes`). The `[]`-on-missing-dir contract, no-symlink-follow, and dual extension/predicate mode are trivial custom and would need wrapping around any glob lib anyway. A new runtime dep contradicts the dependency-light ethos (C5). **Custom, justified.**
- **resolveWithin:** hand-roll (~3 LOC, `path.relative` + `startsWith("..")`). Textbook; the request specifies it exactly. **Custom, justified.**

No mini-language/DSL anywhere → the library-first DSL gate does not apply.

## Test criteria (per item)

Follow existing patterns: mocha + chai, `fs.mkdtempSync(path.join(os.tmpdir(), …))` temp dirs with `afterEach` cleanup, `deferred<T>()` + `await Promise.resolve()` microtask flushing, privates via `(obj as any)`.

| Requirement | Test |
|---|---|
| R1.1/R1.2 | walkFiles over nested temp tree; extension-string filter and predicate each return correct subset |
| **R1.3** | `walkFiles("/no/such/dir", ".json")` → `[]`, no throw |
| R1 errors | non-ENOENT error propagates (stub) |
| OQ-8 | symlinked subdir not recursed (skip where symlink needs privilege) |
| R2.1 | `escapeRegExp` covers every metachar in the class |
| R2.2 | `toPosixPath("a\\b\\c")` === `"a/b/c"`; clean input unchanged |
| R2.3 | all 9 `expectedChanges.test.ts` cases pass unchanged after rewire (regression) |
| R3 | inside→abs; `../escape`→null; `..`→null; abs-inside→abs; abs-outside→null; `""`/`"."`→base; cross-drive→null |
| R4.1/R4.2 | `mcpError(new Error)` shape; `mcpError("str")`/`mcpError({})` use `String(e)` |
| R4.3/R4.4 | `extraLines` appended; thunk read at catch time (mutate captured counter inside fn, assert footer reflects new value) |
| R4.5 | `withMcpErrors` returns normal value untouched on no-throw |
| §4 type | `const _: CallToolResult = mcpError(...)` compiles |
| R5 | `log("a",1); log("b")` → `text()` === `"a 1\nb"`; `log()` pushes `""` |
| R6a | content + `lines: A-B / total` footer matches slice; `footer` hook appended |
| R6b | each preset deep-equals table; `satisfies ToolAnnotations` compiles |
| **R7.4** | fake factory; event inside active `suppress` → no bump, no onExternalChange |
| **R7.4 L2** | `expect(p)`, close suppress window, fire event for `p` → consumed, no bump |
| **R7.3** | unexpected path → `txId`+1, `onExternalChange(path)` once |
| **R7.5** | `expect`+`bump` in finally, throw in fn → `suppress` rejects, `suppressDepth` back to 0, `txId` bumped |
| R7.1 | `txId` getter; `bump` increments; `expect` delegates (assert `expected.size`) |
| §7 lifecycle | `start()` opens N watchers (fake records count); `stop()` closes all; double-`start` idempotent |
| §7 smoke | one real-`fs.watch` test, skippable to dodge Windows flakiness |
| R-G5 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green |

## Cross-domain boundary
- **In scope (this repo):** 8 new `src/*.ts` + 8 `test/*.test.ts`, 8 `src/index.ts` re-export lines, README sections, the one-line `expectedChanges.ts` rewire. No `package.json` dep changes (type-only SDK imports).
- **Out of scope (follow-up `construct3-chef` PRs):** `.packages-version` bump, deletion of inline copies, the `onExternalChange` callback body, and the `CancelledError`/reject-on-moved-txId logic. Connected via the `onExternalChange` seam + the documented `suppress`/`bump`/`expect`/`txId` idiom.
