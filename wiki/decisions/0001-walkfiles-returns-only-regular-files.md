---
type: decision-context
title: 0001. walkFiles returns only regular files
description: Why `walkFiles` guarantees every returned path is a regular file, and why a failed `stat` drops the entry instead of propagating.
tags: [walkfiles, filesystem, symlinks, decision]
status: stable
generated: { by: human:ninoles, at: 2026-08-10T00:00:00Z }
sources:
  - id: issue-10
    resource: https://github.com/GenvidTechnologies/mcp-utils/issues/10
    title: "#10 — walkFiles returns directory symlinks whose name matches"
    last_modified: 2026-08-10
---

<!-- `stale_after` is deliberately omitted: an accepted ADR is a record of a
     decision made at a point in time, not a claim that decays. Supersession is
     modelled by `status`, not by a staleness date. -->

# 0001. walkFiles returns only regular files

- **Status:** accepted
- **Date:** 2026-08-10
- **Issue:** [#10](https://github.com/GenvidTechnologies/mcp-utils/issues/10)

## Context

`walkFiles` classified directory entries with `entry.isDirectory()` and treated
everything else as a leaf. A `Dirent` for a symlink reports `isDirectory() === false`
regardless of what it points at, so a directory symlink — or a Windows junction — whose
*name* satisfied the caller's predicate was returned as though it were a file. Broken
symlinks and symlink cycles were emitted the same way.

Every caller of `walkFiles` treats its result as a list of readable files, so those
entries surfaced as `EISDIR` at the read, one layer away from the helper that produced
them. Because this is a shared, published helper, every consumer inherits the behavior.

A caller *can* work around it — the offending entries do reach the predicate, since a
symlink's dirent fails `isDirectory()` and falls through to the predicate branch — so a
`statSync(p).isFile()` guard inside a predicate filters them out. But that duplicates the
same stat in every predicate at every call site (7 in `construct3-chef`), and it puts the
guarantee in the callers rather than in the helper that owes it.

The question the classification actually needs to answer is not "is this entry a
directory?" but **"will a subsequent read of this path succeed?"**

## Decision

**Every path returned by `walkFiles` is a regular file.** Callers may read any element
of the result without a further check.

Classification is a fast path plus a fallback:

- `entry.isDirectory()` → recurse (unchanged; this is also what bounds the walk, since
  it excludes every symlink whatever its target, so a cycle is never entered).
- `entry.isFile()` → accept with no extra syscall.
- anything else — every symlink, plus special entries — costs one **resolving**
  `statSync`, and only if the path already matched the predicate.

A `stat` that fails for **any** reason is treated as "not provably a regular file" and
the entry is dropped. This covers `ENOENT` (broken link), `ELOOP` (cycle), and `EACCES`
(unreadable parent).

The asymmetry with the existing `readdir` policy — where non-`ENOENT` errors are
re-thrown — is deliberate. Failing to *enumerate* a directory is structural: the walk
cannot proceed past it, and the caller needs to know. Failing to *classify* one leaf is
local: the walk can continue correctly without that entry, and a partial-walk exception
is not actionable for the caller.

An injectable `stat` seam was added as a 4th optional parameter, mirroring the existing
`readdir` seam. Both exist because ESM namespace members cannot be monkey-patched in
Node 22+, so a test seam has to live in the function signature. It is additive and
non-breaking.

## Compromise

**Rejected: bare `entry.isFile()`.** It fixes the reported bug with zero extra syscalls,
and is superficially consistent with the existing "symlinks are not followed" stance.
But `entry.isFile()` is `false` for *every* symlink, including one pointing at a regular
file — a case that works correctly today. Adopting it would silently drop those entries:
a regression shipped inside a bugfix, invisible to consumers until something went
missing. Only a resolved `stat` is correct across all five entry kinds.

**Rejected: re-throwing non-`ENOENT` stat failures** to mirror the `readdir` policy
literally. `fs.statSync`'s `throwIfNoEntry: false` option suppresses only `ENOENT` — it
does not make `statSync` total. Verified by probe on Node 24.11.1 / win32: a symlink
cycle throws `ELOOP` straight through it. Re-throwing would therefore have converted a
walk that merely returned a bad path into a walk that *throws*, handing callers a new
failure mode they never opted into, in the name of fixing a wrong-result bug. (Issue #10
proposed the resolved-`stat` mechanism but assumed `throwIfNoEntry: false` was
sufficient; its body has been corrected.)

**Accepted cost: one extra syscall per unusual entry.** Ordinary files and directories
are settled by the dirent with no syscall, and the stat is skipped entirely for entries
the predicate rejects — so the cost falls only on entries that are both non-ordinary and
matching, which are rare in practice.

**Accepted cost: a visible output change.** Directory symlinks and broken symlinks whose
names matched the predicate were previously returned and no longer are. That *is* the
fix, but consumers of a published package see their results change. The announcement
rides in `CHANGELOG.md` (started at 0.6.0), the commit body, the README, and this record.

Exposure, verified against each consumer's source rather than inferred:

| Consumer | Uses `walkFiles`? | Exposure |
|---|---|---|
| `construct3-chef` | yes — 7 call sites (`generators.ts:541`, `search.ts:193/196/217/223`, `spriteScaffold.ts:42`, `cli.ts:400`) | real |
| `c3-domain-manager` | **no** — imports MCP plumbing and `resolveRootFolder` only; its `CLAUDE.md` lists `walkFiles` among unadopted surface | none |

Issue #10 described `c3-domain-manager` as "presumably similarly exposed"; that guess was
wrong, and an earlier revision of this record repeated it as fact. Neither consumer picks
the fix up automatically regardless: both pin `^0.5.1`, and a caret on a `0.x` version
excludes `0.6.0`, so each needs an explicit range bump.

## Consequences

- Callers can drop any defensive `statSync(...).isFile()` they wrapped around
  `walkFiles` results. `construct3-chef#160` fixed this same failure class one layer up
  and can now lean on the helper instead.
- A predicate can only ever *narrow* the result. It is still invoked on non-regular
  entries — the predicate runs before the classification, not after — but the
  regular-file check gates the push, so returning `true` for a directory symlink cannot
  force it into the result. Verified with an always-matching predicate: the junction is
  passed to the predicate and still not returned.
- Because the predicate does see those entries, a caller-side `statSync(p).isFile()`
  guard is a valid workaround against the *pre-fix* behavior, and
  `construct3-chef#159` ships exactly that. Consumers were never blocked on this
  release. Once this lands, that clause is redundant at those call sites and can be
  dropped.
- If a future caller genuinely needs directories or symlinks in the result, that is a
  new option on `walkFiles` (e.g. an `include` filter), not a relaxation of this
  guarantee — the guarantee is what makes the result safe to read unconditionally.
- Watch for a caller that depended on the old behavior to *discover* directories by
  name. None is known; the exposure list above was checked.
