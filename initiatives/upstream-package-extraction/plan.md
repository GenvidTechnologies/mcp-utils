# Plan: Add 7 Generic MCP/FS Utilities

> From approved `design.md`. One branch, §7 (OptimisticWatcher) last. TDD per task. Validation gate after every task: `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build`.

## Branch

`feat/upstream-mcp-fs-utilities` — cut from `main`. (`feat/` prefix matches recent commit style; no other branching convention in CLAUDE.md.)

## Summary

Add eight new source files (`strings.ts`, `walkFiles.ts`, `resolveWithin.ts`, `mcpError.ts`, `bufferingLogger.ts`, `mcpContent.ts`, `toolAnnotations.ts`, `optimisticWatcher.ts`) with mirrored tests, re-export each from `src/index.ts`, add README sections, and refactor `src/expectedChanges.ts` to delegate its inline `\\ → /` transform to the new `toPosixPath`. `OptimisticWatcher` is sequenced last and gated on all its test cases passing.

## Task order

| # | Task | Type | Agent | Depends on |
|---|------|------|-------|-----------|
| 0 | Install deps + baseline green | gate | ts-implementer | — |
| 1 | `strings.ts` + test + re-export | pure add (P) | ts-implementer | 0 |
| 2 | Refactor `expectedChanges.normalize` → `toPosixPath` | refactor (F) | ts-implementer | 1 |
| 3 | `walkFiles.ts` + test + re-export | pure add | ts-implementer | 0 |
| 4 | `resolveWithin.ts` + test + re-export | pure add | ts-implementer | 0 |
| 5 | `bufferingLogger.ts` + test + re-export | pure add | ts-implementer | 0 |
| 6 | `mcpError.ts` + test + re-export | pure add | ts-implementer | 0 |
| 7 | `toolAnnotations.ts` + test + re-export | pure add | ts-implementer | 0 |
| 8 | `mcpContent.ts` + test + re-export | pure add | ts-implementer | 0 |
| 10 | `optimisticWatcher.ts` + test + re-export | feature (F) | ts-implementer | 1, 2 |
| 9 | README sections for all 7 utilities | docs | tech-writer | 1–8, 10 |
| 11 | Final validation + code review | gate | code-reviewer | 1–10 |

Tasks 3–8 are independent. Task 2 must follow 1; Task 10 must follow 1 & 2.

---

## Tasks

### Task 0 — Install deps + baseline green (gate, no commit)
Run `pnpm install` then `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build`. Stop and surface if baseline is not green.

### Task 1 — feat(strings): add escapeRegExp and toPosixPath
**Create:** `src/strings.ts`, `test/strings.test.ts`. **Modify:** `src/index.ts` (`export { escapeRegExp, toPosixPath } from "./strings.js";`).
**Tests first:**
- `escapeRegExp` round-trips every metachar in `[.*+?^${}()|[\]\\]` (`new RegExp(escapeRegExp(c))` matches the literal).
- `escapeRegExp("")` → `""`; no-metachar string unchanged.
- `toPosixPath("a\\b\\c")` → `"a/b/c"`; `"a/b/c"` unchanged; `""` → `""`.
**Commit:** `feat(strings): add escapeRegExp and toPosixPath utilities`

### Task 2 — refactor(expectedChanges): delegate normalize to toPosixPath
**Modify:** `src/expectedChanges.ts` — add `import { toPosixPath } from "./strings.js";`; replace `normalize` body (line 17) with `return toPosixPath(p);`. **No new test.** Regression gate: all 9 existing `expectedChanges.test.ts` cases pass unchanged (incl. the two backslash tests).
**Commit:** `refactor(expectedChanges): delegate normalize() to shared toPosixPath`

### Task 3 — feat(walkFiles): recursive directory walker
**Create:** `src/walkFiles.ts`, `test/walkFiles.test.ts`. **Modify:** `src/index.ts`.
Hand-rolled over `fs.readdirSync(d, { withFileTypes: true })`. String filter = `endsWith`. Predicate = function. Missing dir → `[]`. Symlinked dirs not followed (`entry.isDirectory()`).
**Tests first:**
- String filter over nested temp tree returns matching subset.
- Predicate filter returns correct subset.
- `walkFiles("/no/such/dir", ".json")` → `[]`, no throw.
- non-ENOENT error (e.g. EACCES) propagates (monkey-patch `readdirSync` via `(obj as any)`).
- Symlinked subdir not recursed (`it.skip`-guard where symlink needs privilege).
**Commit:** `feat(walkFiles): add recursive directory walker with extension/predicate filter`

### Task 4 — feat(resolveWithin): path-traversal guard
**Create:** `src/resolveWithin.ts`, `test/resolveWithin.test.ts`. **Modify:** `src/index.ts`.
`path.resolve(base, rel)` + `path.relative` check; `""`/`"."` → base.
**Tests first:** inside→abs; `../outside`→null; nested `..` escape→null; abs-inside→abs (POSIX-guarded); abs-outside→null; `""`→base; `"."`→base; cross-drive (win32-guarded)→null.
**Commit:** `feat(resolveWithin): add path-traversal containment guard`

### Task 5 — feat(bufferingLogger): Logger capture utility
**Create:** `src/bufferingLogger.ts`, `test/bufferingLogger.test.ts`. **Modify:** `src/index.ts`.
Closure over `string[]`; imports `Logger` from `./types.js`.
**Tests first:** `log("a",1); log("b")` → `"a 1\nb"`; `log()` pushes `""`; fresh `text()` → `""`; accumulation; `Logger` type compiles.
**Commit:** `feat(bufferingLogger): add Logger capture utility`

### Task 6 — feat(mcpError): mcpError + withMcpErrors
**Create:** `src/mcpError.ts`, `test/mcpError.test.ts`. **Modify:** `src/index.ts`.
`import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"`.
**Tests first:** `mcpError(new Error("boom"))` → `{content:[{type:"text",text:"boom"}],isError:true}`; string/object use `String(e)`; `extraLines` → `"boom\nextra line"`; thunk read at catch time (mutate captured counter in `fn` before throw, assert footer reflects new value); `withMcpErrors(async()=>42)()` → `42`; `const _: CallToolResult = mcpError(...)` compiles.
**Risk:** `as T` cast may need `// eslint-disable-next-line @typescript-eslint/no-unsafe-return` (confirm rule status first).
**Commit:** `feat(mcpError): add mcpError and withMcpErrors MCP error-response helpers`

### Task 7 — feat(toolAnnotations): MCP annotation presets
**Create:** `src/toolAnnotations.ts`, `test/toolAnnotations.test.ts`. **Modify:** `src/index.ts`.
Four `as const satisfies ToolAnnotations` constants (type-only SDK import).
**Tests first:** each preset deep-equals its table row; `const _: ToolAnnotations = READ_ONLY` compiles; literal-type narrowing (`const x: true = READ_ONLY.readOnlyHint`).
**Commit:** `feat(toolAnnotations): add MCP tool annotation presets`

### Task 8 — feat(mcpContent): paginatedContent
**Create:** `src/mcpContent.ts`, `test/mcpContent.test.ts`. **Modify:** `src/index.ts`.
Wraps `paginateText`; footer `lines: <offset>-<offset+returned-1> / <totalLines>`; empty-page handling pinned in test.
**Tests first:** `paginatedContent("a\nb\nc\n",{offset:1,limit:2})` → text `"a\nb"` + footer `"lines: 1-2 / 3"` (pin EXACT joining vs consumer `server.ts:219-234`); offset 2 → `"lines: 2-3 / 3"`; `footer` hook appended after range; no `isError`; `const _: CallToolResult` compiles.
**Risk (load-bearing):** footer joining must byte-match consumer; read `construct3-chef/src/mcp/server.ts:219-234` first and pin full `content[0].text`.
**Commit:** `feat(mcpContent): add paginatedContent MCP response helper`

### Task 10 — feat(optimisticWatcher): OptimisticWatcher class (F-step, gated)
**Create:** `src/optimisticWatcher.ts`, `test/optimisticWatcher.test.ts`. **Modify:** `src/index.ts` (export class + `type { OptimisticWatcherOptions, WatcherFactory, WatchHandle }`).
Injectable `watcherFactory` (default wraps `fs.watch(dir,{recursive:true})`, normalizes filename via `toPosixPath`). Two-layer suppression: `suppressDepth` counter + `ExpectedChanges`. `suppress<T>(fn)` unwinds depth in `finally`. Cancelled-write-bumps-txId is caller responsibility (exposed `bump()`/`expect()`).
**Tests first (fake factory with `fire(filename)`):**
- `txId` starts 0; `bump()`→1; `expect(p)` delegates (`expected.size===1`).
- `start()` with 2 dirs → factory called twice; `stop()` closes both; double-`start` idempotent.
- External: fire unexpected path → `txId`+1, `onExternalChange(path)` once.
- Suppress L1: fire inside `suppress` → no bump, no callback.
- Suppress L2: `expect(p)`, fire `p` outside suppress → consumed, no bump.
- R7.5: `bump()` then throw inside `suppress` → rejects, `suppressDepth` back to 0 (`(w as any).suppressDepth`), `txId` reflects bump.
- `stop()` during active suppress → no events after close (JSDoc warns it's unsafe).
- Smoke: one real-`fs.watch` test, env-guarded skippable (`process.env.SKIP_FS_WATCH_TEST`).
**Hard gate:** all tests green before commit; no known-flaky test merged.
**Commit:** `feat(optimisticWatcher): add OptimisticWatcher with two-layer self-write suppression`

### Task 9 — docs(readme): document all 7 utilities (tech-writer)
**Modify:** `README.md` — one section per utility matching existing structure; document `OptimisticWatcher` suppress/bump/expect cancelled-write idiom; update intro. Sequence after Task 10 (API finalized).
**Commit:** `docs(readme): add API sections for 7 new MCP/FS utilities`

### Task 11 — Final validation + code review (code-reviewer)
Run full validate command. Review: ESM `.js` extensions on all new imports; `type` modifier on re-exported types; no stray `console.log` in `src/`; README accuracy.

---

## Risks
- **SDK import path under NodeNext** — proven (`exposeDocs.ts` uses same pattern); escape hatch `@modelcontextprotocol/sdk/dist/esm/types.js`.
- **§6a footer drift** — pin full `content[0].text` in test against consumer ref.
- **§7 Windows `fs.watch` flakiness** — deterministic fake-factory tests; smoke test env-guarded.
- **`stop()` during active `suppress`** — closed handles stop emitting; JSDoc warns; tested.
- **`withMcpErrors` `as T` cast** — targeted eslint-disable if flagged.
- **`resolveWithin` POSIX/Windows divergence** — platform-guarded tests.
- **Task 2 refactor regression** — guarded by 2 existing backslash tests; negligible given byte-identical `toPosixPath`.
