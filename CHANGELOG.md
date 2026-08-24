# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.6.0. For earlier versions see the
[git history](https://github.com/GenvidTechnologies/mcp-utils/commits/main) and the
[release tags](https://github.com/GenvidTechnologies/mcp-utils/tags).

## [Unreleased]

### Changed

- **`docs/` is retired; the wiki is this repo's only documentation tier.** The
  three ADRs moved to `wiki/decisions/`, `code-review-context.md` to
  `wiki/process/`, and `wiki-schema.md` to `wiki/wiki-schema.md`; `docs/TOC.md`
  folded into `wiki/index.md` rather than moving, since both indexed the same
  corpus. The rule governing what earns a wiki page changed with it, from
  "generalizes past this package" to **"exactly one page owns a given fact"** —
  the old bar would have rejected the ADRs it now hosts. Recorded in
  [ADR-0004](wiki/decisions/0004-wiki-is-the-only-documentation-tier.md).

  **No API change and no version bump.** `docs/` never shipped in the npm
  tarball (`files` is `["dist","LICENSE","README.md"]`), and this package never
  calls `exposeDocs` on itself, so consumers see nothing. The only `src/` edit
  is one ADR path in a `walkFiles` docstring. `README.md`'s four ADR links now
  point at `wiki/decisions/`; those do ship, and resolve against GitHub from
  the package page.

  Note for anyone reading `exposeDocs`' docs: its `docsDir` default is still
  `"docs"`. This change retires *this repo's* `docs/` directory and says
  nothing about the utility's default.

## [0.8.0] - 2026-08-24

### Added

- **`exposeDocs` takes an options object: `docsDir` and `recursive`.** `docsDir`
  (default `"docs"`) names the documentation directory relative to `packageDir`;
  `recursive` (default `false`) descends subdirectories and exposes nested
  documents under path-shaped, extension-less names — `wiki/reference/cli.md`
  becomes `docs:///reference/cli`. Both default to the previous behavior.
  Rationale and rejected alternatives:
  [ADR-0003](docs/decisions/0003-exposedocs-path-shaped-resource-names.md).
- **Documented `exposeDocs` in `README.md`.** It has been exported from
  `src/index.ts` since it shipped, but had no README section, so consumers had no
  way to discover it from the package page. No behavior change — documentation
  only.
- **A grouped index at the top of README's `## Utilities` section**, covering all
  17 documented exports.

### Changed

- **`exposeDocs`' resource template is now `docs:///{+path}`, not
  `docs:///{name}`.** This changes output for existing consumers, though no
  existing URI changes: RFC 6570 reserved expansion also matches a name with no
  separator, so `docs/guide.md` is still `docs:///guide`. What is new is that a
  *nested* name matches at all — simple expansion returned `null` for one.
- **`exposeDocs`' `docs` template now contributes entries to `resources/list`.**
  It previously contributed none: the template set `list: undefined`, and the SDK
  skips a template whose callback is absent, so only the static `docs:///readme`
  was listed. Clients that enumerate resources will see the whole document set
  where they previously saw one entry.
- **`exposeDocs` raises `McpError(InvalidParams)` for a name it cannot serve.**
  Previously the read handler opened the resolved path directly, so an unknown
  name surfaced a raw `ENOENT` — reaching the client as an internal error
  carrying an absolute host path. This matches what the MCP SDK itself raises
  for a resource it cannot resolve.
- **`exposeDocs` no longer advertises a `<docsDir>/readme.md` that `README.md`
  shadows.** The static `README.md` resource owns `docs:///readme`, and the SDK
  resolves an exact resource before any template, so such a file was never
  readable. It was invisible before because the template listed nothing; now
  that it enumerates, listing it would have advertised a URI that reads back as
  a different document. With no `README.md` present it is exposed normally.
- **`exposeDocs`' flat scan now goes through `walkFiles`**, so it inherits that
  helper's regular-file guarantee. A *directory* named `guide.md` is no longer
  offered as a document; it was previously listed in completions and then failed
  the read with `EISDIR`.

## [0.7.0] - 2026-08-16

### Changed

- **`OptimisticWatcher` now bumps `txId` once per logical change, not once per watcher
  event.** Some filesystems deliver more than one raw `fs.watch` event for a single
  write — measured consistently on Windows/NTFS — so `txId` counted events rather than
  changes.

  **This changes output for existing consumers.** Measured against the real `fs.watch`
  factory, before and after, 4/4 runs each:

  | Scenario | Before | After |
  |---|---|---|
  | external create | `txId` +2 | +1 |
  | `expect()`-ed self write | +1 | **+0** |
  | external overwrite | +2 | +1 |
  | four distinct external writes | +8 | +4 |

  Detection is not weakened — only duplicates collapse. Four genuinely distinct writes
  still produce four bumps, and a deletion still bumps. The one case that no longer
  bumps is an external writer restoring byte-identical content, which is benign: a
  consumer re-reading gets exactly what it already believes it holds.

  If you counted `txId` deltas as an event-count proxy rather than a change-count proxy,
  that count roughly halves. Pass `observed: null` to restore the previous behavior. See
  [ADR-0002](docs/decisions/0002-observed-state-collapses-duplicate-watch-events.md) for
  the rationale and the rejected alternatives.

### Added

- `ObservedState` and `contentFingerprint` (plus the `Fingerprinter` type): a bounded,
  pluggable path → content-fingerprint ledger. `isChanged(path)` is check-and-record,
  mirroring `ExpectedChanges.consume`'s check-and-remove. Exported standalone, and used
  as `OptimisticWatcher`'s third suppression layer.
- `OptimisticWatcherOptions.observed?: ObservedState | null` — omitted constructs a
  default instance (the fix is on by default); `null` opts out. Additive and
  non-breaking.

### Fixed

- `OptimisticWatcher` bumped `txId` twice for one external write and once for an
  `expect()`-ed self write that should not have bumped at all, breaking the
  optimistic-concurrency contract for consumers that replay a `txId` a mutate tool just
  handed them. ([#12](https://github.com/GenvidTechnologies/mcp-utils/issues/12))

## [0.6.0] - 2026-08-10

### Changed

- **`walkFiles` now returns only regular files.** Every returned path is guaranteed to be
  a regular file, so callers can read any element of the result without a further check.

  **This changes output for existing callers.** Entries that are not regular files are no
  longer returned even when their *name* matches:

  | Entry | Before | After |
  |---|---|---|
  | regular file | returned | returned |
  | symlink → regular file | returned | returned |
  | symlink → directory (incl. Windows junctions) | **returned** | not returned |
  | broken symlink | **returned** | not returned |
  | symlink cycle | **returned** | not returned |
  | socket, device, other special entries | **returned** | not returned |

  If you wrap `walkFiles` results in your own `statSync(p).isFile()` guard, that guard is
  now redundant and can be dropped. If you relied on the old behavior to discover
  directories by name, that no longer works — filter the directory listing yourself.

  A failed `stat` drops the entry rather than propagating, so a walk over a tree
  containing a symlink cycle or an unreadable entry completes instead of throwing.
  `readdir` failures still propagate as before. See
  [ADR-0001](docs/decisions/0001-walkfiles-returns-only-regular-files.md) for the
  rationale and the rejected alternatives.

### Added

- `walkFiles` accepts an optional 4th `stat` parameter, an injectable test seam
  defaulting to `fs.statSync(p, { throwIfNoEntry: false })`, alongside the existing
  `readdir` seam. Additive and non-breaking; production callers omit both.

### Fixed

- `walkFiles` emitted a directory symlink or Windows junction as a file path when its
  name satisfied the caller's filter, so callers reading the result crashed with
  `EISDIR`. Broken symlinks and symlink cycles were emitted the same way.
  ([#10](https://github.com/GenvidTechnologies/mcp-utils/issues/10))

[Unreleased]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.5.1...v0.6.0
