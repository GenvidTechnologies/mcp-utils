# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`genvid-mcp-utils` is a small TypeScript library of shared, dependency-light utilities for building MCP (Model Context Protocol) servers. It is a private package consumed within the Genvid monorepo, not published publicly. Each utility is independent — there is no central runtime or framework, just a flat set of helpers re-exported from `src/index.ts`.

## Commands

Uses **pnpm** (see `pnpm-lock.yaml`). Node >= 22 is required.

```bash
pnpm install            # install deps (CI uses --no-frozen-lockfile)
pnpm run build          # tsc → dist/ (emits .js, .d.ts, declaration + source maps)
pnpm run lint           # eslint, --max-warnings 0 over src/ and test/
pnpm run typecheck      # tsc -p tsconfig.test.json --noEmit (typechecks src AND test)
pnpm run test           # mocha over test/**/*.test.ts
```

Run a single test file or filter by name:

```bash
pnpm exec mocha --timeout 5000 --import=tsx --require ./test/setup.ts test/rwlock.test.ts --exit
pnpm exec mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit --grep "write-preferring"
```

CI (CircleCI, `.circleci/config.yml`) runs lint → typecheck → test → build in order, inside a 1Password/Azure-authenticated shell.

## Key conventions

- **ESM with `NodeNext` resolution.** Relative imports must use explicit `.js` extensions even though the source files are `.ts` (e.g. `export { ReadWriteLock } from "./rwlock.js"`). This is required, not optional — TypeScript resolves the `.js` to the sibling `.ts` at build time.
- **Dual entry points.** During development `package.json` `main`/`exports` point at `src/index.ts` (run directly via `tsx`). On publish, `publishConfig` rewrites them to `dist/index.js` + `dist/index.d.ts`. Add new public exports to `src/index.ts`.
- **Tests run on TypeScript directly** via `tsx` (`--import=tsx`), no pre-compilation. `test/setup.ts` is a Mocha root hook that silences `console.log`/`console.debug` per test (warn/error stay live) — diagnostic logging in utilities is expected and won't pollute test output.
- **Two tsconfigs:** `tsconfig.json` (build, `composite`, emits `src` → `dist`) and `tsconfig.test.json` (extends it, `noEmit`, includes `test/` too — this is what `typecheck` uses).
- Formatting/linting: Prettier + ESLint (`eslint:recommended` + `@typescript-eslint/recommended` + `prettier`). The unused-vars and `no-explicit-any` rules are intentionally disabled.

## Utilities (`src/`)

- `rwlock.ts` — `ReadWriteLock`: promise-based, **write-preferring** RW lock. New reads queue behind pending writes to prevent writer starvation; `drain()` services the write queue before releasing queued readers.
- `expectedChanges.ts` — `ExpectedChanges`: tracks paths an MCP write tool is about to modify so a file watcher can suppress self-triggered change events. Entries auto-expire (TTL default 5000 ms); `consume()` checks+removes, `purgeExpired()` cleans stale entries.
- `pagination.ts` — `paginateText`: line-based pagination with 1-based `offset`/`limit`; a trailing newline is not counted as a line.
- `exposeDocs.ts` — `exposeDocs(server, packageDir)`: registers MCP resources serving `docs/*.md` (templated `docs:///{name}`) and `README.md` (`docs:///readme`) from a consuming package's directory.
- `types.ts` — `Logger` type, a minimal logging interface used across utilities.

When adding a utility: implement in `src/<name>.ts`, re-export from `src/index.ts`, add `test/<name>.test.ts`, and document it in `README.md` (the README is user-facing API docs for this package).
