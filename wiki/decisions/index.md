<!-- A `wiki/<subdir>/index.md` carries NO frontmatter at all — `okf_version` is
     permitted only on the bundle-root index (`wiki/index.md`). See
     `../wiki-schema.md` § "Page format". -->

# Decision Records

Architecture Decision Records for `@genvidtech/mcp-utils`. Each records one
non-trivial decision, the alternatives weighed, and the compromise accepted —
the durable rationale that would otherwise live only in a PR thread.

An accepted ADR is a record of a decision made at a point in time. It is not
revised when the world moves; it is **superseded** by a later record, which is
what the frontmatter `status` key models. That is also why these pages carry no
`stale_after`.

Each entry's description is the linked page's frontmatter `description`, so the
index and the page can't drift.

* [0001. walkFiles returns only regular files](0001-walkfiles-returns-only-regular-files.md) - Why `walkFiles` guarantees every returned path is a regular file, and why a failed `stat` drops the entry instead of propagating.
* [0002. ObservedState collapses duplicate watch events](0002-observed-state-collapses-duplicate-watch-events.md) - Why `OptimisticWatcher` gains a third, content-fingerprint suppression layer to collapse the duplicate `fs.watch` events measured per single write.
* [0003. exposeDocs addresses nested docs by path, guarded by resolveWithin](0003-exposedocs-path-shaped-resource-names.md) - Why `exposeDocs` addresses nested documents by path through a single `docs:///{+path}` template, and why that makes the `resolveWithin` read guard required rather than optional.
* [0004. The wiki is this repo's only documentation tier](0004-wiki-is-the-only-documentation-tier.md) - Why `docs/` was retired into `wiki/`, what replaced the wiki's scope bar, and the two hardcoded plugin literals that relocation knowingly breaks.
* [0005. The tx-token wire format is a shared codec, not a per-consumer implementation](0005-tx-token-wire-format.md) - Why `formatTxToken`/`parseTxToken`/`compareTxToken`/`isValidProjectId` ship as one `${projectId}:${n}` codec in this package, and why lenient `n`-parsing and a branded token type were both rejected.
* [0006. resolveRootFolders ships as an additive plural, not a field on the ambiguous error](0006-resolve-root-folders-plural.md) - Why ambiguous discovery becomes a success on a new `resolveRootFolders({ paths, source })` rather than a `matches` field on `resolveRootFolder`'s error result, and why both rejected error-payload options were probed end-to-end before being rejected on design merit.
