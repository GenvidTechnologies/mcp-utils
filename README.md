# genvid-mcp-utils

Shared utilities for building MCP servers: concurrency control, file-change tracking, and text pagination.

## Installation

This is a private package consumed within the monorepo. Import directly:

```ts
import { ReadWriteLock, ExpectedChanges, paginateText } from "genvid-mcp-utils";
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
import { paginateText } from "genvid-mcp-utils";

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
| `totalLines` | `number` | Total line count of the input |
| `offset` | `number` | Actual offset used |
| `limit` | `number` | Actual limit used |
| `hasMore` | `boolean` | True if lines remain after this page |

### Logger type

A minimal logger interface used by MCP server utilities:

```ts
import type { Logger } from "genvid-mcp-utils";

function setup(log: Logger) {
  log("server started");
}
```

## Requirements

Node.js >= 22.
