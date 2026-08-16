import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./types.js";
import { ExpectedChanges } from "./expectedChanges.js";
import { ObservedState } from "./observedState.js";
import { toPosixPath } from "./strings.js";

/** A handle returned by a watcher factory that can be closed to stop watching. */
export interface WatchHandle {
  close(): void;
}

/**
 * A factory function that begins watching a directory and returns a handle.
 *
 * @param dir     - Absolute path of the directory to watch.
 * @param onEvent - Callback invoked with a normalized absolute POSIX path
 *                  whenever the watcher detects a change.
 * @returns A WatchHandle whose `close()` method stops watching.
 */
export type WatcherFactory = (
  dir: string,
  onEvent: (filename: string) => void,
) => WatchHandle;

/** Options for {@link OptimisticWatcher}. */
export interface OptimisticWatcherOptions {
  /** Directories to watch (each gets its own watcher handle). */
  watchDirs: string[];
  /**
   * Shared ExpectedChanges registry. Call {@link OptimisticWatcher.expect} (or
   * `expected.add`) before performing a self-write so the corresponding watcher
   * event is suppressed.
   */
  expected: ExpectedChanges;
  /**
   * Called when a change event is classified as external (not self-written).
   * Receives the normalized absolute POSIX path of the changed file.
   */
  onExternalChange?: (filePath: string) => void;
  /**
   * Override the default `fs.watch`-based watcher. Useful in tests.
   * The factory must call `onEvent` with a normalized absolute POSIX path.
   * Defaults to a thin wrapper around `fs.watch({ recursive: true })`.
   */
  watcherFactory?: WatcherFactory;
  /** Optional logger for diagnostic messages. */
  logger?: Logger;
  /**
   * Content-fingerprint ledger used for Layer 3 suppression: a duplicate
   * event for a path whose content hasn't actually changed since it was
   * last accounted for is suppressed instead of bumping `txId` again.
   *
   * - `undefined` (default, i.e. omitted) — a fresh `new ObservedState()`
   *   is constructed automatically, so Layer 3 is **on by default**.
   * - `null` — Layer 3 is disabled (opt out), restoring the pre-Layer-3
   *   behavior of bumping on every non-suppressed event.
   * - An explicit `ObservedState` instance — reuse a shared/pre-configured
   *   ledger (e.g. one with a custom fingerprinter, for tests).
   */
  observed?: ObservedState | null;
}

/**
 * Watches one or more directories and classifies incoming change events as
 * either **self-writes** (suppressed) or **external changes** (forwarded to
 * `onExternalChange` + bumps `txId`).
 *
 * ## Three-layer suppression
 *
 * **Layer 1 — synchronous suppress window.**
 * Wrap a write operation in `suppress(fn)`. While `fn` is executing,
 * `suppressDepth > 0` and every watcher event is silently dropped. The depth
 * counter is always unwound in a `finally` block, so a throw inside `fn` does
 * NOT leave the watcher permanently suppressed.
 *
 * **Layer 2 — pre-registered path (async race).**
 * Call `expect(path)` before triggering a write. If the watcher event arrives
 * *after* the suppress window has closed (an async race that can happen on
 * fast filesystems), the pre-registration still catches and drops it. Both
 * `expect()` and the default watcher factory key on the **resolved absolute
 * POSIX path**, so a relative or non-canonical write path matches correctly.
 *
 * **Layer 3 — content unchanged since last accounted for.**
 * Some filesystems (observed on Windows) deliver more than one raw event for
 * a single logical write. Layers 1 and 2 already suppress the *self-write*
 * duplicates they see and — critically — also `record()` that path's content
 * fingerprint into the shared `ObservedState` ledger, sealing it as
 * "accounted for". If a further duplicate for the same path still reaches
 * Layer 3 (e.g. arriving after the suppress window closed and after Layer 2
 * already consumed the single expected-path registration), Layer 3 asks a
 * question with no timing term at all: does this path's *content* differ
 * from what was last accounted for? A duplicate event for unchanged content
 * answers no and is suppressed; a genuinely distinct write answers yes and
 * still bumps `txId`. Because the question carries no timing term, it is
 * robust to a duplicate arriving arbitrarily later — unlike a debounce or
 * dedup window, it cannot be defeated by widening the gap between events.
 *
 * Layer 3 fails open: an LRU eviction from a full ledger, a fingerprinter
 * that throws, a hash taken mid-write, and an unreadable file all degrade
 * toward reporting an *extra* bump — never toward suppressing a real change
 * and going stale.
 *
 * That guarantee is a property of the *fingerprinter*, not of this layer. A
 * fingerprinter that returns equal values for genuinely different content
 * makes Layer 3 suppress a real change, which is staleness — the one failure
 * this design does not tolerate. It is why the default hashes content rather
 * than using a cheaper `size`+`mtime` stat, which was measured colliding on
 * distinct same-size writes landing within the same filesystem timestamp
 * tick (see ADR-0002). A custom `Fingerprinter` inherits that
 * responsibility.
 *
 * Pass `observed: null` to disable Layer 3 entirely and restore pre-Layer-3
 * behavior (every non-suppressed event bumps `txId`).
 *
 * ## Cancelled-write idiom (caller's responsibility)
 *
 * If a write operation is cancelled before it reaches the filesystem (e.g., a
 * validation error inside `suppress`), the watcher will never see an event for
 * that path. The Layer 2 entry registered via `expect()` will eventually expire
 * (TTL on `ExpectedChanges`), but `txId` will NOT be bumped automatically.
 * To signal downstream consumers that the write attempt happened (and failed),
 * call `bump()` explicitly before or after the throw:
 *
 * ```ts
 * try {
 *   await watcher.suppress(async () => {
 *     watcher.expect(targetPath);
 *     await validate();           // may throw
 *     await fs.writeFile(...);    // the actual write
 *   });
 * } catch (err) {
 *   watcher.bump();               // cancelled write still invalidates caches
 *   throw err;
 * }
 * ```
 */
export class OptimisticWatcher {
  private readonly watchDirs: string[];
  private readonly expected: ExpectedChanges;
  private readonly onExternalChange?: (filePath: string) => void;
  private readonly watcherFactory: WatcherFactory;
  private readonly logger?: Logger;
  private readonly observed: ObservedState | null;

  private _txId = 0;
  private suppressDepth = 0;
  private handles: WatchHandle[] = [];

  constructor(options: OptimisticWatcherOptions) {
    this.watchDirs = options.watchDirs;
    this.expected = options.expected;
    this.onExternalChange = options.onExternalChange;
    this.logger = options.logger;
    this.observed =
      options.observed === undefined ? new ObservedState() : options.observed;
    this.watcherFactory =
      options.watcherFactory ??
      ((dir, onEvent) => {
        const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (filename == null) return;
          // Resolve (not just join) so the fired path is canonical absolute
          // POSIX — the exact form `expect()` stores, so Layer-2 matches.
          onEvent(toPosixPath(path.resolve(dir, filename.toString())));
        });
        return { close: () => w.close() };
      });
  }

  /** Monotonically-increasing transaction counter. Bumped on every external change. */
  get txId(): number {
    return this._txId;
  }

  /**
   * Increment `txId` by 1.
   *
   * Call this explicitly when a write is cancelled (see class-level JSDoc for
   * the cancelled-write idiom).
   */
  bump(): void {
    this._txId++;
  }

  /**
   * Register `filePath` with the shared `ExpectedChanges` registry so that
   * the next watcher event for that path is suppressed (Layer 2).
   *
   * `filePath` is resolved to a canonical absolute path before registration
   * (`path.resolve`) so it matches the absolute POSIX path the default watcher
   * factory fires — callers may therefore pass a relative or non-canonical
   * write path (e.g. the same path handed to `fs.writeFile`) and Layer-2
   * suppression still matches.
   */
  expect(filePath: string): void {
    this.expected.add(path.resolve(filePath));
  }

  /**
   * Execute `fn` inside a suppress window (Layer 1).
   *
   * While `fn` is running, any watcher event is silently dropped regardless of
   * whether its path is in `ExpectedChanges`. The depth counter is always
   * decremented in a `finally` block — a throw inside `fn` propagates normally
   * and leaves the watcher in a healthy state.
   *
   * `suppress` does NOT call `bump()` automatically. If you need downstream
   * consumers to notice a cancelled write, call `bump()` yourself (see
   * cancelled-write idiom in the class-level JSDoc).
   *
   * @param fn - Async work to run inside the suppress window.
   * @returns The value resolved by `fn`.
   */
  async suppress<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth++;
    try {
      return await fn();
    } finally {
      this.suppressDepth--;
    }
  }

  /**
   * Start watching all configured directories.
   *
   * Idempotent: a second call while already started is a no-op.
   */
  start(): void {
    if (this.handles.length > 0) return;
    for (const dir of this.watchDirs) {
      const handle = this.watcherFactory(dir, (filename) =>
        this.handleEvent(filename),
      );
      this.handles.push(handle);
    }
    this.logger?.("OptimisticWatcher started, watching dirs:", this.watchDirs);
  }

  /**
   * Stop watching all directories and close every handle.
   *
   * @remarks Calling `stop()` while an active `suppress` is running is unsafe:
   * the handles stop emitting, so no new events will arrive, but any in-flight
   * async work inside the suppress window is the caller's concern.
   */
  stop(): void {
    for (const h of this.handles) {
      h.close();
    }
    this.handles = [];
    this.logger?.("OptimisticWatcher stopped.");
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleEvent(filename: string): void {
    // Layer 1: synchronous suppress window
    if (this.suppressDepth > 0) {
      this.observed?.record(filename);
      this.logger?.("suppressed (L1):", filename);
      return;
    }

    // Layer 2: pre-registered expected path
    if (this.expected.consume(filename)) {
      this.observed?.record(filename);
      this.logger?.("suppressed (L2):", filename);
      return;
    }

    // Layer 3: content unchanged since last accounted for.
    // A throwing fingerprinter is treated as "changed" (fail open) so a
    // broken/misbehaving fingerprinter degrades toward an extra bump,
    // never toward silently suppressing a real external change.
    if (this.observed) {
      let changed: boolean;
      try {
        changed = this.observed.isChanged(filename);
      } catch (err) {
        this.logger?.("L3 fingerprint threw, treating as changed:", filename, err);
        changed = true;
      }
      if (!changed) {
        this.logger?.("suppressed (L3, state unchanged):", filename);
        return;
      }
    }

    // External change
    this.logger?.("external change:", filename);
    this.bump();
    this.onExternalChange?.(filename);
  }
}
