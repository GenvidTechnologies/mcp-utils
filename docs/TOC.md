# Documentation Index

<!--
Genvid plugin skills consult this index to find your project's docs.
Each entry should be a one-line description.
-->

This is a small, flat utility library — its primary docs live at the repo root:

- `../README.md` — user-facing API documentation for every exported utility.
- `../CLAUDE.md` — project conventions, commands, and the per-utility overview
  (the de-facto architecture/design reference for this package).

## Process

- [`code-review-context.md`](code-review-context.md) — project-specific context
  for reviewers (and `gvt-dev:code-reviewer`): the invariants to review against,
  the deliberate choices that only look like defects, and the release-affecting
  checks.

## Decision Records

- [`decisions/0001-walkfiles-returns-only-regular-files.md`](decisions/0001-walkfiles-returns-only-regular-files.md)
  — why `walkFiles` guarantees every returned path is a regular file, and why a
  failed `stat` drops the entry instead of propagating.
- [`decisions/0002-observed-state-collapses-duplicate-watch-events.md`](decisions/0002-observed-state-collapses-duplicate-watch-events.md)
  — why `OptimisticWatcher` gains a third, content-fingerprint suppression layer to
  collapse the duplicate `fs.watch` events measured per single write.

<!--
No docs/architecture.md, design-patterns.md, or runbook.md: this package has no
runtime/framework to document beyond README.md + CLAUDE.md. Add them here if that
changes.
-->
