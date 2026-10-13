import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { toPosixPath } from "./strings.js";
import { walkFiles } from "./walkFiles.js";

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

const isLiveFile = (e: Entry | undefined): boolean => e?.kind === "file" && e.fp !== "absent";

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
 *
 * Called directly on a directory it still returns a unique token (`EISDIR`).
 * `ObservedState` does not pass it a directory it classified as one; if
 * classification itself fails (`lstat` throws) the path is treated as a file
 * and reaches the fingerprinter, which fails open.
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
 * Directories (and links to directories) are stored as markers and do not
 * reach the fingerprinter (unless `lstat` itself fails, in which case the
 * path is classified as a file and the fingerprinter fails open).
 * `isChanged` on a path that is now a directory:
 * a known marker is unchanged (a dir/link flip is changed); a live file
 * replaced by a directory is changed; a never-seen directory is changed
 * unless it lies under a `prime`d root, the ledger is not lossy and it is
 * not a link, in which case every file beneath it is evaluated and the
 * directory is changed only if one of them is. On a path that is now a file
 * or missing, whose stored entry is not a live file (a directory marker, an
 * `"absent"` entry, or nothing), all entries beneath it are dropped so a
 * directory later moved back in is re-evaluated rather than matched against
 * orphaned children; the path is changed if it is now a file, a dropped entry
 * was a live file, the ledger is lossy, or the marker was a link. `record`
 * and `forget` drop the same descendants.
 *
 * The ledger is bounded by `maxEntries` with LRU eviction, so a
 * long-lived recursive watch can't grow it unboundedly. An evicted file
 * reports changed again on its next event — the same fail-open direction as
 * `contentFingerprint`'s error handling. An evicted directory marker is not
 * itself a loss: the next event on a still-present directory is decided by the
 * vouched scan (when under a `prime`d root, not lossy and not a link) or
 * reports changed. Evicting a marker leaves its children until the directory's
 * next move-out event drops them.
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

  /**
   * True when `p` is a primed root or lies beneath one. Used to decide whether the ledger vouches for a directory.
   * A primed root of `/` builds the prefix `//` and never matches, so it fails open (never vouches).
   */
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

  /**
   * Record `filePath` now, unconditionally — "this state is accounted for".
   * A directory (or link to one) is stored as a marker; the fingerprinter is
   * only called for files.
   */
  record(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    const kind = this.classify(filePath);
    if (kind === "file") {
      // Same orphan rule as isChanged: a directory that became a file or went
      // missing takes its descendants with it (silently — this is "accounted for").
      if (!isLiveFile(this.entries.get(key))) this.dropBeneath(key);
      this.touch(key, { kind: "file", fp: this.fingerprint(filePath) });
    } else {
      this.touch(key, { kind: "dir", link: kind === "dirlink" });
    }
  }

  /**
   * Check-and-record: compares `filePath`'s current state against the stored
   * entry, stores the new state, and returns whether it differed. See the
   * class doc for the directory rules.
   */
  isChanged(filePath: string): boolean {
    const key = ObservedState.normalize(filePath);
    const prev = this.entries.get(key);
    const kind = this.classify(filePath);

    if (kind !== "file") {
      const link = kind === "dirlink";
      if (prev?.kind === "dir") {
        // A dir replaced by a link (or vice versa) is a real change; otherwise unchanged.
        this.touch(key, { kind: "dir", link });
        return prev.link !== link;
      }
      if (prev?.kind === "file" && prev.fp !== "absent") {
        this.touch(key, { kind: "dir", link });
        return true; // live file replaced by a directory
      }
      // Never seen (or recorded absent): scan only if the ledger can vouch for it.
      const vouched = !link && !this.lossy && this.isUnderPrimedRoot(filePath);
      let changed = true;
      if (vouched) {
        let files: string[] | undefined;
        try {
          files = walkFiles(filePath, () => true);
        } catch {
          files = undefined;
        }
        if (files !== undefined) {
          changed = false;
          // Evaluate every file (no short-circuit) so each one is recorded.
          for (const f of files) if (this.isChanged(f)) changed = true;
        }
      }
      this.touch(key, { kind: "dir", link });
      return changed;
    }

    const next = this.fingerprint(filePath);
    // Descendants are orphans unless the stored entry is a live file (the
    // O(1) ordinary-modify path). A directory marker may have been evicted or
    // forgotten while its children survived, so prev === undefined drops too.
    const droppedLive = isLiveFile(prev) ? false : this.dropBeneath(key);
    if (prev?.kind === "dir") {
      this.touch(key, { kind: "file", fp: next });
      // "absent" distinguishes a missing path from one that is now a file.
      return next !== "absent" || droppedLive || this.lossy || prev.link;
    }
    this.touch(key, { kind: "file", fp: next });
    return prev === undefined || prev.fp !== next || droppedLive;
  }

  /** Remove a tracked path and every entry beneath it. */
  forget(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    this.entries.delete(key);
    this.dropBeneath(key);
  }

  /**
   * Delete every entry whose key lies beneath `key` (trailing-slash
   * normalized). Returns whether a live file (a real fingerprint) was dropped.
   * Deleting the current key while iterating a Map is safe.
   */
  private dropBeneath(key: string): boolean {
    const prefix = key.replace(/\/+$/, "") + "/";
    let droppedLive = false;
    for (const k of this.entries.keys()) {
      if (!k.startsWith(prefix)) continue;
      if (isLiveFile(this.entries.get(k))) droppedLive = true;
      this.entries.delete(k);
    }
    return droppedLive;
  }

  /** Number of currently tracked entries (for testing). */
  get size(): number {
    return this.entries.size;
  }
}
