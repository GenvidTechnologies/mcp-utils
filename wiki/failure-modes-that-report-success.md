---
type: practice-note
title: Failure modes that report success
description: Six ways a check on this stack passes without having checked — and the evidence rule that catches them.
tags: [verification, testing, windows, ci, tooling]
status: stable
stale_after: 2027-02-16
generated: { by: process:maintain-wiki, at: 2026-08-16T14:31:07Z }
sources:
  - id: capture
    resource: ../raw/2026-08-16-verification-traps-excerpts.md
    title: Assembled verbatim excerpts, captured 2026-08-16
    last_modified: 2026-08-16
  - id: claude-md
    resource: https://github.com/GenvidTechnologies/mcp-utils/blob/74c0c0fa46943ecd400dd8583ca2641b15ab1711/CLAUDE.md
    title: Project CLAUDE.md at 74c0c0f
  - id: review-ctx
    resource: https://github.com/GenvidTechnologies/mcp-utils/blob/74c0c0fa46943ecd400dd8583ca2641b15ab1711/docs/code-review-context.md
    title: docs/code-review-context.md at 74c0c0f
  - id: adr-0001
    resource: https://github.com/GenvidTechnologies/mcp-utils/blob/74c0c0fa46943ecd400dd8583ca2641b15ab1711/docs/decisions/0001-walkfiles-returns-only-regular-files.md
    title: ADR-0001 at 74c0c0f
  - id: global-claude-md
    resource: C:/Users/FabienNinoles/.claude/CLAUDE.md
    title: Machine-global CLAUDE.md (local path; NOT publicly resolvable, not pinned by the repo SHA)
    last_modified: 2026-08-16
  - id: selfreport
    resource: ../raw/2026-08-16-subagent-self-report-discrepancy.md
    title: Subagent self-report vs. measured artifact, captured 2026-08-16 (session-local transcript; no public upstream, cannot be re-fetched)
    last_modified: 2026-08-16
---

# Failure modes that report success

On this stack, several independent checks share one failure mode: they **report
success without having checked**. A test that silently skips still prints
green. A shell command that no-ops still lets `&&` continue. A lint/typecheck/test
gate that never reads prose still shows all-clear on a comment stating the exact
opposite of the code. This shape is more dangerous than an ordinary red failure,
because a false green doesn't just fail to catch the defect — it actively
terminates the investigation and redirects effort elsewhere. The sharpest
instance of this in the assembled excerpts is the `python3` anecdote below: a
mutation-testing step's defect injection silently no-op'd, the suite it was
meant to red-flag came back green, and that green was read as "my test is
vacuous" — nearly triggering a rewrite of a test that was correct all
along.[^global-claude-md][^capture]

Six instances of this shape, drawn from this repo and its operating
environment, follow.

## The six instances

### 1. An unprivileged Windows symlink test skips instead of failing

**Appears to do:** exercise symlink-to-directory handling in a filesystem test
(e.g. a `walkFiles` fixture).

**Actually does:** `fs.symlinkSync(target, link, "dir")` needs elevation or
Developer Mode on Windows. Without it, a test built on that call hits `EPERM`
and — where the test is guarded to tolerate that — **silently skips** rather
than failing. The suite stays green while the symlink path never ran.[^claude-md][^review-ctx]

**Countermeasure:** build the fixture with
`process.platform === "win32" ? "junction" : "dir"`. Junctions need no
elevation, work unprivileged everywhere, and produce an identical dirent shape
(`isDirectory()` is `false`, `isSymbolicLink()` is `true`); Node ignores the
type argument on POSIX, so the ternary is portable.[^claude-md]

**Concrete tell:** watch the `pending` count, not just the pass count. The
expected Windows baseline is exactly **one** pending test —
`test/resolveWithin.test.ts:49`, a POSIX-only case that legitimately skips on
`win32` (its `win32` counterpart at `:65` runs instead). The `walkFiles`
`EPERM` guards at `test/walkFiles.test.ts:26` and `:95` do **not** skip on an
unprivileged Windows machine, since junctions need no elevation — they must
report `✔`. A second `pending` entry means a filesystem test silently stopped
running; go find it rather than accepting the green.[^review-ctx]

### 2. `python3` on this machine no-ops instead of erroring

**Appears to do:** run a scripted edit or injection via a `python3` heredoc.

**Actually does:** `python`/`python3` are not installed on this machine; the
names resolve to a Windows App Execution Alias stub that prints
`Python was not found; run without arguments to install from the Microsoft
Store...` **to stdout** and does not reliably set a non-zero exit status. A
`python3 - <<'PY' ... PY` heredoc therefore **silently does nothing**, the
surrounding `&&` chain keeps going, and whatever runs next reports on
unmodified state as though the script had succeeded.[^global-claude-md]

**Countermeasure:** use the Edit/Write tools for file edits, or `node` for
scripted logic (it is installed). If a script must be shelled out, verify the
edit landed — `grep` the changed text, or `git diff` — before acting on any
result that depends on it; the exit status will not tell you.[^global-claude-md]

**Concrete tell:** observed 2026-08-14 in construct3-chef — a mutation-test
step used a `python3` heredoc to inject a deliberate defect, the injection
never happened, and the test suite came back green. That green initially read
as "my test is vacuous" and nearly triggered a rewrite of a perfectly good
test, before the actual cause (the no-op heredoc) was found.[^global-claude-md][^capture]

### 3. No gate in this repo reads prose

**Appears to do:** lint, `tsc`, and the full test suite validate the change,
including its documentation.

**Actually does:** none of them read prose. Lint, `tsc`, and the full suite
are all green on a docstring, ADR body, README claim, or commit message that
states the exact opposite of what the code does — prose is the one artifact
class where "the checks passed" carries no signal at all.[^review-ctx]

**Concrete instances**, all from the `#12` branch, all committed-clean by
every automated gate before being caught by hand:[^review-ctx]

- An ADR asserted a `statFingerprint` symbol "exists internally but is not
  exported." It was never written.
- `OptimisticWatcher`'s JSDoc listed "a fingerprinter that can't observe a
  real difference" among its *fail-open* guarantees — the exact opposite: a
  fingerprint collision suppresses a real change, which is staleness, the one
  failure the design exists to prevent. The comment cited the failure mode as
  proof of safety.
- The ADR said "L1 and L2 are untouched" one commit before both gained a
  `record()` call — and those calls are load-bearing, not incidental.

Inverted rationale comments are the sharpest case of this pattern: a rationale
comment exists specifically to steer a future reader away from a change, so an
inverted one argues *for* the exact change it was written to prevent.[^review-ctx]

**Countermeasure:** where a change is justified by measurements — a probe
table, a benchmark, a platform matrix — diff every rendered claim against the
source data before committing, rather than trusting that it once matched.[^review-ctx]

### 4. Actions `uses:` disagrees with the tool used to verify it

**Appears to do:** confirm a reusable-workflow `uses:` reference still points
at a valid repo, using `gh api`/`gh repo view` to check.

**Actually does:** GitHub's API (`gh api`, `gh repo view`) silently follows
repo-rename redirects. GitHub Actions' `uses:` resolution does **not**. A
stale `uses:` reference therefore passes every API-based check yet fails the
actual workflow run instantly, with a 0-second "workflow file issue."[^claude-md][^review-ctx]

This is the most instructive instance of the six, because the verification
tool and the consuming tool actively **disagree** — checking harder with the
wrong tool (`gh api`) increases confidence while the defect stays exactly
where it was.

**Concrete instance:** this bit the project migrating to the `@genvidtech`
scope — issue `#9` left `ci.yml`/`publish.yml` pointing at the old,
redirect-only `genvid-public-ci` path.[^claude-md]

**Countermeasure:** confirm the canonical path with
`gh api repos/<owner>/<repo> --jq .full_name` and update the workflow files
directly, rather than trusting that a redirect means the reference still
works.[^claude-md][^review-ctx]

### 5. `throwIfNoEntry: false` is read as a stronger guarantee than it gives

**Appears to do:** make `fs.statSync` total — i.e., never throw, only return
`undefined` on a missing entry.

**Actually does:** `throwIfNoEntry: false` suppresses only `ENOENT`. It does
not make `statSync` total. A symlink cycle throws `ELOOP` straight through it
regardless — verified by probe on Node 24.11.1 / win32.[^adr-0001]

**Concrete instance:** issue `#10` proposed a resolved-`stat` mechanism for
`walkFiles` on the assumption that `throwIfNoEntry: false` was sufficient to
avoid throwing; ADR-0001 records the correction and rejects re-throwing
non-`ENOENT` failures as a fix, since that would convert a walk that merely
returned a bad path into a walk that throws — a new failure mode callers never
opted into.[^adr-0001]

This is the same shape as the other five, one level up: a *documented option*
(`throwIfNoEntry: false`) was read as covering more failure modes than its own
documentation promises.

### 6. A subagent's self-report is unverified prose about its own work

**Appears to do:** report the outcome of delegated work — a subagent finishes
a task and returns a summary whose opening sentence claims the result was
checked.

**Actually does:** the report is prose, and per instance 3 no gate reads
prose — nothing checks a self-report against the artifact it describes. In
this page's own authoring, the `tech-writer` dispatch that produced the first
version of this page returned a summary opening "All three files are in place
and verified against the wiki schema," then reported "8 in-body `[^id]`
markers" (actual: **22**, off by 14) and "190 lines" (actual: **191**, off by
1).[^selfreport]

The discriminating detail is what makes this instance worth recording on its
own: every *countable* claim in that report was wrong, while every
*structural* claim — "across the 5 `sources[].id` values," "all resolved by
matching definitions," "no orphaned or undefined footnotes" — was
correct.[^selfreport] The report was not generally unreliable. It was
unreliable in exactly the dimension that is cheapest to check and easiest to
wave through.

**Countermeasure:** treat any number in a self-report as a claim, not a
measurement. Re-derive it from the artifact before relaying it onward — don't
repeat a subagent's count as though reporting it were the same as checking
it.[^selfreport]

**Concrete tell:** even the correction can fail the same way. The
orchestrator's own first re-count used `grep -c '\[\^'
wiki/failure-modes-that-report-success.md`, which counts matching *lines*,
not matches — it over-counted by including the 5 definition lines and
under-counted lines carrying two markers. The two errors happened to cancel
exactly, yielding the right answer (22) from a measurement of the wrong
quantity. A correct number obtained by a method that doesn't measure the
stated quantity is a coincidence, not a verification, and it won't recur on
the next file; the honest re-measure is `grep -o '\[\^[a-z0-9-]*\]' | wc -l`
minus the definition-line count.[^selfreport]

## The transferable rule

All six instances converge on the same rule: **name the evidence, or report
the gap.** A skipped test is not a passing test.[^review-ctx] A green check is
only evidence if you can state, concretely, what it actually executed —
which symlink type it created, which prose line it diffed against which data,
which tool resolved which redirect, which error code a suppressor actually
suppresses.

Before trusting any check on this stack, ask: what would this check look like
if it silently didn't run? If the answer is "indistinguishable from success,"
that check is not evidence — it's a green pixel with a story attached, and the
six instances above are what happens when the story goes unquestioned. The
same question applies to delegated work: what would this report look like if
the work it describes silently wasn't done, or wasn't checked as claimed? A
self-report is a check like any other, and it fails the same way — unless
something re-derives its numbers from the artifact.

[^capture]: Assembled verbatim excerpts on checks that report success while
    not checking, captured 2026-08-16.
[^claude-md]: Project `CLAUDE.md` at commit `74c0c0f`.
[^review-ctx]: `docs/code-review-context.md` at commit `74c0c0f`.
[^adr-0001]: ADR-0001, "Compromise" section, at commit `74c0c0f`.
[^global-claude-md]: Machine-global `CLAUDE.md` (local path outside this
    repo; not pinned by the repo SHA above).
[^selfreport]: Subagent self-report vs. measured artifact, captured
    2026-08-16 (session-local transcript; no public upstream, cannot be
    re-fetched).
