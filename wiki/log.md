# Wiki Log

Record of every `ingest` run: what changed, why, and which `raw/` source
drove it, grouped under `## YYYY-MM-DD` date headings (ISO 8601) with the
**newest date group first**. Entries are prose bullets, e.g. `* **Update**:
…`, `* **Creation**: …`, `* **Deprecation**: …` — the leading bold word is a
convention, not a requirement.

**Add newest first, never edit or remove a prior entry.** "Newest first"
means a new entry (and, if today isn't already the top group, a new
`## YYYY-MM-DD` heading) is *prepended* above everything else — the
insertion point moves from the bottom to the top, but prepending never
touches a prior entry's text, so the append-only guarantee holds exactly as
before. If a past entry itself needs correcting, add a new entry that says
so; never edit or remove the old one in place. See `wiki-schema.md` for
the full maintenance schema.

## 2026-09-01

* **Update**: failure-modes-that-report-success.md — added a tenth instance
  (a review reports a verdict it did not gather the evidence for). During #20
  a `gvt-dev:code-reviewer` returned 9 of 9 acceptance criteria satisfied and
  "None. No defects found," with two false evidence claims: the test diff was
  a "single hunk" (there are two — an import hunk at `@@ -2,6 +2,7 @@` as well)
  and `typecheck` was "embedded in build" (it is not — `build` is `tsc` over
  `tsconfig.json`, which excludes `test/`, while `typecheck` is `tsc -p
  tsconfig.test.json --noEmit`). Both conclusions were nonetheless correct,
  which is what makes the shape expensive. Distinct from instance 6 in that
  the failing agent is the *reviewer* — the very countermeasure instance 6
  prescribes — reproducing instance 6 one level up, where no further reviewer
  exists to catch it. The discriminator is sharper than 6's
  countable-versus-structural split: both false claims were about whether a
  **command was run**, while every claim drawn from *reading* a file was
  accurate, so *inferred versus executed* is what predicts them. Tell worth
  its own note: the verdict agreed with the orchestrator's explicitly
  labelled hypothesis, and a labelled hypothesis only generates signal when
  the result disagrees — the protection is asymmetric, so a green review
  matching what was predicted is the least-examined artifact in the run.
  Driven by `raw/2026-09-01-review-verdict-without-evidence.md`.

## 2026-08-28

* **Update**: failure-modes-that-report-success.md — added a ninth instance
  (a claim whose subject is absent from the source, so instance 3's
  "diff the prose against the source data" has nothing to diff against).
  During #19 a `tech-writer` verified every checkable claim against
  `src/txToken.ts`, correctly flagged the one premise it could not confirm
  from this checkout — that both consumers pin `^0.8.0` — and then wrote a
  *consequence* of that premise, "so this lands within their existing
  range", which is false however consumers pin: `^0.8.0` is `>=0.8.0
  <0.9.0`, because below a major of 1 npm's caret permits patch updates
  only. Distinct from instances 7 and 8 in that the check ran over the
  *right* corpus and still could not reach the claim; distinct from 6 in
  that the self-report was honest. The transferable rule gained a third
  question — *which of these claims could this check not have reached?* —
  and the countermeasure that a labelled-unverified claim is a handoff, not
  a discharge. Tell worth its own note: the correct rule was already settled
  one release earlier and recorded **only** in commit `7423e48`'s body,
  where no future release-note author would pass through it. Driven by
  `raw/2026-08-28-source-absent-claim.md`.

## 2026-08-24

* **Update**: failure-modes-that-report-success.md — added an eighth
  instance (a reference inventory that enumerated the wrong direction:
  #17's census counted references *to* `docs/` and was structurally unable
  to return the five relative links that broke *inside* a file when it moved
  a directory level, none of which contain the substring `docs/`). Like the
  seventh it ran and reported truthfully — the seventh against the wrong
  entry point, the eighth over the wrong corpus. Instance 3 also gained a
  paragraph extending its countermeasure from a delegate's prose to one's
  own, after an ADR bullet in the same branch inverted a measurement it
  claimed to summarise (0 → 2 out-of-bundle links, asserted as an
  improvement). Driven by `raw/2026-08-24-move-blind-sweep-inventory.md`.

* **Update**: failure-modes-that-report-success.md — added a seventh
  instance (a probe that ran correctly against an entry point the system
  never uses: the MCP SDK normalises a resource URI through `new URL()`
  before matching it against a resource template, so an isolated
  `UriTemplate.match()` probe measured a case no caller can produce). It is
  the first instance on the page where the check *did* run and reported
  truthfully, which is why the closing rule gained a second question.
  Driven by `raw/2026-08-24-isolated-probe-scope-error.md`.

## 2026-08-16

* **Update**: failure-modes-that-report-success.md — added a sixth instance
  (a subagent self-report whose countable claims were wrong while its
  structural claims were correct), driven by
  `raw/2026-08-16-subagent-self-report-discrepancy.md`.
* **Creation**: failure-modes-that-report-success.md, driven by
  `raw/2026-08-16-verification-traps-excerpts.md`.
