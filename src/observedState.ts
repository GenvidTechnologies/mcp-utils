import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { toPosixPath } from "./strings.js";

export type Fingerprinter = (filePath: string) => string;

const DEFAULT_MAX_ENTRIES = 1000;

let errorTokenCounter = 0;

/**
 * Fingerprints a file's contents as a sha1 hex digest of its bytes.
 *
 * Error handling is deliberately asymmetric:
 * - A missing file (`ENOENT`) returns the literal string `"absent"` — a
 *   deletion is a real, detectable state change and must not be swallowed.
 * - Any other read failure (permission denied, `EISDIR`, etc.) returns a
 *   unique token, generated from a monotonic counter, that can never
 *   compare equal to a previously (or subsequently) recorded fingerprint.
 *
 * Every failure mode this function can hit therefore degrades toward
 * reporting an *extra* change, never toward masking a real one — callers
 * built on this fingerprinter (see `ObservedState`) fail open, not closed.
 */
export const contentFingerprint: Fingerprinter = (filePath) => {
  try {
    const buf = readFileSync(filePath);
    return createHash("sha1").update(buf).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "absent";
    }
    return `error:${errorTokenCounter++}`;
  }
};

/**
 * Tracks a per-path content-fingerprint ledger: "has this path's content
 * changed since it was last accounted for". Used to collapse redundant
 * filesystem events (e.g. a touch that doesn't alter bytes, or several
 * events for one edit) into a single real change.
 *
 * `isChanged` mirrors `ExpectedChanges.consume`'s check-and-remove shape:
 * one call fingerprints the current content, compares it against the
 * stored value, stores the new value, and reports whether it differed —
 * check and record happen atomically from the caller's perspective. A
 * path that has never been seen before is treated as changed.
 *
 * The ledger is bounded by `maxEntries` with LRU eviction, so a
 * long-lived recursive watch can't grow it unboundedly. An evicted path
 * simply reports changed again on its next event — the same fail-open
 * direction as `contentFingerprint`'s error handling.
 */
export class ObservedState {
  private entries = new Map<string, string>(); // normalized path → fingerprint
  private readonly fingerprint: Fingerprinter;
  private readonly maxEntries: number;

  constructor(opts?: { fingerprint?: Fingerprinter; maxEntries?: number }) {
    this.fingerprint = opts?.fingerprint ?? contentFingerprint;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private static normalize(p: string): string {
    return toPosixPath(p);
  }

  /** Insert/refresh `key` as the most-recently-used entry, evicting the oldest if over capacity. */
  private touch(key: string, value: string): void {
    // Map iteration order is insertion order; delete+set moves key to the end (MRU).
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Fingerprint `filePath` now and store it, unconditionally — "this state is accounted for". */
  record(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    this.touch(key, this.fingerprint(filePath));
  }

  /**
   * Check-and-record: fingerprints `filePath`, compares it against the
   * stored value, stores the new value, and returns whether it differed.
   */
  isChanged(filePath: string): boolean {
    const key = ObservedState.normalize(filePath);
    const prev = this.entries.get(key);
    const next = this.fingerprint(filePath);
    this.touch(key, next);
    return prev === undefined || prev !== next;
  }

  /** Remove a tracked path. */
  forget(filePath: string): void {
    this.entries.delete(ObservedState.normalize(filePath));
  }

  /** Number of currently tracked entries (for testing). */
  get size(): number {
    return this.entries.size;
  }
}
