# Capture: excerpts on checks that report success while not checking

- **Captured:** 2026-08-16
- **Captured by:** `/gvt-dev:maintain-wiki ingest`
- **Repo state:** `mcp-utils` @ `74c0c0fa46943ecd400dd8583ca2641b15ab1711`
  (committed 2026-08-16T09:34:20-04:00). Working tree clean for every file
  excerpted below, so each excerpt is faithful to that commit.

Purpose of this capture: five instances of the same failure shape — an
automated check that passes without having checked — were documented
independently across four documents and never assembled. This file freezes the
relevant passages verbatim so the wiki page synthesizing them stays
re-verifiable even as the sources evolve.

**Provenance caveat:** excerpt 1 is drawn from the operator's *machine-global*
`~/.claude/CLAUDE.md`, which is outside this repo and therefore **not** pinned
by the SHA above. It is reproduced here as captured on 2026-08-16; treat its
currency accordingly. Excerpts 2–6 are all in-repo and pinned.

---

## Excerpt 1 — machine-global `CLAUDE.md`, "No Python — and its absence fails *quietly*"

> Source: `C:\Users\FabienNinoles\.claude\CLAUDE.md` (not in this repo; captured 2026-08-16)

> `python` / `python3` are **not installed** on this machine. What makes this worth
> a rule rather than a shrug is the failure mode: Windows ships an **App Execution
> Alias** stub at those names which prints `Python was not found; run without
> arguments to install from the Microsoft Store...` **to stdout** and does *not*
> reliably set a non-zero exit status. So a `python3 - <<'PY' ... PY` heredoc
> **silently does nothing**, the surrounding `&&` chain keeps going, and whatever
> you run next reports on unmodified state as though the script had succeeded.
>
> Use the **Edit/Write tools** for file edits, or `node` for scripted logic (it is
> installed). If you must shell out to a scripted edit, verify the edit landed
> (`grep` the changed text, or `git diff`) before acting on any result that depends
> on it — the exit status will not tell you.
>
> Observed 2026-08-14 in construct3-chef: a mutation-test step used a `python3`
> heredoc to inject a deliberate defect, the injection never happened, and the test
> suite came back green — which read as "my test is vacuous" and nearly triggered a
> rewrite of a perfectly good test.

---

## Excerpt 2 — project `CLAUDE.md`, symlink tests on Windows

> Source: `CLAUDE.md`, "Key conventions" section

> **Symlink tests on Windows: use junctions, not `"dir"` symlinks.**
> `fs.symlinkSync(target, link, "dir")` needs elevation or Developer Mode on Windows,
> so a test that uses it **silently skips** on an unprivileged machine (and in the
> `EPERM` guard `test/walkFiles.test.ts` uses) rather than failing — the test looks
> green while never running. `"junction"` needs no elevation, works unprivileged
> everywhere, and produces the identical dirent shape: `isDirectory()` is `false`,
> `isSymbolicLink()` is `true`. Node ignores the type argument on POSIX, so
> `process.platform === "win32" ? "junction" : "dir"` is portable. Broken symlinks,
> symlink-to-file, and symlink **cycles** are all creatable unprivileged too, so most
> filesystem edge cases need a real fixture rather than a stub. Keep the
> `EPERM`/`ENOSYS` skip guard anyway, and confirm in the CI log that such tests
> report `✔` rather than pending.

---

## Excerpt 3 — `docs/code-review-context.md:76-96`, Windows-safe filesystem tests

> Source: `docs/code-review-context.md`, "### Windows-safe filesystem tests"

> `fs.symlinkSync(target, link, "dir")` needs elevation on Windows, so a test
> using it **silently skips** on an unprivileged machine instead of failing — the
> suite looks green while the test never ran. Use
> `process.platform === "win32" ? "junction" : "dir"`; junctions need no
> elevation and produce an identical dirent shape.
>
> - [ ] New symlink fixtures use the junction-on-win32 form.
> - [ ] A test guarded by an `EPERM`/`ENOSYS` skip is confirmed to report `✔`
>       in CI rather than pending. **A skipped test is not a passing test** —
>       this is the local instance of guardrail 7 (name the evidence, or report
>       the gap).
>
> **The expected pending baseline is exactly one, and it is not a symlink test.**
> On Windows the suite reports `1 pending`: `test/resolveWithin.test.ts:49`, a
> POSIX-only case that legitimately skips on `win32` (its `win32` counterpart at
> `:65` runs instead). The `walkFiles` `EPERM` guards at `test/walkFiles.test.ts:26`
> and `:95` do **not** skip on an unprivileged Windows machine — junctions need no
> elevation — so they must show `✔`. A second pending entry means a filesystem
> test silently stopped running; find it rather than accepting the green.

---

## Excerpt 4 — `docs/code-review-context.md:106-137`, factual accuracy of prose

> Source: `docs/code-review-context.md`, "### Factual accuracy of prose against its source data"

> No gate in this repo reads prose. Lint, `tsc`, and the full suite are all green
> on a docstring that states the exact opposite of what the code does, so
> docstrings, ADR bodies, README claims, and commit bodies are the one artifact
> class where "the checks passed" carries no signal at all. Where a change is
> justified by measurements — a probe table, a benchmark, a platform matrix —
> **diff every rendered claim against the source data before committing.**
>
> Rationale comments are the sharpest case: they exist to steer a future reader,
> so an inverted one argues *for* the change it was written to prevent.
>
> Three real instances from the #12 branch, all committed-clean by every
> automated gate before being caught by hand:
>
> - An ADR asserted a `statFingerprint` symbol "exists internally but is not
>   exported." It was never written. A maintainer would have gone looking for it.
> - `OptimisticWatcher`'s JSDoc listed "a fingerprinter that can't observe a real
>   difference" among the *fail-open* guarantees. That case is the exact opposite
>   — a fingerprint collision suppresses a real change, which is staleness, the
>   one failure the design exists to prevent. It cited the failure mode as proof
>   of safety.
> - The ADR said "L1 and L2 are untouched" one commit before both gained a
>   `record()` call — and those calls are load-bearing, not incidental.
>
> - [ ] Every measured figure in shipped text traces to data produced this
>       change, not transcribed from the issue that proposed it. An issue's
>       numbers may not reproduce — see the corrections table on
>       [#12](https://github.com/GenvidTechnologies/mcp-utils/issues/12).
> - [ ] No prose names a symbol, file, or option that doesn't exist.
> - [ ] A later task in the same branch didn't falsify a comment an earlier one
>       wrote. Only a whole-branch view catches this; the suite never will.

---

## Excerpt 5 — project `CLAUDE.md` + `docs/code-review-context.md:175-178`, Actions `uses:` redirects

> Source: `CLAUDE.md`, "Commands" section

> A repo/org rename also breaks the reusable-workflow references: the `uses:` lines
> in `ci.yml`/`publish.yml` must point at the **current canonical** repo path.
> GitHub's API (`gh api`, `gh repo view`) silently follows repo-rename redirects,
> but **Actions `uses:` does not** — so a stale reference passes every API check yet
> fails the run instantly with a 0s "workflow file issue". Confirm the canonical
> path with `gh api repos/<owner>/<repo> --jq .full_name` and update both workflow
> files. (This bit us migrating to `@genvidtech`: #9 left the references pointing at
> the old, redirect-only `genvid-public-ci` path.)

> Source: `docs/code-review-context.md`, "## Release-affecting checks"

> - [ ] Do the `uses:` lines in `.github/workflows/*.yml` point at the **current
>       canonical** repo path? Actions `uses:` does *not* follow repo-rename
>       redirects even though `gh api` does — a stale reference passes every API
>       check and then fails the run instantly.

---

## Excerpt 6 — `docs/decisions/0001-walkfiles-returns-only-regular-files.md:65-72`, `throwIfNoEntry`

> Source: ADR-0001, "## Compromise"

> **Rejected: re-throwing non-`ENOENT` stat failures** to mirror the `readdir` policy
> literally. `fs.statSync`'s `throwIfNoEntry: false` option suppresses only `ENOENT` — it
> does not make `statSync` total. Verified by probe on Node 24.11.1 / win32: a symlink
> cycle throws `ELOOP` straight through it. Re-throwing would therefore have converted a
> walk that merely returned a bad path into a walk that *throws*, handing callers a new
> failure mode they never opted into, in the name of fixing a wrong-result bug. (Issue #10
> proposed the resolved-`stat` mechanism but assumed `throwIfNoEntry: false` was
> sufficient; its body has been corrected.)

Related, from the same record's "## Compromise" — the same shape applied to a
*reviewer's* eye rather than a machine's:

> **Rejected: bare `entry.isFile()`.** It fixes the reported bug with zero extra syscalls,
> and is superficially consistent with the existing "symlinks are not followed" stance.
> But `entry.isFile()` is `false` for *every* symlink, including one pointing at a regular
> file — a case that works correctly today. Adopting it would silently drop those entries:
> a regression shipped inside a bugfix, invisible to consumers until something went
> missing. Only a resolved `stat` is correct across all five entry kinds.
