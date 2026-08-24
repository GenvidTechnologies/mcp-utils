# @genvidtech/mcp-utils

Shared utilities for building MCP servers: concurrency control, file-change tracking, text pagination, path and filesystem helpers, MCP response and error helpers, tool annotations, optimistic file watching, and project-config loading.

## Installation

```sh
npm install @genvidtech/mcp-utils
```

`zod` is a **peer dependency** (`^3.23.0`) — only required if you use `loadProjectConfig`. Install it alongside this package:

```sh
npm install zod
```

```ts
import {
  ReadWriteLock, ExpectedChanges, paginateText,
  walkFiles, resolveWithin, resolveRootFolder, escapeRegExp, toPosixPath,
  mcpError, withMcpErrors, bufferingLogger, paginatedContent, mcpContent,
  READ_ONLY, REGENERATE, MUTATE, NON_IDEMPOTENT_READ,
  OptimisticWatcher, loadProjectConfig, isMcpError,
  ObservedState, contentFingerprint,
} from "@genvidtech/mcp-utils";
```

## Utilities

Each utility is independent — import only what you need. Grouped here the same way as the per-utility list in [`CLAUDE.md`](CLAUDE.md).

**Concurrency & state**

- [`ReadWriteLock`](#readwritelock) — promise-based, write-preferring read-write lock
- [`ExpectedChanges`](#expectedchanges) — suppress self-triggered file-watcher events
- [`OptimisticWatcher`](#optimisticwatcher) — classify watch events as self-writes vs. external
- [`ObservedState`](#observedstate) — bounded path → content-fingerprint ledger

**Filesystem & path**

- [`walkFiles`](#walkfiles) — recursive walk returning only regular files
- [`resolveWithin`](#resolvewithin) — lexical path-traversal guard
- [`resolveRootFolder`](#resolverootfolder) — resolve a project root by precedence
- [`loadProjectConfig` / `isMcpError`](#loadprojectconfig--ismcperror) — read, merge, and validate a project config

**Strings**

- [`escapeRegExp` / `toPosixPath`](#escaperegexp--toposixpath) — regex escaping and path separator normalization

**MCP responses, errors & annotations**

- [`mcpError` / `withMcpErrors`](#mcperror--withmcperrors) — turn a thrown value into a `CallToolResult`
- [`mcpContent`](#mcpcontent) — success-path counterpart to `mcpError`
- [`paginatedContent`](#paginatedcontent) — paginated text as a `CallToolResult`
- [`paginateText`](#paginatetext) — line-based pagination
- [Tool annotation presets](#tool-annotation-presets) — `READ_ONLY`, `REGENERATE`, `MUTATE`, `NON_IDEMPOTENT_READ`
- [`exposeDocs`](#exposedocs) — serve a package's Markdown docs (flat or nested) and `README.md` as MCP resources

**Shared types**

- [`bufferingLogger`](#bufferinglogger) — a `Logger` that buffers lines in memory
- [`Logger` type](#logger-type) — the minimal logging interface used across utilities

### ReadWriteLock

A promise-based, write-preferring read-write lock. Multiple concurrent readers are allowed; writers get exclusive access. Pending writes are serviced before queued reads to prevent write starvation.

```ts
const lock = new ReadWriteLock();

// Multiple readers can run concurrently
const result = await lock.read(async () => {
  return readSharedState();
});

// Writers get exclusive access; queued reads wait until all writes drain
await lock.write(async () => {
  mutateSharedState();
});
```

### ExpectedChanges

Tracks file paths that an MCP write tool is about to modify so that a file watcher can suppress the self-triggered change event. Entries auto-expire after a configurable TTL (default: 5000 ms) to prevent stale suppression if a write fails or the watcher event is delayed.

```ts
const expected = new ExpectedChanges(5000); // ttlMs optional, default 5000

// Register before writing
expected.add("/path/to/file.json");
try {
  await fs.writeFile("/path/to/file.json", newContent);
} finally {
  expected.remove("/path/to/file.json"); // clean up if watcher fires before expiry
}

// In your file watcher callback:
if (expected.consume(changedPath)) {
  return; // suppress — we triggered this change ourselves
}
handleExternalChange(changedPath);
```

`consume()` returns `true` and removes the entry if the path was registered and has not expired. Call `purgeExpired()` periodically to clean up entries from writes whose watcher events never fired.

### paginateText

Paginates large text content by line using a 1-based `offset` and `limit`. A trailing newline does not count as an extra line.

```ts
import { paginateText } from "@genvidtech/mcp-utils";

const result = paginateText("a\nb\nc\n", { offset: 2, limit: 1 });
// {
//   text: "b",
//   totalLines: 3,
//   offset: 2,
//   limit: 1,
//   hasMore: true,
// }
```

**PaginationOptions**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `offset` | `number` | `1` | 1-based start line |
| `limit` | `number` | all lines | Maximum lines to return |

**PaginatedResult**

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | The requested slice of text |
| `returnedLines` | `number` | Number of lines actually returned (`0` for an out-of-range page) |
| `totalLines` | `number` | Total line count of the input |
| `offset` | `number` | Actual offset used |
| `limit` | `number` | Actual limit used |
| `hasMore` | `boolean` | True if lines remain after this page |

### Logger type

A minimal logger interface used by MCP server utilities:

```ts
import type { Logger } from "@genvidtech/mcp-utils";

function setup(log: Logger) {
  log("server started");
}
```

### walkFiles

Recursively walks a directory and returns the absolute paths of all files whose path satisfies `match`. If the directory does not exist the function returns `[]` without throwing; other I/O errors (e.g. `EACCES`) from reading a directory are re-thrown. Symlinked directories are not followed — only entries for which `entry.isDirectory()` returns `true` are recursed into, which also means a symlink cycle is never entered.

**Every returned path is a regular file**, so you can read any element of the result without a further check. Entries that are not regular files are never returned, even when their *name* satisfies `match`:

| Entry | Returned? |
|---|---|
| regular file | yes |
| directory | no (recursed into instead) |
| symlink → regular file | yes — reading it succeeds |
| symlink → directory (incl. Windows junctions) | no |
| broken symlink, symlink cycle, socket, device | no |

Ordinary entries are classified from the directory listing alone; only the leftovers (symlinks and special entries) cost one resolving `stat`, and only when they already matched `match`. An entry whose `stat` fails for any reason is dropped rather than propagated — failing to classify one leaf doesn't abort the walk, whereas failing to enumerate a directory does. See [ADR-0001](docs/decisions/0001-walkfiles-returns-only-regular-files.md).

```ts
import { readFileSync } from "node:fs";
import { walkFiles } from "@genvidtech/mcp-utils";

// String match: suffix / endsWith test
const jsonFiles = walkFiles("/project/data", ".json");

// Predicate match: arbitrary filter
const testFiles = walkFiles("/project/src", (p) => p.includes(".test."));

// Every result is readable — no isFile() guard needed
for (const f of jsonFiles) JSON.parse(readFileSync(f, "utf-8"));
```

The optional 3rd and 4th parameters (`readdir`, `stat`) are test seams that default to `fs.readdirSync` / `fs.statSync`; production callers omit both.

### escapeRegExp / toPosixPath

Two lightweight string helpers.

`escapeRegExp` escapes all regex metacharacters in a string so it can be used as a literal pattern inside `new RegExp(...)`.

`toPosixPath` converts all backslashes to forward slashes, producing a POSIX-style path. No-ops on paths that already use forward slashes.

```ts
import { escapeRegExp, toPosixPath } from "@genvidtech/mcp-utils";

const pattern = new RegExp(escapeRegExp("file.name[0]")); // literal match

const posix = toPosixPath("C:\\Users\\dev\\project"); // "C:/Users/dev/project"
```

### resolveWithin

Resolves `rel` against `base` and returns the absolute path only if it stays within `base`; returns `null` otherwise. Use this as a path-traversal guard when accepting user-supplied path **strings**.

- `""` and `"."` resolve to `base` itself and are returned.
- A `rel` that escapes `base` via `..` segments, an absolute path outside `base`, or a cross-drive path on Windows all return `null`.
- A filename that merely starts with `..` without traversing upward (e.g. `..gitkeep`) stays inside `base` and is returned.

> **Lexical only.** This does no filesystem access and does **not** resolve symlinks — a symlink inside `base` pointing outside it will be accepted. For an on-disk containment guarantee (sandboxing attacker-supplied paths against symlink escapes), `fs.realpath` the result and re-check.

```ts
import { resolveWithin } from "@genvidtech/mcp-utils";

resolveWithin("/project", "src/index.ts"); // "/project/src/index.ts"
resolveWithin("/project", "../secret");    // null  — escapes base
resolveWithin("/project", "");             // "/project"
```

### resolveRootFolder

Resolves a project root directory for an MCP server using a four-level precedence chain — `explicit` > `env` > `discovery` > `cwd` — so bundled servers launched with no CLI arguments don't need to hand-roll this logic.

```ts
import { resolveRootFolder, isMcpError } from "@genvidtech/mcp-utils";

const result = resolveRootFolder({
  explicit: args.projectDir,        // highest precedence: CLI flag
  envVar: "MY_SERVER_PROJECT_DIR",  // second: environment variable
  marker: "project.c3proj",         // discovery: look for this entry in child dirs
  searchDepth: 2,                   // how many levels below cwd to search (default: 1)
});

if (isMcpError(result)) return result; // propagate any error
const { path, source } = result;
if (source === "cwd") {
  console.warn("No project root found; using cwd:", path);
}
```

**ResolveRootFolderOpts**

| Field | Type | Default | Description |
|---|---|---|---|
| `marker` | `string` | — | Filename or directory name that identifies a project root (e.g. `"project.c3proj"`, `".git"`). Required; must be non-empty/non-whitespace or an `mcpError` is returned. |
| `explicit` | `string` | — | Highest-precedence override. Relative values are resolved against `cwd`; absolute values used as-is. **No containment restriction** — a `../sibling` path is permitted. |
| `envVar` | `string` | — | Name of an environment variable to check when `explicit` is absent. Same resolution rules as `explicit`. |
| `cwd` | `string` | `process.cwd()` | Starting directory for discovery and the resolution base for relative `explicit`/`envVar` values. |
| `searchDepth` | `number` | `1` | Maximum depth below `cwd` at which to search for the marker. Depth `1` checks immediate children of `cwd`; depth `0` checks only `cwd` itself. |

**ResolvedRoot**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Absolute path to the resolved project root. |
| `source` | `"explicit" \| "env" \| "discovery" \| "cwd"` | How the root was determined. `"cwd"` means no marker was found anywhere — the silent fallback; consumers typically warn on this value. |

**Resolution algorithm**

1. If `opts.explicit` is set and non-blank → return it (resolved to absolute). No containment restriction.
2. Else if `opts.envVar` is set and the named env var is non-blank → return it (resolved to absolute). No containment restriction.
3. Else search for a directory that **contains** `opts.marker`:
   - Check `cwd` itself (depth 0), then scan child directories up to `opts.searchDepth`.
   - Exactly 1 match → return it with `source: "discovery"`.
   - 0 matches → fall through to step 4.
   - ≥2 matches → return `mcpError` (ambiguous root). Only `cwd` and its descendants are searched; discovery never escapes the base directory.
4. Return `cwd` with `source: "cwd"` — no marker found anywhere.

**Never throws.** I/O errors from directory scanning are caught: `ENOENT` is treated as "no entries"; all other errors (e.g. `EACCES`) are returned as `mcpError`. Use `isMcpError` to narrow the `ResolvedRoot | CallToolResult` return type.

### mcpError / withMcpErrors

Helpers that turn thrown errors into `CallToolResult` responses with `isError: true`, so MCP tool handlers can report failures without letting exceptions propagate to the transport layer.

`mcpError(e, extraLines?)` converts a caught value into a `CallToolResult`. `Error` instances use `.message`; everything else is converted with `String(e)`. The second argument is either the legacy `string[]` of `extraLines` (appended to the message, evaluated eagerly) **or** an options object `{ prefix?, extraLines? }`. An opt-in `prefix` is prepended as `` `${prefix} ${message}` `` (single space; pass it without a trailing space, e.g. `"Error:"`); the default is no prefix, so existing callers are unaffected.

`withMcpErrors(fn, opts?)` wraps an async handler so any thrown error is caught and returned as `mcpError(...)`. The second argument is either the legacy **thunk** `() => string[]` (called only at catch time — useful for reading mutable state such as a log buffer or transaction counter that may have changed between the call and the throw) **or** an options object `{ extraLines?, onError?, prefix? }`:

- `extraLines: () => string[]` — same catch-time thunk semantics as the legacy form. A thunk that throws degrades to no extra lines (the primary error is still reported); `withMcpErrors` never throws out.
- `onError: (err) => void | Promise<void>` — a side-effect hook invoked with the caught error **before** it is formatted, and **awaited**. Use it to run cleanup that must happen even on the error path (e.g. bumping an optimistic-concurrency watcher because files were already written before a cancellation). If `onError` itself throws, the thrown value is formatted in place of the original error — `withMcpErrors` still never throws out.
- `prefix: string` — passed through to `mcpError` (see above).

```ts
import { mcpError, withMcpErrors, bufferingLogger } from "@genvidtech/mcp-utils";

// Direct conversion of a caught error
try {
  await doWork();
} catch (err) {
  return mcpError(err, ["context: file write failed"]);
}

// Opt-in "Error:" prefix:
mcpError(new Error("boom"), { prefix: "Error:" });
// content[0].text === "Error: boom"

// Wrap a handler; extraLines thunk reads state at catch time
const { log, text } = bufferingLogger();
const handler = withMcpErrors(
  async (args) => {
    log("starting");
    await doWork(args);
    return { content: [{ type: "text", text: "ok" }] };
  },
  () => [text()],  // captures log output accumulated before the throw
);

// Options form: run a side-effect on the error path, then prefix the message
const mutateHandler = withMcpErrors(
  async (args) => mutateAndRespond(args),
  {
    onError: (err) => { if (err instanceof CancelledError) watcher.bump(); },
    prefix: "Error:",
  },
);
```

### bufferingLogger

Creates a logger that captures all log calls in memory instead of writing to stdout. Returns `{ log, text }` where `log` is a `Logger` that buffers each call as a line (multiple arguments joined by a single space via `String()` coercion), and `text()` returns the accumulated lines joined by `"\n"`.

```ts
import { bufferingLogger } from "@genvidtech/mcp-utils";

const { log, text } = bufferingLogger();
log("processed", 3, "files");
log("done");
text(); // "processed 3 files\ndone"
```

### paginatedContent

Wraps `paginateText` and returns a `CallToolResult` whose single text block combines the page text and a `lines: A-B / total` range footer, joined with a blank line (`"\n\n"`). The range footer is emitted **only when `offset` or `limit` was supplied** (matching the consumer's `paginatedResponse`); an un-paginated call returns the whole text with no footer. An out-of-range page reports `lines: 0 / total` (no misleading range, no leading blank lines). An optional `footer(r)` callback receives the full `PaginatedResult` and its return value is appended on a new line; the callback always runs.

```ts
import { paginatedContent } from "@genvidtech/mcp-utils";

const result = paginatedContent("a\nb\nc\n", { offset: 1, limit: 2 });
// result.content[0].text === "a\nb\n\nlines: 1-2 / 3"

// No offset/limit → no range footer:
paginatedContent("a\nb\nc\n", {});
// content[0].text === "a\nb\nc"

// Out-of-range page → "lines: 0 / N":
paginatedContent("a\nb\nc\n", { offset: 5, limit: 2 });
// content[0].text === "lines: 0 / 3"

// With an optional caller footer:
const withFooter = paginatedContent(
  "a\nb\nc\n",
  { offset: 1, limit: 2 },
  (r) => `hasMore: ${r.hasMore}`,
);
// withFooter.content[0].text === "a\nb\n\nlines: 1-2 / 3\nhasMore: true"
```

### mcpContent

The success-path counterpart to `mcpError`. `mcpContent(text, footer?)` builds a `CallToolResult` with a **single** text block from a result plus an optional trailing `footer` line — so a result and its trailing metadata (e.g. `txId: <n>`) ride inside one block instead of the caller hand-rolling a second content block. Unlike `paginatedContent`'s footer callback, `footer` here is a plain string the caller computes (there is no derived result to pass). `text` and `footer` are joined by a single `"\n"`; when `text` is empty only the footer is emitted. No `isError` field is set.

```ts
import { mcpContent } from "@genvidtech/mcp-utils";

mcpContent("wrote 3 files");
// content[0].text === "wrote 3 files"

mcpContent("wrote 3 files", `txId: ${txId}`);
// content[0].text === "wrote 3 files\ntxId: 7"
```

### Tool annotation presets

Four `ToolAnnotations` constants for use when registering MCP tools. Each preset sets `readOnlyHint`, `destructiveHint`, and `idempotentHint` to reflect the tool's expected behavior.

```ts
import { READ_ONLY, REGENERATE, MUTATE, NON_IDEMPOTENT_READ } from "@genvidtech/mcp-utils";

server.tool("list-files", schema, READ_ONLY, handler);
server.tool("write-config", schema, REGENERATE, handler);
server.tool("delete-entry", schema, MUTATE, handler);
server.tool("consume-event", schema, NON_IDEMPOTENT_READ, handler);
```

| Preset | `readOnlyHint` | `destructiveHint` | `idempotentHint` | Use when |
|---|---|---|---|---|
| `READ_ONLY` | `true` | `false` | `true` | Reads state, no side effects, safe to repeat |
| `REGENERATE` | `false` | `false` | `true` | Writes output but repeated calls produce the same result; nothing permanently lost |
| `MUTATE` | `false` | `true` | `false` | Modifies or deletes data; cannot be trivially undone; result may differ across calls |
| `NON_IDEMPOTENT_READ` | `true` | `false` | `false` | Reads without modification but each call may return different results (e.g. consuming a queue) |

### exposeDocs

Registers a consuming package's Markdown documentation as MCP resources, so a client can read the server's own docs. Takes the package directory and resolves the documentation directory and `README.md` beneath it.

```ts
import { exposeDocs } from "@genvidtech/mcp-utils";

// packageDir is your server package's root — the directory holding docs/ and README.md
exposeDocs(server, packageDir);

// Or point it at a nested documentation tree
exposeDocs(server, packageDir, { docsDir: "wiki", recursive: true });
```

| Option | Default | Meaning |
|---|---|---|
| `docsDir` | `"docs"` | Directory holding the `*.md` files, resolved relative to `packageDir`. |
| `recursive` | `false` | Descend subdirectories and expose nested documents under path-shaped names. |

Two resources are registered:

| Resource | URI | Serves |
|---|---|---|
| `docs` | `docs:///{+path}` (templated) | `<packageDir>/<docsDir>/<path>.md` |
| `readme` | `docs:///readme` (static) | `<packageDir>/README.md` |

Both are returned with `mimeType: "text/markdown"`. The `readme` resource is registered **only if `README.md` exists**; the templated `docs` resource is registered unconditionally, even when the documentation directory is absent.

Names are the document's path beneath `docsDir`, always with forward slashes and without the `.md` extension — `wiki/reference/cli.md` is `docs:///reference/cli`. The template uses RFC 6570 reserved expansion (`{+path}`), which matches a name containing no separator just as well, so a flat layout addresses exactly as it did before: `docs/guide.md` remains `docs:///guide`.

Behavior worth knowing before you rely on it:

- **`recursive` governs what is served, not just what is listed.** With it off, a nested name is refused rather than quietly served, so the exposed set matches the advertised one.
- **The name list is a snapshot.** The directory is walked once, when `exposeDocs` is called. Files added afterwards are still served correctly if requested by name, but won't appear in listings or completions until the server restarts.
- **The document set is enumerable.** The template supplies a `list` callback, so `resources/list` returns every discovered document alongside the static `docs:///readme`. Argument completion offers the same set.
- **Only regular files are offered.** The scan runs through [`walkFiles`](#walkfiles), so symlinked directories aren't followed, cycles terminate, and a *directory* named `guide.md` is never mistaken for a document.
- **An unresolvable name raises `McpError(InvalidParams)`.** Both a name with no matching file and one that escapes the documentation directory surface as a well-formed protocol error, matching what the SDK itself raises for a resource it cannot resolve — not a raw `ENOENT` carrying an absolute host path.

The read handler passes each name through [`resolveWithin`](#resolvewithin) before opening it. This is defence in depth rather than a fix for a reachable escape: the SDK normalises the requested URI through `new URL()` before matching, which collapses `..` segments, so a traversal is already contained by the time the template sees it. The guard means containment doesn't *depend* on that normalisation. See [ADR-0003](docs/decisions/0003-exposedocs-path-shaped-resource-names.md).

### OptimisticWatcher

Watches one or more directories and classifies incoming change events as either **self-writes** (suppressed) or **external changes** (forwarded to `onExternalChange` and bumped into `txId`). Built on `ExpectedChanges` for path-level suppression, `ObservedState` for content-level dedup, and `fs.watch({ recursive: true })` by default.

**Three-layer suppression**

- **Layer 1 — synchronous suppress window.** Wrap a write in `suppress(fn)`. While `fn` is executing, every watcher event is silently dropped. The depth counter is always unwound in a `finally` block, so a throw inside `fn` leaves the watcher in a healthy state.
- **Layer 2 — pre-registered path.** Call `expect(path)` before triggering a write. If the watcher event arrives after the suppress window has closed (an async race on fast filesystems), `ExpectedChanges.consume` still catches and drops it. Both `expect()` and the default watcher key on the **resolved absolute path**, so passing a relative write path (the same one handed to `fs.writeFile`) matches correctly.
- **Layer 3 — content unchanged since last accounted for.** Some filesystems (observed on Windows) deliver more than one raw `fs.watch` event for a single logical write, so an external overwrite or a self-write can still reach `bump()` twice even after Layers 1 and 2. Layer 3 asks a question with no timing term: does this path's content actually differ from what was last recorded? A duplicate event over unchanged content is suppressed; a genuine change still bumps `txId`. It's backed by an `ObservedState` ledger — a fresh instance by default, or your own via the `observed` option — and Layers 1 and 2 feed it too (`record()` on every suppression), so a path they suppress is also sealed as accounted for. Pass `observed: null` to disable Layer 3 and restore pre-Layer-3 behavior (every non-suppressed event bumps `txId`). Layer 3 fails open: an evicted ledger entry, an unreadable file, or a throwing custom `Fingerprinter` all degrade toward an *extra* bump, never toward staleness. See [ADR-0002](docs/decisions/0002-observed-state-collapses-duplicate-watch-events.md) for why content hashing is the default and what was rejected instead.

**Cancelled-write idiom**

`suppress` does not call `bump()` automatically. If a write is cancelled before it reaches the filesystem, no watcher event will fire and `txId` will not advance. Call `bump()` explicitly so downstream consumers are still notified that state may have changed:

```ts
import { OptimisticWatcher, ExpectedChanges } from "@genvidtech/mcp-utils";

const expected = new ExpectedChanges();
const watcher = new OptimisticWatcher({
  watchDirs: ["/project/data"],
  expected,
  onExternalChange: (filePath) => invalidateCache(filePath),
});
watcher.start();

// Normal write: suppress window + pre-registered path cover both layers
async function writeFile(targetPath: string, content: string) {
  try {
    await watcher.suppress(async () => {
      watcher.expect(targetPath);          // Layer 2 pre-registration
      await validate(content);             // may throw before any write
      await fs.writeFile(targetPath, content);
    });
  } catch (err) {
    watcher.bump();  // cancelled write still invalidates caches
    throw err;
  }
}

// Later:
watcher.stop();
```

The `watcherFactory` option (type `WatcherFactory`) accepts an injectable factory that starts a watcher and returns a `WatchHandle`. The default wraps `fs.watch({ recursive: true })`. Override it in tests to drive events programmatically without touching the filesystem.

The `observed` option (type `ObservedState | null`) controls Layer 3: omit it and a default `ObservedState` is constructed for you (Layer 3 is **on by default**); pass an instance to reuse a shared or custom-fingerprinted ledger; pass `observed: null` to opt out of Layer 3 entirely.

### ObservedState

A per-path content-fingerprint ledger: tracks whether a file's content has changed since it was last accounted for. It's `OptimisticWatcher`'s Layer 3 suppression primitive (above), and is exported standalone for the same check-and-record pattern elsewhere.

```ts
import { ObservedState } from "@genvidtech/mcp-utils";

const observed = new ObservedState(); // maxEntries optional, default 1000

observed.isChanged("/path/to/file.json"); // true — never seen before; also records it
observed.isChanged("/path/to/file.json"); // false — content unchanged since the last check
// ...file is edited...
observed.isChanged("/path/to/file.json"); // true — content differs from what was recorded

observed.forget("/path/to/file.json"); // stop tracking; next isChanged() call reports true again
```

`isChanged(filePath)` is check-and-record: it fingerprints the current content, compares it against the stored value, stores the new fingerprint either way, and returns whether they differed — mirroring `ExpectedChanges.consume`'s check-and-remove shape. A path that has never been seen is treated as changed. `record(filePath)` stores the current fingerprint unconditionally with no comparison or return value — use it to seal a path as "accounted for" without caring whether it changed.

The ledger is bounded by `maxEntries` (default 1000) with LRU eviction, so a long-running watch over a large tree doesn't grow it unboundedly; an evicted path simply reports changed again on its next check.

The default `Fingerprinter` is the exported `contentFingerprint`: a sha1 hex digest of the file's bytes. A missing file (`ENOENT`) fingerprints as the literal string `"absent"` — a deletion is a real, detectable change. Any other read failure (e.g. `EACCES`) fingerprints as a unique per-failure token that can never compare equal to any other reading. Every failure mode fails open toward reporting an *extra* change rather than risking a missed one.

Supply your own `Fingerprinter` — `(filePath: string) => string` — via the constructor for a cheaper, less precise comparison:

```ts
import { statSync } from "node:fs";

const observed = new ObservedState({
  // Cheaper than hashing, but see the caveat below before adopting this one:
  // two distinct same-size writes landing in the same timestamp tick compare
  // equal, and a fingerprint collision means a real change is silently missed.
  fingerprint: (filePath) => {
    const { size, mtimeMs } = statSync(filePath);
    return `${size}:${mtimeMs}`;
  },
  maxEntries: 500,
});
```

There is no `stat`-based fingerprinter built in, and the snippet above is an illustration of the seam rather than a recommendation. A fingerprinter that returns equal values for genuinely different content makes the ledger suppress a real change — staleness, which is the one failure this primitive exists to prevent, and the reason hashing content is the default. See [ADR-0002](docs/decisions/0002-observed-state-collapses-duplicate-watch-events.md) for the measured collision rate that ruled it out as a shipped default.

### loadProjectConfig / isMcpError

Loads a single JSON config file from a project root, merges in defaults and overrides, validates it against a [zod](https://zod.dev) schema you supply, and optionally asserts that nominated path fields stay within the project root. The schema and its DTO stay in the **consuming** package — this utility owns only the load + validate + contain mechanism. `zod` is a peer dependency; only `import type { ZodType }` is used here (the schema's `.parse()` runs on the object you pass in), so no second zod copy is pulled into your tree.

It does **not throw** on failure: a missing required file, JSON parse error, schema violation, or path escape all return an `mcpError` `CallToolResult` (with `isError: true`). On success it returns the validated config `T`. Use the `isMcpError` type guard to narrow the `T | CallToolResult` union — in an MCP tool handler you can propagate the error result straight through:

```ts
import { z } from "zod";
import { loadProjectConfig, isMcpError } from "@genvidtech/mcp-utils";

const ConfigSchema = z.object({
  extractedDir: z.string().default("build"),
  port: z.number().default(3000),
});

const cfg = await loadProjectConfig(
  projectRoot,
  "my-tool.config.json",
  ConfigSchema,
  { port: requestArgs.port },        // overrides (highest precedence)
  {
    defaults: { extractedDir: "dist" },
    containedPaths: ["extractedDir"], // must resolve within projectRoot
    optional: true,                   // missing file → use defaults, don't error
  },
);

if (isMcpError(cfg)) return cfg; // propagate parse/validation/containment failure
// cfg is now the validated config (typed as z.infer<typeof ConfigSchema>)
console.log(cfg.extractedDir, cfg.port);
```

**Merge precedence (highest → lowest):** `overrides` > file contents > `opts.defaults` > schema `.default()`. All layers are shallow-merged at the top level — nested objects are not deep-merged.

**LoadConfigOpts**

| Field | Type | Description |
|---|---|---|
| `containedPaths` | `(keyof T)[]` | Keys whose string values must resolve within `projectRoot` (via `resolveWithin`). Assertion-only — the value is returned as authored, not rewritten to an absolute path. Non-string values are skipped. |
| `optional` | `boolean` | When `true`, a missing file (ENOENT) skips the file layer instead of erroring; defaults and schema `.default()` still apply. |
| `defaults` | `Partial<T>` | Lowest-precedence values, merged under the file contents and `overrides`. |

All error messages are prefixed with `loadProjectConfig(<fileName>):` for unambiguous failure attribution. Schema validation failures append each zod issue (`<path>: <message>`) to the error text.

## Requirements

Node.js >= 22.
