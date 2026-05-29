import { toPosixPath } from "./strings.js";

/**
 * Tracks file paths that MCP write tools are about to modify, so the
 * file watcher can suppress the self-triggered change event.
 *
 * Entries auto-expire after a configurable timeout to prevent stale
 * suppression if a write fails or the watcher event is delayed.
 */
export class ExpectedChanges {
  private entries = new Map<string, number>(); // normalized path → timestamp
  private readonly ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  private static normalize(p: string): string {
    return toPosixPath(p);
  }

  /** Register a path before writing. */
  add(filePath: string): void {
    this.entries.set(ExpectedChanges.normalize(filePath), Date.now());
  }

  /** Remove a registered path (e.g., in a finally block after write). */
  remove(filePath: string): void {
    this.entries.delete(ExpectedChanges.normalize(filePath));
  }

  /**
   * Check whether a watcher event should be suppressed.
   * Returns true (and removes the entry) if the path was expected
   * and has not expired.
   */
  consume(filePath: string): boolean {
    const key = ExpectedChanges.normalize(filePath);
    const ts = this.entries.get(key);
    if (ts === undefined) return false;
    this.entries.delete(key);
    return Date.now() - ts < this.ttlMs;
  }

  /** Remove all expired entries. Call periodically or before reads. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Number of currently tracked entries (for testing). */
  get size(): number {
    return this.entries.size;
  }
}
