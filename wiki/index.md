---
okf_version: "0.2"
---

<!-- `okf_version` is the ONLY frontmatter key permitted here (§8/§12) — this
     file is the bundle-root index (`wiki/index.md`, the OKF bundle root per
     ADR-0022). A `wiki/<subdir>/index.md` carries NO frontmatter at all. -->

# Wiki Index

This is the wiki's table of contents and **this repo's only documentation
index** — every page under `wiki/`, grouped under section headings, one line
each. `/gvt-dev:maintain-wiki` keeps this list current: a new page is added
here when it's created, and `lint` flags any page listed in **no** index —
here, or in a subdirectory's own `index.md`. Each entry's description is the
linked page's frontmatter `description`, so the index and the page can't
drift. See [`wiki-schema.md`](wiki-schema.md) for the page format and
maintenance rules.

This package's primary user-facing docs live at the repo root and are not
wiki pages:

- `../README.md` — user-facing API documentation for every exported utility.
  It ships in the npm tarball; the wiki does not.
- `../CLAUDE.md` — project conventions, commands, and the per-utility overview
  (the de-facto architecture/design reference for this package).

## Practices

Cross-cutting notes that generalize past this package.

* [Failure modes that report success](failure-modes-that-report-success.md) - Seven ways a check on this stack passes without having checked — and the evidence rule that catches them.

## Process

How work gets done here — see [`process/index.md`](process/index.md).

* [Code Review Context](process/code-review-context.md) - Project-specific context for reviewers (and `gvt-dev:code-reviewer`) — the invariants to review against, the deliberate choices that only look like defects, and the release-affecting checks.

## Knowledge Base

* [Wiki Maintenance Schema](wiki-schema.md) - Maintenance schema for the three-tier LLM-wiki (`raw/` captures → `wiki/` pages → these rules) — page format, create-vs-update lifecycle, `raw/` immutability, and the decay policy.

## Decision Records

Architecture decisions — see [`decisions/index.md`](decisions/index.md).

* [0001. walkFiles returns only regular files](decisions/0001-walkfiles-returns-only-regular-files.md) - Why `walkFiles` guarantees every returned path is a regular file, and why a failed `stat` drops the entry instead of propagating.
* [0002. ObservedState collapses duplicate watch events](decisions/0002-observed-state-collapses-duplicate-watch-events.md) - Why `OptimisticWatcher` gains a third, content-fingerprint suppression layer to collapse the duplicate `fs.watch` events measured per single write.
* [0003. exposeDocs addresses nested docs by path, guarded by resolveWithin](decisions/0003-exposedocs-path-shaped-resource-names.md) - Why `exposeDocs` addresses nested documents by path through a single `docs:///{+path}` template, and why that makes the `resolveWithin` read guard required rather than optional.
* [0004. The wiki is this repo's only documentation tier](decisions/0004-wiki-is-the-only-documentation-tier.md) - Why `docs/` was retired into `wiki/`, what replaced the wiki's scope bar, and the two hardcoded plugin literals that relocation knowingly breaks.
* [0005. The tx-token wire format is a shared codec, not a per-consumer implementation](decisions/0005-tx-token-wire-format.md) - Why `formatTxToken`/`parseTxToken`/`compareTxToken`/`isValidProjectId` ship as one `${projectId}:${n}` codec in this package, and why lenient `n`-parsing and a branded token type were both rejected.
* [0006. resolveRootFolders ships as an additive plural, not a field on the ambiguous error](decisions/0006-resolve-root-folders-plural.md) - Why ambiguous discovery becomes a success on a new `resolveRootFolders({ paths, source })` rather than a `matches` field on `resolveRootFolder`'s error result, and why both rejected error-payload options were probed end-to-end before being rejected on design merit.

<!--
No architecture.md, design-patterns.md, or runbook.md: this package has no
runtime/framework to document beyond README.md + CLAUDE.md. Add them here if
that changes.

(Carried over from the retired docs/TOC.md — it records a deliberate absence,
which is exactly the kind of thing that gets re-proposed annually once nothing
states it.)
-->
