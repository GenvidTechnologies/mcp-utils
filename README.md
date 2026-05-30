# @genvid/mcp-utils

Shared utilities for building MCP servers: concurrency control, file-change tracking, text pagination, path and filesystem helpers, MCP response and error helpers, tool annotations, and optimistic file watching.

## Installation

```sh
npm install @genvid/mcp-utils
```

```ts
import {
  ReadWriteLock, ExpectedChanges, paginateText,
  walkFiles, resolveWithin, escapeRegExp, toPosixPath,
  mcpError, withMcpErrors, bufferingLogger, paginatedContent,
  READ_ONLY, REGENERATE, MUTATE, NON_IDEMPOTENT_READ,
  OptimisticWatcher,
} from "@genvid/mcp-utils";
```

## Utilities

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
import { paginateText } from "@genvid/mcp-utils";

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
import type { Logger } from "@genvid/mcp-utils";

function setup(log: Logger) {
  log("server started");
}
```

### walkFiles

Recursively walks a directory and returns the absolute paths of all files whose path satisfies `match`. If the directory does not exist the function returns `[]` without throwing; other I/O errors (e.g. `EACCES`) are re-thrown. Symlinked directories are not followed — only entries for which `entry.isDirectory()` returns `true` are recursed into.

```ts
import { walkFiles } from "@genvid/mcp-utils";

// String match: suffix / endsWith test
const jsonFiles = walkFiles("/project/data", ".json");

// Predicate match: arbitrary filter
const testFiles = walkFiles("/project/src", (p) => p.includes(".test."));
```

### escapeRegExp / toPosixPath

Two lightweight string helpers.

`escapeRegExp` escapes all regex metacharacters in a string so it can be used as a literal pattern inside `new RegExp(...)`.

`toPosixPath` converts all backslashes to forward slashes, producing a POSIX-style path. No-ops on paths that already use forward slashes.

```ts
import { escapeRegExp, toPosixPath } from "@genvid/mcp-utils";

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
import { resolveWithin } from "@genvid/mcp-utils";

resolveWithin("/project", "src/index.ts"); // "/project/src/index.ts"
resolveWithin("/project", "../secret");    // null  — escapes base
resolveWithin("/project", "");             // "/project"
```

### mcpError / withMcpErrors

Helpers that turn thrown errors into `CallToolResult` responses with `isError: true`, so MCP tool handlers can report failures without letting exceptions propagate to the transport layer.

`mcpError(e, extraLines?)` converts a caught value into a `CallToolResult`. `Error` instances use `.message`; everything else is converted with `String(e)`. The optional `extraLines` array is appended to the message and evaluated eagerly at call time.

`withMcpErrors(fn, extraLines?)` wraps an async handler so any thrown error is caught and returned as `mcpError(...)`. The `extraLines` argument here is a **thunk** `() => string[]` that is called only at catch time — useful for reading mutable state (e.g. a log buffer or transaction counter) that may have changed between the call and the throw.

```ts
import { mcpError, withMcpErrors, bufferingLogger } from "@genvid/mcp-utils";

// Direct conversion of a caught error
try {
  await doWork();
} catch (err) {
  return mcpError(err, ["context: file write failed"]);
}

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
```

### bufferingLogger

Creates a logger that captures all log calls in memory instead of writing to stdout. Returns `{ log, text }` where `log` is a `Logger` that buffers each call as a line (multiple arguments joined by a single space via `String()` coercion), and `text()` returns the accumulated lines joined by `"\n"`.

```ts
import { bufferingLogger } from "@genvid/mcp-utils";

const { log, text } = bufferingLogger();
log("processed", 3, "files");
log("done");
text(); // "processed 3 files\ndone"
```

### paginatedContent

Wraps `paginateText` and returns a `CallToolResult` whose single text block combines the page text and a `lines: A-B / total` range footer, joined with a blank line (`"\n\n"`). The range footer is emitted **only when `offset` or `limit` was supplied** (matching the consumer's `paginatedResponse`); an un-paginated call returns the whole text with no footer. An out-of-range page reports `lines: 0 / total` (no misleading range, no leading blank lines). An optional `footer(r)` callback receives the full `PaginatedResult` and its return value is appended on a new line; the callback always runs.

```ts
import { paginatedContent } from "@genvid/mcp-utils";

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

### Tool annotation presets

Four `ToolAnnotations` constants for use when registering MCP tools. Each preset sets `readOnlyHint`, `destructiveHint`, and `idempotentHint` to reflect the tool's expected behavior.

```ts
import { READ_ONLY, REGENERATE, MUTATE, NON_IDEMPOTENT_READ } from "@genvid/mcp-utils";

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

### OptimisticWatcher

Watches one or more directories and classifies incoming change events as either **self-writes** (suppressed) or **external changes** (forwarded to `onExternalChange` and bumped into `txId`). Built on `ExpectedChanges` for path-level suppression and `fs.watch({ recursive: true })` by default.

**Two-layer suppression**

- **Layer 1 — synchronous suppress window.** Wrap a write in `suppress(fn)`. While `fn` is executing, every watcher event is silently dropped. The depth counter is always unwound in a `finally` block, so a throw inside `fn` leaves the watcher in a healthy state.
- **Layer 2 — pre-registered path.** Call `expect(path)` before triggering a write. If the watcher event arrives after the suppress window has closed (an async race on fast filesystems), `ExpectedChanges.consume` still catches and drops it. Both `expect()` and the default watcher key on the **resolved absolute path**, so passing a relative write path (the same one handed to `fs.writeFile`) matches correctly.

**Cancelled-write idiom**

`suppress` does not call `bump()` automatically. If a write is cancelled before it reaches the filesystem, no watcher event will fire and `txId` will not advance. Call `bump()` explicitly so downstream consumers are still notified that state may have changed:

```ts
import { OptimisticWatcher, ExpectedChanges } from "@genvid/mcp-utils";

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

## Requirements

Node.js >= 22.
