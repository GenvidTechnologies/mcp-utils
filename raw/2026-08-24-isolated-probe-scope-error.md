# Isolated-probe scope error — captured 2026-08-24

Session-local capture from the `#15` (`exposeDocs`) planning and
implementation run. Verbatim command output and file excerpts, recorded at the
moment they were produced. No public upstream for the session transcript; the
SDK excerpts below are re-fetchable from the pinned package version named.

Environment: `@modelcontextprotocol/sdk@1.29.0` installed under
`node_modules/` (declared `^1.27.1`), node v24.11.1, Windows 11.

---

## 1. The isolated probe, and its result

Run against `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/uriTemplate.js`:

```
docs:///{name}     docs:///readme                         MATCH {"name":"readme"}
docs:///{name}     docs:///reference/recipe-reference     null
docs:///{+path}    docs:///readme                         MATCH {"path":"readme"}
docs:///{+path}    docs:///reference/recipe-reference     MATCH {"path":"reference/recipe-reference"}
docs:///{+path}    docs:///a/b/c/deep                     MATCH {"path":"a/b/c/deep"}
--- expand round-trip ---
expand: docs:///reference/recipe-reference
re-match: {"path":"reference/recipe-reference"}
```

Traversal probe, same module:

```
=== does the CURRENT {name} template match traversal? ===
  docs:///../../../etc/passwd -> null
  docs:///..%2F..%2Fsecret -> {"name":"..%2F..%2Fsecret"}
  docs:///a/../../../outside -> null
=== does {+path} match traversal? ===
  docs:///../../../etc/passwd -> {"path":"../../../etc/passwd"}
  docs:///..%2F..%2Fsecret -> {"path":"..%2F..%2Fsecret"}
  docs:///a/../../../outside -> {"path":"a/../../../outside"}
=== where would those resolve on disk? ===
  docs:///../../../etc/passwd -> C:\etc\passwd.md
  docs:///..%2F..%2Fsecret -> C:\repos\mcp-utils\docs\..%2F..%2Fsecret.md
  docs:///a/../../../outside -> C:\repos\outside.md
```

**Every line above is accurate and reproducible.** The conclusion drawn from
it — that widening the template to `{+path}` opens a path-traversal hole —
was not.

## 2. What the caller actually does

`dist/esm/server/mcp.js`, lines 376-393, verbatim:

```js
this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = new URL(request.params.uri);
    // First check for exact resource match
    const resource = this._registeredResources[uri.toString()];
    if (resource) {
        if (!resource.enabled) {
            throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} disabled`);
        }
        return resource.readCallback(uri, extra);
    }
    // Then check templates
    for (const template of Object.values(this._registeredResourceTemplates)) {
        const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
        if (variables) {
            return template.readCallback(uri, variables, extra);
        }
    }
    throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
});
```

The template is matched against `uri.toString()` — the **normalised** form —
not against `request.params.uri`. Confirmed separately:

```
docs:///../secret                  -> new URL(...).toString() = docs:///secret
docs:///a/../../secret             -> new URL(...).toString() = docs:///secret
docs:///../../../etc/passwd        -> new URL(...).toString() = docs:///etc/passwd
docs:///a/b/../c                   -> new URL(...).toString() = docs:///a/c
```

## 3. End-to-end, through a real client

Driven over `InMemoryTransport` against the implemented `exposeDocs`, with a
sentinel file `TOP SECRET` written outside the documentation directory:

```
PROBE docs:///../secret => MCP error -32602: Resource docs:///secret not found
PROBE docs:///a/../../secret => MCP error -32602: Resource docs:///secret not found
PROBE docs:///../../../etc/passwd => MCP error -32602: Resource docs:///etc/passwd not found
PROBE docs:///..%2F..%2Fsecret => MCP error -32602: Resource docs:///..%2F..%2Fsecret not found
```

The `resolveWithin` containment guard never fires on any of them. Each fails
as an ordinary not-found *inside* the documentation directory. The sentinel is
never returned.

## 4. The second finding from the same run

A registered `list` callback made a pre-existing collision visible. With both
`README.md` and `docs/readme.md` present:

```
PROBE list = ["docs:///readme","docs:///readme"]
PROBE docs:///readme appears 2 time(s)
PROBE which wins on read: "# Root readme"
```

The SDK resolves an exact registered resource before any template (see the
excerpt in §2), so `docs/readme.md` was never readable — it only became
*visible* once the template began enumerating.

## 5. Excerpt: the rule that did not catch it

`docs/code-review-context.md`, "Factual accuracy of prose against its source
data", at commit `0e70d5f`:

> Where a change is justified by measurements — a probe table, a benchmark, a
> platform matrix — **diff every rendered claim against the source data before
> committing.**

Every rendered claim in the first version of ADR-0003 did trace faithfully
back to the §1 probe table. The rule was satisfied and the assertion was still
wrong, because the defect was in which entry point the probe targeted, not in
the transcription of its result.
