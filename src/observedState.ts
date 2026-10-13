import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { toPosixPath } from "./strings.js";

export type Fingerprinter = (filePath: string) => string;

/**
 * Result of `ObservedState.prime`. `files` and `directories` count the
 * entries the call added to the ledger (existing entries are not counted;
 * the root itself is not counted). `complete: false` means the ledger can no
 * longer vouch for the primed tree — a read failed or an entry holding a real
 * fingerprint was evicted; size `maxEntries` to at least files plus
 * directories.
 */
export type PrimeSummary = { files: number; directories: number; complete: boolean };

const DEFAULT_MAX_ENTRIES = 1000;

type Entry = { kind: "file"; fp: string } | { kind: "dir"; link: boolean };

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
  private entries = new Map<string, Entry>(); // normalized path → ledger entry
  private readonly fingerprint: Fingerprinter;
  private readonly maxEntries: number;
  private lossy = false; // set once an entry holding real content was lost; never clears
  private primedRoots: string[] = []; // normalized roots passed to prime()

  constructor(opts?: { fingerprint?: Fingerprinter; maxEntries?: number }) {
    this.fingerprint = opts?.fingerprint ?? contentFingerprint;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private static normalize(p: string): string {
    return toPosixPath(p);
  }

  /** Insert/refresh `key` as the most-recently-used entry, evicting the oldest if over capacity. */
  private touch(key: string, value: Entry): void {
    // Map iteration order is insertion order; delete+set moves key to the end (MRU).
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.entries.get(oldest);
        if (evicted?.kind === "file" && evicted.fp !== "absent") this.lossy = true;
        this.entries.delete(oldest);
      }
    }
  }

  /** Classify `p` without following a link first; any error fails open to "file". */
  private classify(p: string): "dir" | "dirlink" | "file" {
    try {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) return "file";
      if (st.isDirectory()) return "dir";
      if (st.isSymbolicLink() && statSync(p).isDirectory()) return "dirlink";
      return "file";
    } catch {
      return "file";
    }
  }

  /** True when `p` is a primed root or lies beneath one. Consumed by later vouching logic. */
  private isUnderPrimedRoot(p: string): boolean {
    const key = ObservedState.normalize(p);
    return this.primedRoots.some((r) => key === r || key.startsWith(r + "/"));
  }

  /**
   * Walks `roots` recursively and records a baseline: directories (and links
   * to directories, which are not descended into) as markers, files as
   * fingerprints. Fills gaps only — a key that already has an entry is never
   * overwritten. Never throws: a directory that cannot be read, or a
   * fingerprinter that throws, marks the ledger incomplete and the walk
   * continues. A missing root counts as empty. The roots themselves get no
   * marker. `complete: false` means the ledger can no longer vouch; size
   * `maxEntries` to at least files plus directories.
   */
  prime(roots: string[]): PrimeSummary {
    const summary: PrimeSummary = { files: 0, directories: 0, complete: true };
    for (const root of roots) {
      let key = ObservedState.normalize(root);
      while (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
      if (!this.primedRoots.includes(key)) this.primedRoots.push(key);
      this.walk(root, summary);
    }
    summary.complete = !this.lossy;
    return summary;
  }

  private walk(dir: string, summary: PrimeSummary): void {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.lossy = true;
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const key = ObservedState.normalize(full);
      try {
        const kind = this.classify(full);
        const exists = this.entries.has(key);
        if (kind === "file") {
          if (exists) continue;
          this.touch(key, { kind: "file", fp: this.fingerprint(full) });
          summary.files++;
        } else {
          if (!exists) {
            this.touch(key, { kind: "dir", link: kind === "dirlink" });
            summary.directories++;
          }
          if (kind === "dir") this.walk(full, summary);
        }
      } catch {
        this.lossy = true;
      }
    }
  }

  /** Fingerprint `filePath` now and store it, unconditionally — "this state is accounted for". */
  record(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    this.touch(key, { kind: "file", fp: this.fingerprint(filePath) });
  }

  /**
   * Check-and-record: fingerprints `filePath`, compares it against the
   * stored value, stores the new value, and returns whether it differed.
   */
  isChanged(filePath: string): boolean {
    const key = ObservedState.normalize(filePath);
    const prev = this.entries.get(key);
    const next: Entry = { kind: "file", fp: this.fingerprint(filePath) };
    this.touch(key, next);
    // A stored dir marker has no comparable fingerprint: treat it like never-seen.
    return prev === undefined || prev.kind !== "file" || prev.fp !== next.fp;
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
