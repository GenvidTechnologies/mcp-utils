# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.6.0. For earlier versions see the
[git history](https://github.com/GenvidTechnologies/mcp-utils/commits/main) and the
[release tags](https://github.com/GenvidTechnologies/mcp-utils/tags).

## [Unreleased]

### Added

- **`ObservedState.prime(roots)` and the exported `PrimeSummary` type.**
  `prime` walks the given directories and records a baseline — directories
  (and links to directories) as markers, files as fingerprints — filling gaps
  only and never throwing. It never overwrites an existing entry, does not
  descend into a path whose entry conflicts with the disk (the event path
  reports it, failing open), and skips subtrees already primed by an earlier
  call (so two watchers sharing one ledger cannot swallow each other's queued
  events). It returns `PrimeSummary`
  (`{ files, directories, complete }`); `complete: false` means the ledger
  can no longer vouch for the primed tree (a read failed, or a real
  fingerprint was evicted).

### Changed

- **`ObservedState` classifies directories, and `OptimisticWatcher.start()`
  primes a baseline, so read-only activity and directory events stop bumping
  `txId` (given a complete baseline on a filesystem with inodes; on a lossy
  ledger or a volume without inodes, directory events are re-evaluated and may
  bump).** On Windows with last-access updates enabled, listing a directory
  or first-reading a file fired a watch event that read as a content change.
  Observable differences:
  - `record` no longer fingerprints a directory (or a link to one): it stores
    a marker, and no `Fingerprinter` is called with a directory (unless
    `lstat` itself fails, in which case the path is treated as a file and the
    fingerprinter fails open).
  - `isChanged` on a recorded directory is no longer always `true`; it is
    `false` while it is the same directory. A directory marker stores the
    directory's identity (its `lstat` inode; unknown never matches) and a
    `scanned` flag (its children are known: from `prime`, a vouched scan, or
    empty at `record` time). A different directory swapped in by rename drops
    the old subtree and is evaluated like a never-seen one, and an unscanned
    directory that goes missing reports `true` (e.g. one moved in by a
    self-write, which `record`s it without its children). A never-seen
    directory still reports `true` unless it lies under a `prime`d root on a
    non-lossy ledger, where its files decide; with no marker to compare, that
    scan also drops recorded files it did not find and reports the change.
    On a filesystem without inode numbers the identity is unknown and the
    path is always re-evaluated, so every directory event on such a volume
    bumps and costs a scan of the subtree (an extra bump, not a missed
    change; not measured, no such volume was available).
  - A dropped link marker counts as a dropped live entry, so removing a
    directory that holds only a junction reads as changed, as removing the
    junction itself does. Keys have trailing slashes stripped (`D/` and `D`
    are one key); other spellings of one path (for example drive-letter case
    on Windows) remain separate keys.
  - **Known limit:** a directory renamed out of the watched tree, edited
    outside it, and renamed back before the watcher handles the move-out
    event (for example in one synchronous block) reads as unchanged. It keeps
    its identity and no file event arrives for the outside edit; its marker
    still claims its children are known, so files added during the round trip
    are not recorded until their own events arrive; if none do (the
    directory is later moved out or removed as a whole, which raises no
    per-file event), that later change reads as unchanged too. If the
    move-out event is handled first, the change is caught. Closing it would
    mean re-hashing a directory's subtree on every directory event, which
    would undo the quiet read-only path; [#29](https://github.com/GenvidTechnologies/mcp-utils/issues/29) tracks it.
  - Entries are indexed by parent, so dropping a subtree costs that subtree
    rather than the whole ledger.
  - `OptimisticWatcher.start()` now **synchronously walks and hashes the
    watched trees once** (once per instance, after the watch handles are
    created; a restart does not re-prime). Measured cost: about 12 ms for 49
    files, up to roughly 0.2-1.7 s for 1000 files of 32 KB (see ADR-0008).
  - **`forget(path)` now removes the path and every entry beneath it**
    (previously only the key). A path that is a file or missing likewise
    drops everything beneath it, whatever its own stored entry is, on
    `isChanged` and `record`, so a directory that comes back under a
    different identity is re-evaluated rather than matched against orphaned
    child fingerprints (but see the known limit above for the same-identity
    round trip).
  - A first event on a file that was in the baseline (under a primed root, on
    a complete ledger) no longer bumps `txId`; a file outside the baseline
    still bumps on its first event.
  - The scan of a never-seen directory under a primed root hashes its files
    synchronously on the event path, at a cost proportional to that subtree.
  - A throwing custom `Fingerprinter` no longer throws out of an L1/L2
    suppression's ledger `record`: the throw is now caught and logged, and the
    path stays unrecorded (previously it escaped the event handler).
  - `observed: null` is unchanged: every event not suppressed by L1/L2 bumps,
    including directory events and first-read access-time events, and no
    baseline is taken.

  **Size `maxEntries` to at least files plus directories.** Otherwise the
  baseline is incomplete (logged by `OptimisticWatcher`) and the watcher falls
  back to extra bumps rather than a missed change.

  **Start the watcher before reading the tree.** A write that lands between a
  consumer's own read and `start()` becomes part of the baseline and is not
  reported. Rationale and rejected alternatives:
  [ADR-0008](wiki/decisions/0008-observed-state-classifies-directories-and-primes-at-start.md).

  **Shipping as 0.11.0, a minor bump, not a patch — and consumers pinned at
  `^0.10.0` will *not* pick this up automatically.** Below 1.0.0 a caret pin
  excludes every minor bump: `^0.10.0` resolves as `>=0.10.0 <0.11.0`, so it
  does not reach them on a plain install; they must widen their range to
  `^0.11.0` deliberately. `construct3-chef`
  ([construct3-chef#284](https://github.com/GenvidTechnologies/construct3-chef/issues/284))
  is the consumer waiting on this.

## [0.10.0] - 2026-09-11

### Changed

- **`txToken`: `parseTxToken` now returns a discriminated result instead of
  `T | null`.** The return type is `{ ok: true; projectId; n } | { ok: false;
  reason: TxTokenParseFailure }`, where `TxTokenParseFailure` is a five-member
  union — `"not-a-string" | "no-separator" | "invalid-project-id" |
  "invalid-counter-shape" | "counter-out-of-range"` — one member per rejection
  branch. `TxTokenParseFailure` and `TxTokenParseResult` are new exported
  types. This exists because a consumer rendering a diagnostic previously had
  to re-derive the accept/reject rules locally to explain *why* a token was
  rejected — duplication this codec exists to remove, and duplication that
  fails silently the moment the accept set changes underneath it.

  **The accept set itself is unchanged** — the same tokens that used to parse
  successfully still do, and the same malformed tokens still fail; only the
  shape of a *rejection* is now classified instead of collapsed to `null`.

  **Breaking: any caller comparing `parseTxToken(...) === null` must move to
  `!result.ok`.** No importer of `parseTxToken` exists in this repo's known
  consumers today, so the change has no known affected caller, but the
  package is public on npm and unmeasured external consumers may exist.
  `compareTxToken` is unaffected — same `boolean` return, same truth table,
  same passing assertions.

  **Shipping as 0.10.0, a minor bump, not a patch — and consumers pinned at
  `^0.9.0` will *not* pick this up automatically.** Below 1.0.0 a caret pin
  excludes every minor bump: `^0.9.0` resolves as `>=0.9.0 <0.10.0`, so while
  the major stays `0`, npm's caret permits only patch updates. Both named
  downstream consumers (`construct3-chef`, `c3-domain-manager`) currently pin
  `^0.9.0` and must widen their range to `^0.10.0` deliberately to receive
  this change — it does not reach them on their next plain install.

## [0.9.0] - 2026-09-01

### Added

- **`txToken`: `isValidProjectId`, `formatTxToken`, `parseTxToken`, `compareTxToken` — a
  wire-format codec for `OptimisticWatcher`'s `txId`.** A `TxToken` is a plain string
  shaped `` `${projectId}:${n}` ``. This exists because `txId` itself is a plain
  `number` a watcher holds in memory; nothing in this package previously gave a
  consumer a canonical way to put one on the wire (e.g. as an MCP tool argument) and
  get it back safely. Two consumers depend on this exact shape —
  `GenvidTechnologies/c3-domain-manager#77` and
  `GenvidTechnologies/construct3-chef#95` —
  so the delimiter and the number encoding are a fixed contract, not an incidental
  string format. `formatTxToken` throws `TypeError` on an invalid `projectId`, or on
  an `n` that is not a non-negative safe integer; this is the one deliberate
  exception to the
  never-throw convention documented in `CLAUDE.md`'s Key Conventions, because its
  input is the server's own construction path, not off the wire. `parseTxToken` and
  `compareTxToken` are total — they never throw, returning `null` / `false` for any
  malformed input including non-string input — because their input *is* off the
  wire. The numeric half is strictly canonical: leading zeros, signs, whitespace,
  exponent notation, and hex are all rejected, and a digit string whose value
  exceeds `Number.MAX_SAFE_INTEGER` is **rejected** rather than silently coerced to
  a lossy one. Rationale and rejected alternatives:
  [ADR-0005](wiki/decisions/0005-tx-token-wire-format.md).

  **Shipping as a minor bump, not a patch.** These are new exports; nothing existing
  was removed or renamed. Note that `^0.8.0` — the range both named consumers pin
  today — **excludes** 0.9.0: below 1.0.0 a caret permits patch updates only. So
  picking this up downstream is deliberate work rather than a transparent bump,
  exactly as 0.8.0 was for consumers pinning `^0.7.0`.

- **`resolveRootFolders`: the plural counterpart of `resolveRootFolder`, returning
  every ambiguous-discovery candidate as a success.** `resolveRootFolder` already
  computed the full candidate set during ambiguous discovery, and it already
  reached the caller — as one absolute path per line in an `mcpError`'s
  `extraLines`, on an error result. `resolveRootFolders` returns `{ paths: string[];
  source }` instead, in which two-or-more candidates is a **success**, for the
  caller (a deferred `construct3-chef` multi-root auto-discovery consumer) that
  needs to register every candidate as its own project rather than reach a success
  through `isMcpError`. `resolveRootFolder` is now implemented on top of
  `resolveRootFolders` — one discovery walk, not two — but **its observable output
  is unchanged**: the same message, the same `extraLines`, the same error shape for
  the ambiguous case. All 32 pre-existing `resolveRootFolder` tests pass unmodified.
  Two other shapes for carrying the candidate list — a `structuredContent` payload
  and a bare top-level field on the ambiguous `mcpError` — were probed end-to-end
  over a real MCP client and confirmed to transport correctly, then rejected on
  design merit: both would have made a success reachable only through an error
  branch. Rationale and rejected alternatives:
  [ADR-0006](wiki/decisions/0006-resolve-root-folders-plural.md).

  **Shipping as a minor bump, not a patch.** `resolveRootFolders` and
  `ResolvedRoots` are new exports; nothing existing was removed or renamed. As
  above, `^0.8.0` **excludes** `0.9.0` below 1.0.0 — this does not reach existing
  caret-pinned consumers silently.

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

[Unreleased]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/GenvidTechnologies/mcp-utils/compare/v0.5.1...v0.6.0
