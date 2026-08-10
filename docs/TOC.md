# Documentation Index

<!--
Genvid plugin skills consult this index to find your project's docs.
Each entry should be a one-line description.
-->

This is a small, flat utility library — its primary docs live at the repo root:

- `../README.md` — user-facing API documentation for every exported utility.
- `../CLAUDE.md` — project conventions, commands, and the per-utility overview
  (the de-facto architecture/design reference for this package).

## Decision Records

- [`decisions/0001-walkfiles-returns-only-regular-files.md`](decisions/0001-walkfiles-returns-only-regular-files.md)
  — why `walkFiles` guarantees every returned path is a regular file, and why a
  failed `stat` drops the entry instead of propagating.

<!--
No docs/architecture.md, design-patterns.md, or runbook.md: this package has no
runtime/framework to document beyond README.md + CLAUDE.md. Add them here if that
changes.
-->
