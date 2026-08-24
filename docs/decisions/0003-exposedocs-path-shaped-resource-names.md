# 0003. exposeDocs addresses nested docs by path, guarded by resolveWithin

- **Status:** accepted
- **Date:** 2026-08-24
- **Issue:** [#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)

## Context

`exposeDocs` resolved its documentation directory as a hardcoded
`path.resolve(packageDir, "docs")` and scanned it flat, registering the resource
template `docs:///{name}` with `list: undefined`.

Two consuming packages have moved their documentation into a nested `wiki/`
tier. `@genvidtech/construct3-chef` did so in its ADR-0028 and dropped `docs`
from `package.json`'s `files` in the same commit, which left the resource
serving nothing; it now regenerates a flat `docs/` alias into the published
tarball at pack time (its ADR-0029) as a stopgap whose recorded retirement
condition is this change. `c3-domain-manager` calls
`exposeDocs(server, __pkgDir)` at `src/mcp/server.ts:52` with `docs/` still
live, and has `wiki/` already stood up.

A directory argument alone would not have been enough. Measured against
construct3-chef at `74904bb`: of **49** tracked `wiki/**/*.md`, exactly **4**
sit at the bundle root (`index`, `local-verification-practice`, `log`,
`wiki-schema`) and **45** are nested. A `docsDir` pointed at `wiki/` with a flat
scan would expose 4 of 49 — and none of the three documents that repo's own
downstream consumer names by filename (`reference/cli.md`, `reference/ops.md`,
`reference/recipe-reference.md`), all of which are nested.

(The issue that proposed this change cited 45 / 4 / 41. Re-derived here: the
figures are 48 / 4 / 44 at the issue's filing revision `491459d` and 49 / 4 / 45
at `74904bb`. The correction does not touch the argument — the count of
top-level pages, which is what the argument rests on, is 4 either way.)

Two facts about the MCP SDK were probed against the installed
`@modelcontextprotocol/sdk@1.29.0` rather than assumed:

| Template | `docs:///readme` | `docs:///reference/recipe-reference` |
|---|---|---|
| `docs:///{name}` | `{name: "readme"}` | `null` |
| `docs:///{+path}` | `{path: "readme"}` | `{path: "reference/recipe-reference"}` |

Simple expansion never matches `/`, so the flat template cannot address a
nested page. Reserved expansion (`{+path}`) matches both, and round-trips:
`expand({path: "reference/recipe-reference"})` re-matches to the same value.

Second, `list: undefined` was a choice and not an SDK constraint. The
`resources/list` handler enumerates registered templates and skips one only
when its callback is absent — `if (!template.resourceTemplate.listCallback)
continue;`.

## Decision

**Address every document by its path, extension-less, through a single
`docs:///{+path}` template.** `exposeDocs` gains an options object with
`docsDir` (relative to `packageDir`, default `"docs"`) and `recursive`
(default `false`), supplies a real `list` callback so the template is
enumerable, and guards the read handler with `resolveWithin`.

The recursive scan is delegated to this package's own `walkFiles`, and resource
names are built with `toPosixPath`.

## Consequences

**Existing URIs keep working.** On a flat `docs/` directory, `docs:///cli`
matches `{+path}` and yields `{path: "cli"}` — the same document the old
template served. The swap is backward-compatible, which is why it does not need
a second template alongside it.

**The read guard is defence in depth, not a fix for a live hole — and the
distinction is worth recording precisely, because the first version of this
record got it wrong.**

Read in isolation, the widened template does match a traversal:
`UriTemplate("docs:///{+path}").match("docs:///../../../etc/passwd")` returns
`{path: "../../../etc/passwd"}`, where the old `docs:///{name}` returned
`null`. That measurement is real, and it is what the guard was originally
justified by.

It is also not reachable through `resources/read`, because it describes the
template in isolation rather than the path the SDK actually takes. The handler
builds `new URL(request.params.uri)` and matches against `uri.toString()`
(`dist/esm/server/mcp.js:376-390`), and RFC 3986 normalisation collapses `..`
segments during URL construction — so the template is never offered the raw
string. Measured end to end through an in-memory client:

| Requested | Reaches the template as | Outcome |
|---|---|---|
| `docs:///../secret` | `docs:///secret` | not found, inside `docsDir` |
| `docs:///a/../../secret` | `docs:///secret` | not found, inside `docsDir` |
| `docs:///../../../etc/passwd` | `docs:///etc/passwd` | not found, inside `docsDir` |
| `docs:///..%2F..%2Fsecret` | unchanged (still encoded) | not found, inside `docsDir` |

So widening the template does **not** open a traversal surface over the
protocol, and `resolveWithin` never fires on any of these.

The guard is kept anyway, and the reason is a boundary question rather than
timidity: that normalisation is the SDK's behaviour, not part of `exposeDocs`'
own contract. The read callback is a plain function that a consumer can invoke
directly, and a future SDK that matched the raw URI, or a transport that did
not round-trip through `URL`, would change the answer without anything here
changing. A single lexical containment check — already exported by this
package, no new dependency — is cheap enough that depending on someone else's
normalisation for containment is the worse trade.

A read that escapes and a read of a contained name that does not exist both
raise `McpError(ErrorCode.InvalidParams)`, matching what the SDK itself raises
for a resource it cannot resolve. Note this is a *thrown* `McpError`, not this
package's `mcpError` helper: that helper builds a `CallToolResult`, which is
the **tool** error shape, and `ReadResourceResult` has no error channel at all.

**`recursive` gates serving, not merely listing.** With it off, a nested name
is refused rather than quietly served, so the set that is advertised and the
set that is reachable are the same. The refusal checks the *shape* of the
requested name rather than membership of the collected set, and that
distinction is deliberate: the set is a snapshot taken at registration, and the
README documents that a flat document added after registration is still served
by name. Gating on membership would have silently retired that guarantee.

**`README.md` wins `docs:///readme`, so a shadowed `<docsDir>/readme.md` is not
advertised.** The SDK resolves an exact registered resource before consulting
any template, so such a file was never readable — but it was also never
*visible*, because the template enumerated nothing. Supplying a `list` callback
made the collision observable: the document set would have offered a URI that
reads back as the root `README.md`. It is dropped from the collected set, so
completions do not offer it either, and only while a `README.md` actually
exists to shadow it.

**`walkFiles` carries its own guarantees over.** It returns only regular files,
does not follow symlinked directories, terminates on symlink cycles, and yields
`[]` for a missing directory — all behaviours [ADR-0001](0001-walkfiles-returns-only-regular-files.md)
exists to establish. A bespoke recursion inside `exposeDocs` would have had to
re-derive them, and a doc tree containing a junction is exactly where that
would have failed.

**This is an observable behavior change and ships as a minor**, `0.8.0`, per
the rule in `CLAUDE.md`: the resource template string itself changes, and the
template now contributes entries to `resources/list` where it previously
contributed none. Consumers pin `^0.7.0`, which excludes `0.8.0`, so adoption
downstream is deliberate rather than silent. Naming the version here is a
version *choice*; the bump itself is a separate `chore(release)` commit at
release time.

## Alternatives considered

**Flat stem names with collision detection.** This is what construct3-chef's
`scripts/gen-docs-alias.mjs` does today, and reading it is what ruled the
approach out rather than any argument from first principles: it maps each page
to its bare stem, throws on a collision naming both source paths, and excludes
`index.md` and `log.md` at every level. That exclusion is not incidental — it is
the collision problem showing through, since a bundle with four section
directories has four `index.md` files that cannot all be `docs:///index`. Under
path-shaped names there is no collision to resolve and those pages become
addressable as `docs:///reference/index` and so on.

**A second template alongside the existing one** — keep `docs:///{name}` for
flat lookups and register `docs:///{+path}` only when `recursive` is set.
Rejected because `{+path}` already matches everything `{name}` matches, so the
two templates would overlap completely on a flat directory, giving two URIs for
one document and two entries to reconcile in `resources/list`. The conservatism
it buys is illusory: the single template is already backward-compatible.

**Percent-decoding the matched path.** Not done. `{+path}` returns the raw
matched value, so `docs:///..%2F..%2Fsecret` yields the literal
`..%2F..%2Fsecret`, which resolves to a strange filename inside the docs
directory and fails to open — harmless, and measured as such in the table
above. This is also the one input in that table which URL normalisation does
**not** touch, since `%2F` is not a path separator until it is decoded. Any
future change that adds decoding therefore has to apply `resolveWithin` *after*
decoding, and would be the case where the guard stops being defence in depth
and starts being load-bearing.

## A note on how this record was corrected

The first version of this ADR asserted that the widened template opened a live
path-traversal hole, and justified the read guard by it. That claim came from
probing `UriTemplate.match()` directly on a raw URI string. The probe result
was accurate; the inference was not, because the SDK normalises the URI through
`new URL()` before the template is consulted, so no caller can deliver that raw
string. The error was corrected after an end-to-end test through a real
in-memory client contradicted the isolated probe.

It is recorded here rather than quietly edited out because the failure mode
generalises: a component probed in isolation can answer a question the
integrated system never asks, and the isolated result is the more precise-looking
of the two. `docs/code-review-context.md` already asks that every measured
figure in shipped text trace to data produced by the change itself — this is the
same rule applied to a measurement's *scope* rather than its value.
