# Code Review Context

Project-specific context for `gvt-dev:code-reviewer` (and for humans reviewing a
PR here). The generic checklist in the agent body assumes a typical application
codebase; this document layers in what is actually true of **this** package.

Authoritative sources this doc points at rather than duplicates:

- [`../CLAUDE.md`](../CLAUDE.md) — commands, release process, key conventions,
  and the per-utility overview. It is the de-facto architecture reference.
- [`../README.md`](../README.md) — user-facing API documentation.
- [`decisions/`](decisions/) — ADRs for non-trivial trade-offs.

## What this package is

`@genvidtech/mcp-utils` is a **published, public npm library** of independent,
dependency-light helpers for building MCP servers. There is no runtime, no
framework, no wiring — just a flat set of modules re-exported from
`src/index.ts`.

Two consequences shape every review:

1. **Everything exported is public API.** There are no internal consumers to
   absorb a breaking change; downstream servers pick it up on their next
   `npm install`. Signature changes, renamed options, and changed return shapes
   are all consumer-visible.
2. **Observable behavior changes are silent.** Nothing in this repo
   automatically surfaces them — no runtime deprecation warnings, no consumer
   test suite. The commit body, the PR note, and the CHANGELOG are the only
   channels. See "Release-affecting checks" below.

## Invariants to review against

### Never-throw helpers

`mcpError`, `withMcpErrors`, `loadProjectConfig`, and `resolveRootFolder` all
contract to **return a `CallToolResult` (or a result union), never throw**. The
corollary is the part most easily missed in review: any *caller-supplied*
callback or thunk such a helper invokes must be wrapped so a throwing callback
degrades gracefully instead of escaping. See `safeExtraLines` and the `onError`
try/catch in `src/mcpError.ts` for the established shape.

- [ ] A new never-throw helper has no unguarded path out.
- [ ] Any new caller-supplied callback is invoked inside a guard.
- [ ] The tests cover the throwing-callback case, not just the happy path.

### Backward-compatible dual-form options

`mcpError(e, optsOrExtraLines?)` and `withMcpErrors(fn, opts?)` each accept a
**legacy positional form** (`string[]` / `() => string[]`) *and* an options
object. Both forms are shipped API. A change that simplifies one of these down
to a single form is a breaking change, not a cleanup.

- [ ] Existing legacy-form call sites still typecheck and behave identically.
- [ ] A new option added to the object form does not alter the legacy path.

### ESM with `NodeNext` resolution

Relative imports must carry explicit `.js` extensions even though the sources
are `.ts` (`export { walkFiles } from "./walkFiles.js"`). This is required, not
stylistic — flag a missing extension as a build failure, not a nit.

### Test seams, not monkey-patching

ESM namespace objects are sealed in Node 22+, so `node:*` members cannot be
patched in tests. The established pattern is an **optional parameter defaulting
to the real implementation** (see `readdir` / `stat` in `src/walkFiles.ts`,
`env` / `readdir` in `src/resolveRootFolder.ts`, `readFile` in
`src/loadProjectConfig.ts`).

- [ ] A new seam exists only for an error branch a real fixture can't reach.
      Prefer the real filesystem where it works.
- [ ] The seam lives in the function signature — not a shared mutable export,
      which would leak into the public API and share state across tests.

### Windows-safe filesystem tests

`fs.symlinkSync(target, link, "dir")` needs elevation on Windows, so a test
using it **silently skips** on an unprivileged machine instead of failing — the
suite looks green while the test never ran. Use
`process.platform === "win32" ? "junction" : "dir"`; junctions need no
elevation and produce an identical dirent shape.

- [ ] New symlink fixtures use the junction-on-win32 form.
- [ ] A test guarded by an `EPERM`/`ENOSYS` skip is confirmed to report `✔`
      in CI rather than pending. **A skipped test is not a passing test** —
      this is the local instance of guardrail 7 (name the evidence, or report
      the gap).

**The expected pending baseline is exactly one, and it is not a symlink test.**
On Windows the suite reports `1 pending`: `test/resolveWithin.test.ts:49`, a
POSIX-only case that legitimately skips on `win32` (its `win32` counterpart at
`:65` runs instead). The `walkFiles` `EPERM` guards at `test/walkFiles.test.ts:26`
and `:95` do **not** skip on an unprivileged Windows machine — junctions need no
elevation — so they must show `✔`. A second pending entry means a filesystem
test silently stopped running; find it rather than accepting the green.

### Dependency weight

"Dependency-light" is a design constraint, not a slogan. Current runtime deps
are `@modelcontextprotocol/sdk` alone; `zod` is a **peerDependency** consumed
only via `import type { ZodType }`. Adding a runtime dependency, or promoting
`zod` from a type-only import to a value import, is an architectural decision
that warrants a decision record.

### Factual accuracy of prose against its source data

No gate in this repo reads prose. Lint, `tsc`, and the full suite are all green
on a docstring that states the exact opposite of what the code does, so
docstrings, ADR bodies, README claims, and commit bodies are the one artifact
class where "the checks passed" carries no signal at all. Where a change is
justified by measurements — a probe table, a benchmark, a platform matrix —
**diff every rendered claim against the source data before committing.**

Rationale comments are the sharpest case: they exist to steer a future reader,
so an inverted one argues *for* the change it was written to prevent.

Three real instances from the #12 branch, all committed-clean by every
automated gate before being caught by hand:

- An ADR asserted a `statFingerprint` symbol "exists internally but is not
  exported." It was never written. A maintainer would have gone looking for it.
- `OptimisticWatcher`'s JSDoc listed "a fingerprinter that can't observe a real
  difference" among the *fail-open* guarantees. That case is the exact opposite
  — a fingerprint collision suppresses a real change, which is staleness, the
  one failure the design exists to prevent. It cited the failure mode as proof
  of safety.
- The ADR said "L1 and L2 are untouched" one commit before both gained a
  `record()` call — and those calls are load-bearing, not incidental.

- [ ] Every measured figure in shipped text traces to data produced this
      change, not transcribed from the issue that proposed it. An issue's
      numbers may not reproduce — see the corrections table on
      [#12](https://github.com/GenvidTechnologies/mcp-utils/issues/12).
- [ ] No prose names a symbol, file, or option that doesn't exist.
- [ ] A later task in the same branch didn't falsify a comment an earlier one
      wrote. Only a whole-branch view catches this; the suite never will.

## Deliberate choices — do not flag these

Checking these first is guardrail 1 ("check intended behavior first") made
concrete for this repo.

| Looks like a defect | Why it isn't |
|---|---|
| `any` in `withMcpErrors`'s generic constraint; unused vars | `@typescript-eslint/no-explicit-any` and both unused-vars rules are **intentionally off** in `.eslintrc.cjs`. |
| `console.log` / `console.debug` inside utilities | Diagnostic logging is expected; `test/setup.ts` silences both per test (warn/error stay live). |
| `walkFiles` re-throws `readdir` errors but silently **drops** an entry whose `stat` fails | Deliberately asymmetric — `throwIfNoEntry: false` suppresses only `ENOENT` (a cycle throws `ELOOP`), and failing to classify one leaf shouldn't abort a walk. Rationale in [ADR-0001](decisions/0001-walkfiles-returns-only-regular-files.md). |
| `resolveRootFolder` applies **no containment check** to `explicit`/`env` overrides | Intended: an explicit override is trusted. Only *discovery* is confined to `cwd`. |
| `resolveWithin` never touches the filesystem, so it doesn't resolve symlinks | It is a **lexical** traversal guard by design. Don't ask it to `realpath`. |
| `package.json` `main`/`types`/`exports` point at `dist/` with a bare `publishConfig` | The old `publishConfig` field-override trick was removed — npm 11.x no longer applies it and silently shipped source-pointing manifests. Don't restore it. |
| No `docs/architecture.md`, `design-patterns.md`, or `coding-conventions.md` | Intentional for a flat utility library; `CLAUDE.md` + `README.md` cover those dimensions. See the comment at the foot of [`TOC.md`](TOC.md). |
| A feature branch leaves `package.json` `version` and `package-lock.json` untouched, even when its ADR or commit body says "ships as X.Y.Z" | Correct. The bump is its own `chore(release): bump version to X.Y.Z` commit made with `npm version` at release time — that updates the manifest and **both** lockfile spots together, and the publish workflow's tag==version guard checks against it. Naming the target version in an ADR is a *version-choice* decision, not an instruction to bump in the feature PR. Flagging the missing bump as a blocker sends the branch outside the documented release flow. |

## Adding or changing a utility

A new utility is only complete when **all five** land together. A PR missing any
of them is an incomplete change, not a follow-up:

- [ ] `src/<name>.ts` — the implementation.
- [ ] `src/index.ts` — the re-export (types exported with `export type`).
- [ ] `test/<name>.test.ts` — tests.
- [ ] `README.md` — user-facing API docs for the new export.
- [ ] `CLAUDE.md` — an entry in the per-utility list, under the right heading.

## Release-affecting checks

- [ ] **Does this change an exported function's observable output?** If so it
      takes a **minor** bump even when no signature changed and semver would
      allow a patch — consumers inherit it silently. `walkFiles`' regular-file
      guarantee shipped as `0.6.0` for exactly this reason (#10).
- [ ] Is the behavior change stated **explicitly** in the commit body and called
      out in its own reviewer-facing PR note? Nothing else surfaces it.
- [ ] Does `CHANGELOG.md`'s `[Unreleased]` section describe it?
- [ ] Do the `uses:` lines in `.github/workflows/*.yml` point at the **current
      canonical** repo path? Actions `uses:` does *not* follow repo-rename
      redirects even though `gh api` does — a stale reference passes every API
      check and then fails the run instantly.

## Five-dimension coverage, applied here

For the agent's implementation / design / architecture / purpose / compromise
walk, the homes in this repo are:

| Dimension | Where it belongs |
|---|---|
| Implementation | The code and its TSDoc |
| Design | `README.md` (the consumer-facing contract) |
| Architecture | `CLAUDE.md`'s per-utility list and key conventions |
| Purpose | The linked issue — docs link it rather than restating the narrative |
| Compromise | `docs/decisions/` (an ADR), never a code comment or a plan file |
