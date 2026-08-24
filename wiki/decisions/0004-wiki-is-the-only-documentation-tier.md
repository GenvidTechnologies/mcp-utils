---
type: decision-context
title: 0004. The wiki is this repo's only documentation tier
description: Why `docs/` was retired into `wiki/`, what replaced the wiki's scope bar, and the two hardcoded plugin literals that relocation knowingly breaks.
tags: [documentation, wiki, okf, tooling, decision]
status: stable
generated: { by: human:ninoles, at: 2026-08-24T00:00:00Z }
sources:
  - id: issue-17
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/17
    title: "#17 — retire docs/ and make the wiki this repo's only documentation tier"
    last_modified: 2026-08-24
  - id: gvt-390
    resource: https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/390
    title: "gvt-dev#390 — propagate the schema-doc resolution to every hardcoded docs/wiki-schema.md site"
    last_modified: 2026-08-24
---

<!-- `stale_after` deliberately omitted — see the note in 0001. -->

# 0004. The wiki is this repo's only documentation tier

- **Status:** accepted
- **Date:** 2026-08-24
- **Issue:** [#17](https://github.com/GenvidTechnologies/mcp-utils/issues/17)

## Context

This repo ran two documentation tiers: `docs/` (six files — `TOC.md`,
`code-review-context.md`, `wiki-schema.md`, and three ADRs) and the three-tier
LLM-wiki (`raw/` → `wiki/` → the schema), stood up 2026-08-16. Two tiers meant
two indexes over one corpus, which is the drift trap in its purest form.

The packaging risk that made the equivalent `construct3-chef` consolidation
painful is absent here. That one caused an outage: it dropped `docs` from
`package.json` `files` while its MCP server's `exposeDocs` call still resolved
`<packageDir>/docs`, so the resource served zero documents. Neither half
applies — `files` here is `["dist","LICENSE","README.md"]`, so `docs/` never
shipped in the tarball, and this package is a library that never calls
`exposeDocs` on itself.

What remained was repo organisation plus a reference sweep — and one genuine
decision, below, which is why this record exists.

## Decision

`docs/` is retired. `wiki/` is the only documentation tier: `wiki/decisions/`
holds the ADRs, `wiki/process/` the working conventions, `wiki/wiki-schema.md`
the maintenance rules, and `wiki/index.md` is both the OKF bundle root and this
repo's documentation index. `docs/TOC.md` folded into `wiki/index.md` rather
than moving, since both already indexed the same corpus.

**The rule governing what earns a page is now "exactly one page owns a given
fact."** This replaces the previous bar, which asked whether knowledge
*generalized past this package* and explicitly excluded "a second copy of
`README.md` or an ADR."

That replacement is the substance of this decision. The old bar cannot survive
the move: ADRs and process docs are package-specific by nature, so the rule as
written would reject the very pages now living here. But it was doing real
work — it is why `wiki/` held one page instead of accumulating restatements of
`README.md` — so it needed a stated successor rather than silent removal. The
ownership framing preserves the property the scope framing was protecting: the
liability is two pages asserting the same fact, not which tier a page sits in.

## Compromise

**Relocating `wiki-schema.md` knowingly breaks two plugin behaviours, and no
configuration can prevent it.** Both read the path as a hardcoded literal
rather than a declared expectation, so `.gvt-agent.json` `paths` — which does
redirect the audit's file expectations — cannot reach them:

- `run-retro/SKILL.md` tests for a wiki by the presence of
  `docs/wiki-schema.md`. With the schema elsewhere it concludes **"no wiki"**
  and skips wiki routing, silently and in the inverse direction of the truth.
- `audit-conventions`' `practice-detect.mjs` reads the same literal, which is
  why the audit now reports the Environment pillar as *partial adoption*
  rather than *adopted*. That section is advisory and never affects the exit
  code.

The alternative was leaving `wiki-schema.md` as the sole `docs/` survivor,
which keeps both behaviours intact but defeats the point: `docs/` would not be
retired. We took the relocation and compensated with an explicit paragraph in
`CLAUDE.md` instructing future sessions to route retro insights to the wiki
tier regardless of what `run-retro` concludes.

That compensation is a workaround, not a fix — it depends on a reader actually
consulting `CLAUDE.md`. It is recorded here with its removal condition so it
does not become permanent by default: **delete it when
[gvt-dev#390](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/390)
lands.** #390 is itself blocked by gvt-dev#385, so treat this as standing
rather than briefly temporary.

**The `paths` block is load-bearing, not cosmetic.** `condense-lessons`
declares `docs/TOC.md` **required** — every other component declaring it uses
`required: false` — so deleting that file without the override makes
`audit-conventions` report a required error and exit non-zero. The override
also drives `resolveDocsRoot`, which is what repoints the retired-token,
broken-link and orphan scanners from `docs/` to `wiki/`. Anyone tempted to
prune the block as redundant should read this paragraph first.

## Consequences

- One index, one tier. `wiki/index.md` is the single documentation entry point.
- ADRs gained OKF v0.2 frontmatter, which they previously lacked, so index
  entries source their descriptions from the pages rather than a hand-copied
  line that can drift.
- `wiki/decisions/` and `wiki/process/` each need an `index.md` (carrying **no**
  frontmatter), or `maintain-wiki lint` reports every page in them as orphaned.
- `hygiene.excludePaths` must name `wiki/decisions/`. The shipped deny-list
  excludes `docs/decisions/` on the grounds that an ADR legitimately names
  retired things; move the ADRs and that exclusion silently stops matching. The
  list is unioned with the defaults, so naming only the addition is correct.
- Out-of-bundle links improved rather than regressed: the schema previously
  cited `../docs/wiki-schema.md` and `../docs/decisions/0001-*.md` as its
  examples of links escaping the OKF bundle. Both are now inside it.
- `README.md` still ships in the tarball and still carries the four ADR links,
  now pointing at `wiki/decisions/`. Those resolve against GitHub from the
  published package page, so they have external blast radius.

## Alternatives considered

**Leave `docs/` in place.** Rejected: two indexes over one corpus is the drift
liability the wiki exists to avoid, and nothing in `docs/` was load-bearing for
packaging.

**Move everything but keep a pointer stub at `docs/wiki-schema.md`.** Both
plugin checks test only for file existence, so a one-line stub would satisfy
them with no compensating prose. Rejected as a deliberate stub in a directory
we had just declared retired — it trades an honest, documented gap for a
quiet, undocumented one. Reconsider if the `CLAUDE.md` note proves ineffective
in practice.

**Blanket-replace `docs/` with `wiki/` across the repo.** Rejected on
measurement: of 81 occurrences, **57 must not change** — 17 fixture paths in
`test/exposeDocs.test.ts` and 2 in `README.md` that document `exposeDocs`'
*default* `docsDir`, 11 in immutable `raw/` captures, 16 in the synced
`CONVENTIONS.md`, 4 in frozen `CHANGELOG.md` history, 4 commit-pinned
provenance citations in `wiki/failure-modes-that-report-success.md`, and 3 in
ADR-0003 discussing another repo's flat `docs/` alias. Safe and unsafe
occurrences are lexically identical, so the sweep was done per-site.

## A note on what the issue got wrong

#17 was a detailed proposal and still carried two defects worth recording,
because both are the kind that read as rigour.

Its sweep census (67 occurrences, ~40 must-not-touch) did not reproduce: the
actual figures are **81** and **57**. More importantly it classified three
categories as migratable that must not be touched — the two `README.md`
`docsDir` references, the four commit-pinned provenance citations, and
ADR-0003's three. Rewriting the provenance citations would have produced dead
URLs *and* falsified a record whose whole purpose is re-verifiability.

Its census was also structurally blind to a category no `docs/` search can
find: moving `code-review-context.md` down one directory level broke five of
its **relative** links (`../CLAUDE.md`, `../README.md`, `decisions/`,
`TOC.md`), none of which contain the substring `docs/`. The audit's
broken-link scanner caught them; the inventory could not have.

The general lesson is the one
[`failure-modes-that-report-success.md`](../failure-modes-that-report-success.md)
already documents: a precise-looking count is not evidence the right thing was
counted, and `grep -c` counts *lines*, not occurrences.

## Related

- [0003. exposeDocs addresses nested docs by path](0003-exposedocs-path-shaped-resource-names.md) — why `docs:///` names are path-shaped; its `docsDir` default is why several `docs/` references here must not change.
- [Failure modes that report success](../failure-modes-that-report-success.md) — the evidence rule this record's census corrections apply.
