# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.6.0. For earlier versions see the
[git history](https://github.com/GenvidTechnologies/mcp-utils/commits/main) and the
[release tags](https://github.com/GenvidTechnologies/mcp-utils/tags).

## [Unreleased]

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

[Unreleased]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.5.1...v0.6.0
