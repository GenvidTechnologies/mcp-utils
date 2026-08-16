# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@CONVENTIONS.md

## Overview

`@genvidtech/mcp-utils` is a small TypeScript library of shared, dependency-light utilities for building MCP (Model Context Protocol) servers. It is published publicly on npm under the `@genvidtech` scope. Each utility is independent — there is no central runtime or framework, just a flat set of helpers re-exported from `src/index.ts`.

**Read [`docs/code-review-context.md`](docs/code-review-context.md) when planning a change, not only when reviewing one.** Its title names the reviewer, but it holds this repo's **definition of done** — the five artifacts a new or changed utility must land together (implementation, `src/index.ts` re-export, tests, `README.md`, the `CLAUDE.md` utility list) and the release-affecting checks, including whether `CHANGELOG.md`'s `[Unreleased]` section describes the change. Consulting it only at review time turns each of those into a late finding and an extra commit; that is exactly how #12's `[Unreleased]` entry was missed until the review gate. It also lists the deliberate choices here that *look* like defects, which is worth knowing before you "fix" one.

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

CI runs on **GitHub Actions** via the shared `GenvidTechnologies/public-github-actions` recipe (formerly `genvid-holdings/genvid-public-ci` — the repo was both renamed and moved):

- `.github/workflows/ci.yml` — on PRs and pushes to `main`, calls the reusable `node-gate` (lint → typecheck → test → build).
- `.github/workflows/publish.yml` — on `v*.*.*` tags, re-runs the gate then publishes to npm via OIDC **trusted publishing** (`npm publish --provenance --access public`). A guard fails the run if the tag (minus `v`) doesn't equal `package.json` `version`.

To cut a release, prefer `/gvt-dev:release-npm-package` — it runs the sequence below with the state and tag==version assertions. By hand: move `CHANGELOG.md`'s `[Unreleased]` content into a dated `## [X.Y.Z]` section, bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version` — it updates all three manifest spots, `package.json` plus both in `package-lock.json`), land it on `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Tags are **lightweight**, not annotated. **The tag push is the publish trigger** — pushing the branch alone does nothing to npm.

**Version choice:** a change that alters an exported function's *observable output* takes a **minor** bump even when nothing was removed or renamed and semver would allow a patch. Consumers inherit the change silently, and the version number is the first signal they see. `walkFiles`' regular-file guarantee shipped as `0.6.0` for exactly this reason (#10) — it added an optional parameter and broke no signature, but stopped returning entries it used to return.

The first publish of a new package name requires a one-time npm bootstrap + Trusted Publisher registration (see the `public-github-actions` README). A **scope rename** (e.g. `@genvid`→`@genvidtech`) or a **repo move** counts as this case too: OIDC trusted publishing binds to the `org/repo/workflow`, so renaming the scope (new package name) or moving the repo invalidates the existing Trusted Publisher binding — re-register it for the new package/repo before the next tag-publish, or the publish job fails.

A repo/org rename also breaks the reusable-workflow references: the `uses:` lines in `ci.yml`/`publish.yml` must point at the **current canonical** repo path. GitHub's API (`gh api`, `gh repo view`) silently follows repo-rename redirects, but **Actions `uses:` does not** — so a stale reference passes every API check yet fails the run instantly with a 0s "workflow file issue". Confirm the canonical path with `gh api repos/<owner>/<repo> --jq .full_name` and update both workflow files. (This bit us migrating to `@genvidtech`: #9 left the references pointing at the old, redirect-only `genvid-public-ci` path.)

## Key conventions

- **ESM with `NodeNext` resolution.** Relative imports must use explicit `.js` extensions even though the source files are `.ts` (e.g. `export { ReadWriteLock } from "./rwlock.js"`). This is required, not optional — TypeScript resolves the `.js` to the sibling `.ts` at build time.
- **Entry points resolve to `dist/`.** `package.json` `main`/`types`/`exports` point at the built `dist/index.js` + `dist/index.d.ts`; `publishConfig` only carries `access: "public"`. (An earlier `publishConfig` field-override trick that swapped `src`→`dist` at publish time was dropped — npm 11.x no longer applies `main`/`types`/`exports` from `publishConfig`, which silently shipped source-pointing manifests.) Run `npm run build` before consuming the package locally. Add new public exports to `src/index.ts`.
- **Tests run on TypeScript directly** via `tsx` (`--import=tsx`), no pre-compilation. `test/setup.ts` is a Mocha root hook that silences `console.log`/`console.debug` per test (warn/error stay live) — diagnostic logging in utilities is expected and won't pollute test output.
- **Two tsconfigs:** `tsconfig.json` (build, `composite`, emits `src` → `dist`) and `tsconfig.test.json` (extends it, `noEmit`, includes `test/` too — this is what `typecheck` uses).
- Formatting/linting: Prettier + ESLint (`eslint:recommended` + `@typescript-eslint/recommended` + `prettier`). The unused-vars and `no-explicit-any` rules are intentionally disabled.
- **Never-throw helpers must guard caller-supplied callbacks.** This package's contract is "return a `CallToolResult`, never throw" (`mcpError`, `withMcpErrors`, `loadProjectConfig`). Any caller-supplied callback or thunk a helper invokes (e.g. `withMcpErrors`'s `extraLines` thunk / `onError` hook) must be wrapped so a throwing callback degrades gracefully — never escaping the helper. See `safeExtraLines` and the `onError` try/catch in `src/mcpError.ts`.
- **Testing error paths under ESM:** you cannot monkey-patch `node:*` namespace members (e.g. `(fs as any).readdirSync = …`) — ESM namespace objects are sealed/read-only in Node 22+. To make a built-in I/O call substitutable for a test (e.g. to simulate `EACCES`), accept the dependency as an optional parameter defaulting to the real implementation and have tests pass a stub. See `src/walkFiles.ts` (the `readdir` and `stat` parameters, defaulting to `fs.readdirSync` / `fs.statSync`) — this keeps the seam in the function signature rather than a shared mutable export, so there is no public-API leak and no cross-test shared state. Add a seam only for an error branch you cannot reach with a real fixture; prefer the real filesystem where it works (see the symlink note below).
- **Symlink tests on Windows: use junctions, not `"dir"` symlinks.** `fs.symlinkSync(target, link, "dir")` needs elevation or Developer Mode on Windows, so a test that uses it **silently skips** on an unprivileged machine (and in the `EPERM` guard `test/walkFiles.test.ts` uses) rather than failing — the test looks green while never running. `"junction"` needs no elevation, works unprivileged everywhere, and produces the identical dirent shape: `isDirectory()` is `false`, `isSymbolicLink()` is `true`. Node ignores the type argument on POSIX, so `process.platform === "win32" ? "junction" : "dir"` is portable. Broken symlinks, symlink-to-file, and symlink **cycles** are all creatable unprivileged too, so most filesystem edge cases need a real fixture rather than a stub. Keep the `EPERM`/`ENOSYS` skip guard anyway, and confirm in the CI log that such tests report `✔` rather than pending.

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/). Subject is `<type>(<scope>): <summary>` in the imperative mood, lowercase, no trailing period. Scope is the module or area (`walkFiles`, `ci`, `decisions`, `release`) and is omitted when the change is repo-wide.

Types in use here: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. Release commits are `chore(release): bump version to X.Y.Z`.

The body explains **why**, not what — the diff already shows what. Wrap at ~78 columns. Where a change alters observable behavior, say so explicitly in the body; this repo has no automatic mechanism that surfaces it otherwise.

Trailers: `Closes #N` for an issue the commit fully resolves, `Refs #N` for one it only touches. Note that `Closes #N` in **any** commit on a PR auto-closes the issue when the PR merges to `main`, independent of the PR body.

## Branching

Branch off `main` and name it `<type>/<kebab-slug>`, reusing the commit types — e.g. `fix/walkfiles-regular-files-only`, `chore/resync-conventions`. `main` is the default and is **not** protected, so release commits can be pushed to it directly; feature work still goes through a PR.

**Rebase, don't merge.** Keep a feature branch current with `git rebase origin/main` (or `git merge --ff-only`) so the PR diff stays free of merge noise. PRs are **squash-merged**, so a branch becomes one commit on `main` — the PR title becomes the squash subject, and intermediate commit messages are preserved only in the PR.

## Pull Request Format

GitHub, via `gh pr create`. Title follows the commit format (it becomes the squash subject). Body sections: `## Summary` (3-5 bullets: what, why, what reviewers should scrutinize), `## Changes` grouped by area, and `## Test plan` as a checklist.

Put the closing keyword in the **body**, not the title — a bare `(#N)` in a squash title cross-references the issue but never closes it.

Call out any observable behavior change in its own reviewer-facing note, and flag commits unrelated to the PR's stated purpose so a reviewer can mentally filter them (or ask for them to be split out).

## Utilities (`src/`)

**Concurrency & state**

- `rwlock.ts` — `ReadWriteLock`: promise-based, **write-preferring** RW lock. New reads queue behind pending writes to prevent writer starvation; `drain()` services the write queue before releasing queued readers.
- `expectedChanges.ts` — `ExpectedChanges`: tracks paths an MCP write tool is about to modify so a file watcher can suppress self-triggered change events. Entries auto-expire (TTL default 5000 ms); `consume()` checks+removes, `purgeExpired()` cleans stale entries.
- `optimisticWatcher.ts` — `OptimisticWatcher`: watches directories and classifies events as self-writes (suppressed) vs. external (forwarded to `onExternalChange`, bumps `txId`). Three-layer suppression: a synchronous `suppress(fn)` window (L1), `expect(path)` pre-registration built on `ExpectedChanges` (L2), and an `ObservedState` content-fingerprint ledger (L3) that collapses duplicate raw `fs.watch` events for one logical write into a single bump. `observed?: ObservedState | null` on `OptimisticWatcherOptions` — omitted constructs a default `ObservedState` (L3 on by default), `null` opts out. L1/L2 now also `record()` into the ledger when they suppress, so a path they've already accounted for doesn't separately trip L3. Rationale and rejected alternatives (incl. why no `size:mtimeMs` fingerprint ships): [ADR-0002](docs/decisions/0002-observed-state-collapses-duplicate-watch-events.md). Injectable `watcherFactory` seam for tests; default wraps `fs.watch({ recursive: true })`.
- `observedState.ts` — `ObservedState`: a bounded (LRU, default `maxEntries` 1000), pluggable-fingerprint path → content-fingerprint ledger. `isChanged(path)` is check-and-record (fingerprint, compare, store, return whether it differed — mirrors `ExpectedChanges.consume`'s check-and-remove); `record(path)` stores unconditionally; `forget(path)` evicts. Default `Fingerprinter` is the exported `contentFingerprint` (sha1 of file bytes; `"absent"` on `ENOENT`; a unique `error:<n>` token on any other read failure) — every failure mode fails open toward an extra bump, never toward staleness. `Fingerprinter` is an injectable seam: a consumer wanting a cheaper/less-precise comparison (e.g. `size:mtimeMs`) supplies their own; none is shipped here (see ADR-0002 for the measured collision rate that ruled it out as a default).

**Filesystem & path**

- `walkFiles.ts` — `walkFiles(dir, match, readdir?, stat?)`: recursively returns absolute paths of files matching a suffix string or predicate. **Guarantees every returned path is a regular file** — directories, symlinks to directories (incl. Windows junctions), broken symlinks and cycles are excluded even when their *name* matches; symlinks to regular files are kept, since reading them succeeds. Missing dir → `[]`; other `readdir` errors re-thrown; symlinked dirs not followed (which is also what bounds the walk). Classification is dirent-first, falling back to a resolving `stat` only for symlinks/special entries that already matched. A failed `stat` **drops the entry** rather than propagating — deliberately asymmetric with the `readdir` policy, because `throwIfNoEntry: false` suppresses only `ENOENT` (a cycle throws `ELOOP`), and failing to classify one leaf shouldn't abort a walk. Rationale and rejected alternatives: [ADR-0001](docs/decisions/0001-walkfiles-returns-only-regular-files.md). `readdir` and `stat` are injectable test seams (see ESM error-path note above).
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
