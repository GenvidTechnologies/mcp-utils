# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@genvidtech/mcp-utils` is a small TypeScript library of shared, dependency-light utilities for building MCP (Model Context Protocol) servers. It is published publicly on npm under the `@genvidtech` scope. Each utility is independent — there is no central runtime or framework, just a flat set of helpers re-exported from `src/index.ts`.

## Commands

Uses **npm** (see `package-lock.json`). Node >= 22 is required.

```bash
npm install             # install deps (CI uses `npm ci` against package-lock.json)
npm run build           # tsc → dist/ (emits .js, .d.ts, declaration + source maps)
npm run lint            # eslint, --max-warnings 0 over src/ and test/
npm run typecheck       # tsc -p tsconfig.test.json --noEmit (typechecks src AND test)
npm run test            # mocha over test/**/*.test.ts
```

Run a single test file or filter by name:

```bash
npx mocha --timeout 5000 --import=tsx --require ./test/setup.ts test/rwlock.test.ts --exit
npx mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit --grep "write-preferring"
```

CI runs on **GitHub Actions** via the shared `genvid-public-ci` recipe:

- `.github/workflows/ci.yml` — on PRs and pushes to `main`, calls the reusable `node-gate` (lint → typecheck → test → build).
- `.github/workflows/publish.yml` — on `v*.*.*` tags, re-runs the gate then publishes to npm via OIDC **trusted publishing** (`npm publish --provenance --access public`). A guard fails the run if the tag (minus `v`) doesn't equal `package.json` `version`.

To cut a release: bump `version` in `package.json`, merge to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The first publish of a new package name requires a one-time npm bootstrap + Trusted Publisher registration (see the `genvid-public-ci` README).

## Key conventions

- **ESM with `NodeNext` resolution.** Relative imports must use explicit `.js` extensions even though the source files are `.ts` (e.g. `export { ReadWriteLock } from "./rwlock.js"`). This is required, not optional — TypeScript resolves the `.js` to the sibling `.ts` at build time.
- **Entry points resolve to `dist/`.** `package.json` `main`/`types`/`exports` point at the built `dist/index.js` + `dist/index.d.ts`; `publishConfig` only carries `access: "public"`. (An earlier `publishConfig` field-override trick that swapped `src`→`dist` at publish time was dropped — npm 11.x no longer applies `main`/`types`/`exports` from `publishConfig`, which silently shipped source-pointing manifests.) Run `npm run build` before consuming the package locally. Add new public exports to `src/index.ts`.
- **Tests run on TypeScript directly** via `tsx` (`--import=tsx`), no pre-compilation. `test/setup.ts` is a Mocha root hook that silences `console.log`/`console.debug` per test (warn/error stay live) — diagnostic logging in utilities is expected and won't pollute test output.
- **Two tsconfigs:** `tsconfig.json` (build, `composite`, emits `src` → `dist`) and `tsconfig.test.json` (extends it, `noEmit`, includes `test/` too — this is what `typecheck` uses).
- Formatting/linting: Prettier + ESLint (`eslint:recommended` + `@typescript-eslint/recommended` + `prettier`). The unused-vars and `no-explicit-any` rules are intentionally disabled.
- **Never-throw helpers must guard caller-supplied callbacks.** This package's contract is "return a `CallToolResult`, never throw" (`mcpError`, `withMcpErrors`, `loadProjectConfig`). Any caller-supplied callback or thunk a helper invokes (e.g. `withMcpErrors`'s `extraLines` thunk / `onError` hook) must be wrapped so a throwing callback degrades gracefully — never escaping the helper. See `safeExtraLines` and the `onError` try/catch in `src/mcpError.ts`.
- **Testing error paths under ESM:** you cannot monkey-patch `node:*` namespace members (e.g. `(fs as any).readdirSync = …`) — ESM namespace objects are sealed/read-only in Node 22+. To make a built-in I/O call substitutable for a test (e.g. to simulate `EACCES`), accept the dependency as an optional parameter defaulting to the real implementation and have tests pass a stub. See `src/walkFiles.ts` (the `readdir` parameter defaulting to `fs.readdirSync`) — this keeps the seam in the function signature rather than a shared mutable export, so there is no public-API leak and no cross-test shared state.

## Utilities (`src/`)

**Concurrency & state**

- `rwlock.ts` — `ReadWriteLock`: promise-based, **write-preferring** RW lock. New reads queue behind pending writes to prevent writer starvation; `drain()` services the write queue before releasing queued readers.
- `expectedChanges.ts` — `ExpectedChanges`: tracks paths an MCP write tool is about to modify so a file watcher can suppress self-triggered change events. Entries auto-expire (TTL default 5000 ms); `consume()` checks+removes, `purgeExpired()` cleans stale entries.
- `optimisticWatcher.ts` — `OptimisticWatcher`: watches directories and classifies events as self-writes (suppressed) vs. external (forwarded to `onExternalChange`, bumps `txId`). Two-layer suppression: a synchronous `suppress(fn)` window plus `expect(path)` pre-registration (built on `ExpectedChanges`). Injectable `watcherFactory` seam for tests; default wraps `fs.watch({ recursive: true })`.

**Filesystem & path**

- `walkFiles.ts` — `walkFiles(dir, match, readdir?)`: recursively returns absolute paths of files matching a suffix string or predicate. Missing dir → `[]`; other I/O errors re-thrown; symlinked dirs not followed. `readdir` is an injectable test seam (see ESM error-path note above).
- `resolveWithin.ts` — `resolveWithin(base, rel)`: lexical path-traversal guard. Returns the resolved absolute path only if it stays within `base`, else `null`. No filesystem access / no symlink resolution.
- `resolveRootFolder.ts` — `resolveRootFolder(opts, env?, readdir?)`: resolves a project root via four-level precedence `explicit > env > discovery > cwd`; `opts.marker` names the filesystem entry that identifies a root (required, non-empty). `explicit`/`env` overrides are resolved against `cwd` with **no containment restriction**; discovery searches child directories up to `opts.searchDepth` (default 1) within `cwd` only. Returns `ResolvedRoot { path, source }` — **never throws**; ambiguous discovery (≥2 matches) and blank marker return `mcpError`; `ENOENT` is silently skipped, other I/O errors are `mcpError`. `source: "cwd"` signals the silent fallback (no marker found anywhere). `env` and `readdir` are injectable test seams.
- `loadProjectConfig.ts` — `loadProjectConfig(projectRoot, fileName, schema, overrides?, opts?, readFile?)`: reads + JSON-parses a project-root config, shallow-merges `opts.defaults < file < overrides`, validates against a consumer-supplied **zod** schema, and asserts `opts.containedPaths` keys stay within `projectRoot` via `resolveWithin`. Returns `T | CallToolResult` — **never throws**; failures (missing required file, parse error, schema violation, path escape) come back as `mcpError`. `isMcpError` narrows the union. `zod` is a **peerDependency** (only `import type { ZodType }` is used). `readFile` is an injectable test seam.

**Strings**

- `strings.ts` — `escapeRegExp` (escape regex metacharacters for literal `RegExp` use) and `toPosixPath` (backslashes → forward slashes).

**MCP response/error/annotation helpers**

- `mcpError.ts` — `mcpError(e, optsOrExtraLines?)` converts a caught value into a `CallToolResult` with `isError: true`; the second arg is the legacy `string[]` extraLines **or** `{ prefix?, extraLines? }` (opt-in `prefix` prepends `` `${prefix} ${message}` ``, default none). `withMcpErrors(fn, opts?)` wraps an async handler so thrown errors return `mcpError(...)`; the second arg is the legacy **catch-time thunk** `() => string[]` **or** `{ extraLines?, onError?, prefix? }`. `onError(err)` is an awaited side-effect hook run **before** formatting (e.g. bump a watcher on the error path); if it throws, the thrown value is formatted and `withMcpErrors` still never throws out. `prefix` is passed through to `mcpError`.
- `mcpContent.ts` — `paginatedContent(text, opts, footer?)`: wraps `paginateText` into a `CallToolResult` whose text combines the page and a `lines: A-B / total` footer (emitted only when `offset`/`limit` was supplied); optional caller `footer(r)` appended on a new line. `mcpContent(text, footer?)`: the success-path counterpart to `mcpError` — single text block joining a result and an optional trailing `footer` string (e.g. `txId: <n>`) with `"\n"`; no `isError`.
- `pagination.ts` — `paginateText`: line-based pagination with 1-based `offset`/`limit`; a trailing newline is not counted as a line. Exports `PaginationOptions` / `PaginatedResult`.
- `toolAnnotations.ts` — `READ_ONLY`, `REGENERATE`, `MUTATE`, `NON_IDEMPOTENT_READ`: `ToolAnnotations` presets for registering MCP tools (set `readOnlyHint` / `destructiveHint` / `idempotentHint`).
- `exposeDocs.ts` — `exposeDocs(server, packageDir)`: registers MCP resources serving `docs/*.md` (templated `docs:///{name}`) and `README.md` (`docs:///readme`) from a consuming package's directory.

**Shared types**

- `bufferingLogger.ts` — `bufferingLogger()`: a `Logger` that buffers log calls in memory; returns `{ log, text }` where `text()` joins buffered lines with `"\n"`.
- `types.ts` — `Logger` type, a minimal logging interface used across utilities.

When adding a utility: implement in `src/<name>.ts`, re-export from `src/index.ts`, add `test/<name>.test.ts`, and document it in `README.md` (the README is user-facing API docs for this package). Keep this list in sync.
