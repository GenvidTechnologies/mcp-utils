---
type: practice-note
title: Failure modes that report success
description: Ten ways a check on this stack passes without having checked — and the evidence rule that catches them.
tags: [verification, testing, windows, ci, tooling]
status: stable
stale_after: 2027-02-24
generated: { by: process:maintain-wiki, at: 2026-09-01T00:00:00Z }
sources:
  - id: review-verdict
    resource: ../raw/2026-09-01-review-verdict-without-evidence.md
    title: A review verdict reported without the evidence it cites, captured 2026-09-01 (session-local transcript of the #20 run; every quoted command is re-runnable against the three commits named in the capture)
    last_modified: 2026-09-01
  - id: source-absent
    resource: ../raw/2026-08-28-source-absent-claim.md
    title: A claim whose subject is absent from the source, captured 2026-08-28 (session-local transcript of the #19 run; the semver probe is re-runnable and the quoted commit is pinned by SHA)
    last_modified: 2026-08-28
  - id: move-sweep
    resource: ../raw/2026-08-24-move-blind-sweep-inventory.md
    title: Reference-sweep inventory blind to references from a moved file, captured 2026-08-24 (session-local transcript of the #17 run; commands re-runnable against the named commits)
    last_modified: 2026-08-24
  - id: probe-scope
    resource: ../raw/2026-08-24-isolated-probe-scope-error.md
    title: Isolated-probe scope error, captured 2026-08-24 (session-local transcript plus re-fetchable SDK excerpts at @modelcontextprotocol/sdk@1.29.0)
    last_modified: 2026-08-24
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

Ten instances of this shape, drawn from this repo and its operating
environment, follow. The last four differ from the rest in an important way,
and are placed last for that reason: the first six are checks that did not
run; the seventh and eighth ran correctly and measured the wrong thing — the
seventh at the wrong entry point, the eighth over the wrong corpus; the
ninth ran correctly over the *right* corpus and still could not reach the
claim, because the claim's subject was not in that corpus at all; and the
tenth returns to the first six's failure — a check that did not run — but
arrives there from the opposite direction, because an agent whose whole job
was to verify someone else's work *reported* it as having run. The first six
are silent; the tenth is asserted.

## The ten instances

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

**This reaches your own prose, not just a delegate's.** Instance 6 below covers
a *subagent's* self-report, which is easy to treat as suspect precisely because
someone else wrote it. Prose you authored yourself in the same session reads as
already-verified and is not. On the `#17` branch an ADR bullet asserted
"out-of-bundle links improved rather than regressed"; the measured count moved
**0 → 2**, the opposite direction. Its supporting sentence was independently
true — the schema's examples *had* moved inside the bundle — but those were
code-spans, never live links, so a true statement was serving as evidence for a
false one. Four adjacent claims in the same record were correct, and that is
part of the mechanism: a correction pass that fixes several real defects
manufactures confidence in the one claim it never re-measured. Caught only by
re-running the count; lint, typecheck, 206 passing tests and build were green
across every commit in between.[^move-sweep]

### 4. Actions `uses:` disagrees with the tool used to verify it

**Appears to do:** confirm a reusable-workflow `uses:` reference still points
at a valid repo, using `gh api`/`gh repo view` to check.

**Actually does:** GitHub's API (`gh api`, `gh repo view`) silently follows
repo-rename redirects. GitHub Actions' `uses:` resolution does **not**. A
stale `uses:` reference therefore passes every API-based check yet fails the
actual workflow run instantly, with a 0-second "workflow file issue."[^claude-md][^review-ctx]

This is the most instructive instance of the first six, because the
verification tool and the consuming tool actively **disagree** — checking
harder with the wrong tool (`gh api`) increases confidence while the defect
stays exactly where it was. Instance 7 below is the same shape reached from a
different direction: there the disagreement is between the entry point probed
and the one the system calls.

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

### 7. A probe runs correctly against an entry point the system never uses

**Appears to do:** settle a factual question about a dependency by running it,
rather than trusting a docstring — the countermeasure instance 3 prescribes.

**Actually does:** answers a question the integrated system never poses. On the
`#15` branch, the decision to widen `exposeDocs`' resource template to
`docs:///{+path}` was accompanied by a probe of the MCP SDK's `UriTemplate`,
showing the widened template matches a traversal where the old one returned
`null`:[^probe-scope]

```
docs:///{name}     docs:///../../../etc/passwd  -> null
docs:///{+path}    docs:///../../../etc/passwd  -> {"path":"../../../etc/passwd"}
```

Both lines are accurate and reproducible. An ADR was written concluding that
the change opened a path-traversal hole, and a containment guard was justified
by it. But the SDK's read handler does not hand the template the requested URI
— it builds `new URL(request.params.uri)` and matches against `uri.toString()`
(`dist/esm/server/mcp.js:376-390`), and RFC 3986 normalisation collapses `..`
segments during URL construction. Measured end to end through a real in-memory
client, with a sentinel file placed outside the documentation
directory:[^probe-scope]

| Requested | Reaches the template as | Outcome |
|---|---|---|
| `docs:///../secret` | `docs:///secret` | not found, inside the docs dir |
| `docs:///../../../etc/passwd` | `docs:///etc/passwd` | not found, inside the docs dir |

The guard never fires. The sentinel is never returned. No caller can deliver
the string the probe was given.

**Why this one is different, and worth its own entry.** The other six are
checks that *did not run* — a skipped test, a no-op heredoc, a gate that reads
no prose. This one ran, and reported truthfully. The defect was in **which
entry point it was pointed at**, which no amount of scrutinising its output
would reveal. It also defeats instance 3's countermeasure exactly: *"diff every
rendered claim against the source data"* passes cleanly here, because every
claim in the ADR did trace faithfully back to the probe table. The rule
verifies transcription, and the error was upstream of transcription.[^probe-scope]

**Countermeasure:** before a measurement justifies a design, establish what the
**caller** hands the component. An input transformed on the way in — normalised,
decoded, defaulted, coerced — means an isolated probe is measuring a case that
cannot occur. Where the isolated and integrated answers can differ, take the
integrated one: drive the real path (here, a client over `InMemoryTransport`)
and let it arbitrate.

**Concrete tell:** the isolated result is the more *precise-looking* of the two
— an exact template, an exact matched value — and precision reads as rigour.
Ask what the value looks like at the boundary you actually care about, not at
the boundary that was convenient to call. A useful phrasing: *if this component
is only ever reached through one caller, then a probe that bypasses that caller
is measuring a hypothetical.*

### 8. A reference inventory enumerates the wrong direction

**Appears to do:** scope a repo-wide rename exhaustively, by counting every
occurrence of the moving path and classifying each one.

**Actually does:** enumerates references *to* the moved thing, and is
structurally incapable of returning references *from* it. On the `#17` branch,
retiring `docs/` into `wiki/`, the issue's census counted `docs/` occurrences
and split them migratable vs must-not-touch. After `git mv` of one file — a
clean `R100`, zero content change — the audit reported five broken links the
census had never listed:[^move-sweep]

```
wiki/process/code-review-context.md:24  broken link -> ../CLAUDE.md
wiki/process/code-review-context.md:26  broken link -> ../README.md
wiki/process/code-review-context.md:27  broken link -> decisions/
wiki/process/code-review-context.md:193 broken link -> decisions/0001-...md
wiki/process/code-review-context.md:197 broken link -> TOC.md
```

**Not one of those strings contains `docs/`.** They broke because the file
descended a directory level, not because they named the retired directory. No
amount of care running the census would surface them — the defect is in what
the enumeration is *of*.

The census was otherwise sound: all 24 sites it named were real and its 57
must-not-touch classifications held. Its accuracy on the enumerated category is
exactly what made the missing category invisible — a partial inventory that is
correct as far as it goes reads as a complete one.

**Why this is not instance 7.** That one ran against the wrong *entry point*;
this one runs against the wrong *corpus*. Both survive instance 3's
countermeasure — every claim traced faithfully to the census, because the
census was internally consistent. And both survive the transferable rule's
first question: this check emphatically did run.

**Countermeasure:** a move has two blast radii, and a path search finds only
one. Before trusting a rename inventory, ask what the moved file *points at*,
not only what points at it — then let a resolver that doesn't care about
strings arbitrate. Here `scanBrokenLinks` resolves against the filesystem, so
it found all five regardless of their spelling. Prefer a tool that checks the
property you care about (does this link resolve?) over one that checks a proxy
for it (does this line contain the old path?).

**Concrete tell:** the same census also mis-stated its own totals — 67 against
a measured 81, ~40 must-not-touch against 57, because `grep -c` counts *lines*
and multi-hit lines undercount. A count that is wrong in the direction of
*fewer* is the cheap smell for an enumeration that is scoped too narrowly, and
it is visible before any of the work begins.[^move-sweep]

### 9. A claim whose subject is absent from the source

**Appears to do:** exactly what instance 3 prescribes — diff every prose claim
against the source data before committing — carried out diligently, by an agent
that enumerates each claim it checked and against which file.

**Actually does:** reaches only those claims whose subject is *in* the source. A
claim about an **external system** — npm range resolution, a platform's
filesystem semantics, a protocol's normalisation rules — has nothing in `src/`
to diff against. So a conscientious "verified against source" pass sails
straight past it while accurately reporting full coverage of everything it
could see. Instance 3's countermeasure is not weakened here; it simply has no
purchase, and its thoroughness is what makes the gap hard to notice.[^source-absent]

**The instance.** Writing the `CHANGELOG.md` entry for the `#19` codec, a
`tech-writer` subagent verified every checkable claim against `src/txToken.ts`
and `test/txToken.test.ts`, listed them, and wrote:[^source-absent]

> Both named consumers currently pin `^0.8.0`, so this lands within their
> existing range

`^0.8.0` resolves as `>=0.8.0 <0.9.0` — below a major of 1, npm's caret permits
patch updates only — so the `0.9.0` release falls **outside** every range the
entry named. The claim was the exact inverse of the truth, and lint, `tsc`, 250
passing tests and a clean build were all green over it.[^source-absent]

**The discriminating detail**, which is what earns this a place beside instance
3 rather than inside it: the subagent **did** flag the inherited premise. Its
report volunteered that "both waiting consumers currently pin `^0.8.0`" was
"carried forward from the brief, not independently confirmed," having no way to
inspect those repos from this checkout. The labelling worked. What it then wrote
was not the premise but a **consequence drawn from it** — *so this lands within
their existing range* — and that consequence is false whatever consumers pin.
The label routed attention to the premise and away from the inference built on
it.[^source-absent]

**Countermeasure**, in two parts. A labelled-unverified claim is not a
discharged one: the label names an obligation and does not satisfy it, and the
obligation falls on whoever accepts the work, not on the agent that raised the
flag. And check an **inference** separately from the premise it rests on — an
inference can be false while its premise is true, so confirming the premise
discharges nothing about what was concluded from it.

**Concrete tell:** the correct rule was already settled in this repo one release
earlier, by the same reasoning, in the body of commit `7423e48` — *"Consumers
currently pin ^0.7.0, which excludes 0.8.0, so adoption downstream is deliberate
work rather than a transparent pickup."* It lived **only** there. No reader of
`CLAUDE.md`, `README.md`, or this wiki would meet it.[^source-absent] A fact
whose sole home is a commit message is not documented, it is buried: `git log`
is not a surface anyone consults before writing a release note, so the fact gets
re-derived on every release — and re-derivation is where it goes wrong. If a
rule was worth writing in a commit body, it belongs somewhere a future author
will actually pass through.

### 10. A review reports a verdict it did not gather the evidence for

**Appears to do:** independently grade someone else's work — the countermeasure
instance 6 prescribes, since a self-report is unverified prose about its own
output and a distinct reviewer is what breaks that circle.

**Actually does:** produces a report which is *itself* unverified prose about
its own work, and nothing downstream reads prose (instance 3). The reviewer is
the last agent in the chain, so the check that exists to catch instance 6
reproduces it one level up, where there is no further reviewer to
catch it.[^review-verdict]

**The instance.** Reviewing the `#20` branch against nine pre-committed
acceptance criteria, a `gvt-dev:code-reviewer` returned **9 of 9 satisfied**,
"None. No defects found," and no warnings or suggestions. Two of its nine
evidence claims were false:[^review-verdict]

> Test file diff shows single hunk `@@ -704,3 +705,158 @@`

There were **two** hunks — `git diff main...HEAD -- test/resolveRootFolder.test.ts | grep "^@@"`
returns an import hunk at `@@ -2,6 +2,7 @@` as well.[^review-verdict]

> `npm run typecheck`: ✅ PASS (embedded in build)

It is not embedded in `build`. `build` is `tsc` over `tsconfig.json` (emits
`src` → `dist`, excludes `test/`); `typecheck` is `tsc -p tsconfig.test.json
--noEmit`, which adds `test/`. They compile different file sets, so a green
`build` carries no information about whether `test/`
typechecks.[^review-verdict]

Both **conclusions** were nonetheless correct — no pre-existing test was edited
(`grep "^-"` on that diff returns nothing), and `typecheck` did pass when run
separately. That is what makes this shape expensive: a wrong conclusion gets
argued with, while a right conclusion resting on evidence nobody gathered is
indistinguishable from a real check.

**The discriminating detail**, which is what separates this from instance 6:
both false claims are about **whether a command was run**, not about the
contents of a file. Everything this reviewer asserted from *reading* was
accurate — README line numbers and their opening sentences, the ADR's probe
section, the CHANGELOG's caret direction, an empty `git diff` on
`package.json`. Its file reading was reliable throughout. The failures land
exactly where establishing the claim required *executing* something and an
inference was substituted. One of the two was numeric ("single hunk") and one
structural ("embedded in build"), so instance 6's countable-versus-structural
split does not predict them — **inferred versus executed**
does.[^review-verdict]

**Countermeasure:** require a review to name the command it ran for any claim
about a command's result, and treat a gate reported as passing without its
invocation quoted as *not reported*. On the accepting side, re-run the cheapest
one or two yourself; the ones worth picking are those whose stated evidence is
a mechanism rather than a quotation, since a misquoted file is caught by
reading and a never-run command is not.

**Concrete tell:** the verdict **agreed with the orchestrator's own stated
hypothesis**. That dispatch had explicitly labelled its expectation and
pre-authorised contradiction — the discipline that worked earlier in the same
run, where an implementer checked a brief's claim about `README.md` section
ordering and found it wrong. But a labelled hypothesis only generates signal
when the result *disagrees* with it. Agreement produces nothing to notice, so
the label's protection is asymmetric, and a green review matching what the
orchestrator predicted is the least-examined artifact in the
run.[^review-verdict]

## The transferable rule

All ten instances converge on the same rule: **name the evidence, or report
the gap.** A skipped test is not a passing test.[^review-ctx] A green check is
only evidence if you can state, concretely, what it actually executed —
which symlink type it created, which prose line it diffed against which data,
which tool resolved which redirect, which error code a suppressor actually
suppresses.

Before trusting any check on this stack, ask: what would this check look like
if it silently didn't run? If the answer is "indistinguishable from success,"
that check is not evidence — it's a green pixel with a story attached, and the
instances above are what happens when the story goes unquestioned. The
same question applies to delegated work: what would this report look like if
the work it describes silently wasn't done, or wasn't checked as claimed? A
self-report is a check like any other, and it fails the same way — unless
something re-derives its numbers from the artifact.

That question is necessary and, on its own, not sufficient — instance 7 passes
it. A probe pointed at the wrong entry point looks nothing like a check that
didn't run: it ran, it reported accurately, and its output is reproducible on
demand. So ask a second question of any measurement that justifies a decision:
**what does this measure that the running system doesn't do?** Name the caller,
and name what the caller does to the input before the measured component sees
it. Where you cannot name the caller, you have measured a component, not a
behaviour — and the design resting on it is resting on a hypothetical.

Two questions are still not enough, because instance 9 passes both. That check
ran, reported accurately, and measured precisely what the running system does —
it simply had nothing to say about a claim whose subject lives outside the
repo. So ask a third question of any body of prose about to be committed:
**which of these claims could this check not have reached?** Sort them by
subject, not by confidence: a claim about the code is answerable from the code,
and a claim about npm, the filesystem, a protocol, or another repository is not,
no matter how firmly the surrounding paragraph is grounded. Then note that
marking such a claim unverified is where the work starts rather than where it
ends — the flag is a handoff, and an unclaimed handoff is indistinguishable from
a check that passed.

[^capture]: Assembled verbatim excerpts on checks that report success while
    not checking, captured 2026-08-16.
[^move-sweep]: Reference-sweep inventory blind to references *from* a moved
    file, captured 2026-08-24 — session-local transcript of the `#17` run,
    with commands re-runnable against the commits it names.
[^probe-scope]: Isolated-probe scope error, captured 2026-08-24 —
    session-local transcript of the `#15` run, plus SDK excerpts re-fetchable
    at `@modelcontextprotocol/sdk@1.29.0`.
[^claude-md]: Project `CLAUDE.md` at commit `74c0c0f`.
[^review-ctx]: `docs/code-review-context.md` at commit `74c0c0f`.
[^adr-0001]: ADR-0001, "Compromise" section, at commit `74c0c0f`.
[^global-claude-md]: Machine-global `CLAUDE.md` (local path outside this
    repo; not pinned by the repo SHA above).
[^selfreport]: Subagent self-report vs. measured artifact, captured
    2026-08-16 (session-local transcript; no public upstream, cannot be
    re-fetched).
[^review-verdict]: A review verdict reported without the evidence it cites,
    captured 2026-09-01 — `raw/2026-09-01-review-verdict-without-evidence.md`.
[^source-absent]: A claim whose subject is absent from the source, captured
    2026-08-28 — session-local transcript of the `#19` run. The `semver` probe
    is re-runnable against this repo's resolved `semver`, and the commit it
    quotes (`7423e48`) is pinned by SHA.
