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

/**
 * A directory marker carries the directory's identity (`id`, the `lstat` inode
 * as a decimal string; "" when unknown, which never matches) so a directory
 * swapped in by rename is told apart from the one that was recorded, and a
 * `scanned` flag: true when every file beneath it is known to be in the ledger
 * (stored by `prime` or by a vouched scan), false when the marker was recorded
 * without its children.
 */
type Entry =
  | { kind: "file"; fp: string }
  | { kind: "dir"; link: boolean; id: string; scanned: boolean };

type Kind = "dir" | "dirlink" | "file";

/** Key of the parent node: "" for a top-level key (and for "/"), "/" for "/x". */
const parentOf = (key: string): string => {
  if (key === "/") return "";
  const i = key.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : key.slice(0, i);
};

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
 * a marker with the same identity (`lstat` inode; unknown identity never
 * matches) is unchanged, while a different directory swapped in at the path or
 * a dir/link flip replaces it: the old subtree is dropped (changed if a live
 * file was) and the new one is evaluated like a never-seen directory. A marker
 * is `scanned` when its children are known to be recorded (`prime`, a vouched
 * scan, or an empty directory at `record` time); a directory that later
 * vanishes or becomes a file while unscanned is changed, since dropping no
 * live entries proves nothing. Descendants are found through a parent→children
 * index, so a drop costs the subtree, not the ledger. A live file
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
  // Parent key → child keys, so dropBeneath walks the subtree, not the ledger.
  // A node is linked into its parent's set while it has an entry OR a non-empty
  // set of its own, so descendants stay reachable when an ancestor's entry was
  // evicted. Only put() and remove() (and dropBeneath) mutate it.
  private children = new Map<string, Set<string>>();
  private readonly fingerprint: Fingerprinter;
  private readonly maxEntries: number;
  private lossy = false; // set once an entry holding real content was lost; never clears
  private primedRoots: string[] = []; // normalized roots passed to prime()

  constructor(opts?: { fingerprint?: Fingerprinter; maxEntries?: number }) {
    this.fingerprint = opts?.fingerprint ?? contentFingerprint;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private static normalize(p: string): string {
    // Trailing slashes are not part of identity ("D/" and "D" are one key); a
    // bare root ("/") and a drive root ("C:/") keep theirs.
    const k = toPosixPath(p);
    let end = k.length;
    while (end > 1 && k[end - 1] === "/" && !(end === 3 && k[1] === ":")) end--;
    return k.slice(0, end);
  }

  /** Insert/refresh `key` as the most-recently-used entry, evicting the oldest if over capacity. */
  private touch(key: string, value: Entry): void {
    // Map iteration order is insertion order; delete+set moves key to the end (MRU).
    const had = this.entries.has(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    if (!had) this.link(key);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.entries.get(oldest);
        if (evicted?.kind === "file" && evicted.fp !== "absent") this.lossy = true;
        this.remove(oldest);
      }
    }
  }

  /** Delete `key`'s entry and keep the parent index in step. */
  private remove(key: string): void {
    this.entries.delete(key);
    this.unlinkIfEmpty(key);
  }

  /** Link `key` into its parent's set, linking any unlinked ancestors on the way up. */
  private link(key: string): void {
    for (;;) {
      const p = parentOf(key);
      const set = this.children.get(p);
      if (set) {
        set.add(key);
        return;
      }
      this.children.set(p, new Set([key]));
      if (p === "") return;
      key = p;
    }
  }

  /** Unlink `key` (and then empty ancestors) when it has neither an entry nor children. */
  private unlinkIfEmpty(key: string): void {
    while (!this.entries.has(key) && !this.children.has(key)) {
      const p = parentOf(key);
      const set = this.children.get(p);
      if (!set) return;
      set.delete(key);
      if (set.size > 0) return;
      this.children.delete(p);
      if (p === "") return;
      key = p;
    }
  }

  /** Classify `p` without following a link first; any error fails open to "file". `id` is "" when unknown. */
  private classify(p: string): { kind: Kind; id: string } {
    try {
      const st = lstatSync(p, { bigint: true, throwIfNoEntry: false });
      if (!st) return { kind: "file", id: "" };
      const id = st.ino === 0n ? "" : st.ino.toString();
      if (st.isDirectory()) return { kind: "dir", id };
      if (st.isSymbolicLink() && statSync(p).isDirectory()) return { kind: "dirlink", id };
      return { kind: "file", id: "" };
    } catch {
      return { kind: "file", id: "" };
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
   * fingerprints. Fills gaps only — an entry of the same kind (and, for a
   * directory, the same identity) is never overwritten; one whose kind or
   * identity no longer matches the disk is dropped with its subtree and
   * re-recorded. Never throws: a directory that cannot be read, or a
   * fingerprinter that throws, marks the ledger incomplete and the walk
   * continues. A missing root counts as empty. The roots themselves get no
   * marker. `complete: false` means the ledger can no longer vouch; size
   * `maxEntries` to at least files plus directories.
   */
  prime(roots: string[]): PrimeSummary {
    const summary: PrimeSummary = { files: 0, directories: 0, complete: true };
    for (const root of roots) {
      const key = ObservedState.normalize(root);
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
        const { kind, id } = this.classify(full);
        let prev = this.entries.get(key);
        // A same-kind entry (same identity, for a directory) is never overwritten;
        // one whose kind or identity no longer matches the disk is stale: drop it
        // and its subtree, then record what is there.
        const link = kind === "dirlink";
        if (
          prev !== undefined &&
          (kind === "file"
            ? prev.kind !== "file"
            : prev.kind !== "dir" || prev.id !== id || prev.link !== link)
        ) {
          this.dropBeneath(key);
          prev = undefined;
        }
        const exists = prev !== undefined;
        if (kind === "file") {
          if (exists) continue;
          this.touch(key, { kind: "file", fp: this.fingerprint(full) });
          summary.files++;
        } else {
          if (!exists) {
            this.touch(key, { kind: "dir", link, id, scanned: true });
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
   * only called for files. A directory already recorded with the same identity
   * keeps its marker (and `scanned` flag); a different one replaces it and
   * drops the old subtree. A newly recorded directory is `scanned` only when it
   * is empty — its children are not recorded by this call.
   */
  record(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    const { kind, id } = this.classify(filePath);
    const prev = this.entries.get(key);
    if (kind === "file") {
      // Same orphan rule as isChanged: a directory that became a file or went
      // missing takes its descendants with it (silently — this is "accounted for").
      if (!isLiveFile(prev)) this.dropBeneath(key);
      this.touch(key, { kind: "file", fp: this.fingerprint(filePath) });
      return;
    }
    const link = kind === "dirlink";
    if (prev?.kind === "dir" && id !== "" && prev.id === id && prev.link === link) {
      this.touch(key, prev);
      return;
    }
    if (prev?.kind === "dir") this.dropBeneath(key);
    let scanned = true;
    if (!link) {
      try {
        scanned = readdirSync(filePath).length === 0;
      } catch {
        scanned = false;
      }
    }
    this.touch(key, { kind: "dir", link, id, scanned });
  }

  /**
   * Check-and-record: compares `filePath`'s current state against the stored
   * entry, stores the new state, and returns whether it differed. See the
   * class doc for the directory rules.
   */
  isChanged(filePath: string): boolean {
    const key = ObservedState.normalize(filePath);
    const prev = this.entries.get(key);
    const { kind, id } = this.classify(filePath);

    if (kind !== "file") {
      const link = kind === "dirlink";
      if (prev?.kind === "dir" && id !== "" && prev.id === id && prev.link === link) {
        this.touch(key, prev);
        return false; // the same directory (identity unchanged)
      }
      if (prev?.kind === "file" && prev.fp !== "absent") {
        this.touch(key, { kind: "dir", link, id, scanned: false });
        return true; // live file replaced by a directory
      }
      // A different directory (or a link flip) replaces the recorded one:
      // its old subtree is stale, so drop it before evaluating the new one.
      let droppedLive = false;
      if (prev?.kind === "dir") droppedLive = this.dropBeneath(key);
      const linkFlip = prev?.kind === "dir" && prev.link !== link;
      // Scan only if the ledger can vouch for it.
      const vouched = !link && !this.lossy && this.isUnderPrimedRoot(filePath);
      let changed = true;
      let scanned = link;
      if (vouched) {
        let files: string[] | undefined;
        try {
          files = walkFiles(filePath, () => true);
        } catch {
          files = undefined;
        }
        if (files !== undefined) {
          changed = false;
          scanned = true;
          // Evaluate every file (no short-circuit) so each one is recorded.
          for (const f of files) if (this.isChanged(f)) changed = true;
          // With no marker to compare (never seen, or evicted while its
          // children survived), a recorded file the scan did not find was
          // removed: that is a change, and its entry is stale.
          if (prev?.kind !== "dir") {
            const found = new Set(files.map((f) => ObservedState.normalize(f)));
            if (this.dropUnfound(key, found)) changed = true;
          }
        }
      }
      this.touch(key, { kind: "dir", link, id, scanned });
      return changed || droppedLive || linkFlip;
    }

    const next = this.fingerprint(filePath);
    // Descendants are orphans unless the stored entry is a live file (the
    // O(1) ordinary-modify path). A directory marker may have been evicted or
    // forgotten while its children survived, so prev === undefined drops too.
    const droppedLive = isLiveFile(prev) ? false : this.dropBeneath(key);
    if (prev?.kind === "dir") {
      this.touch(key, { kind: "file", fp: next });
      // "absent" distinguishes a missing path from one that is now a file. An
      // unscanned marker never had its children recorded, so dropping nothing
      // live proves nothing.
      return next !== "absent" || droppedLive || this.lossy || prev.link || !prev.scanned;
    }
    this.touch(key, { kind: "file", fp: next });
    return prev === undefined || prev.fp !== next || droppedLive;
  }

  /** Remove a tracked path and every entry beneath it. */
  forget(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    this.remove(key);
    this.dropBeneath(key);
  }

  /**
   * Remove the file entries beneath `key` that are not in `found` (the files a
   * scan just saw there). Returns whether any of them was a live file.
   * Directory markers beneath `key` are left to their own events.
   */
  private dropUnfound(key: string, found: Set<string>): boolean {
    const stack = [key.replace(/\/+$/, "") || "/"];
    const stale: string[] = [];
    while (stack.length > 0) {
      const kids = this.children.get(stack.pop()!);
      if (!kids) continue;
      for (const k of kids) {
        const e = this.entries.get(k);
        if (e?.kind === "file" && !found.has(k)) stale.push(k);
        stack.push(k);
      }
    }
    let droppedLive = false;
    for (const k of stale) {
      if (isLiveFile(this.entries.get(k))) droppedLive = true;
      this.remove(k);
    }
    return droppedLive;
  }

  /**
   * Delete every entry beneath `key` (trailing-slash normalized), found
   * through the parent index, so the cost is the subtree rather than the
   * ledger. Returns whether a live file (a real fingerprint) was dropped.
   */
  private dropBeneath(key: string): boolean {
    let root = key.replace(/\/+$/, "");
    if (root === "" && key !== "") root = "/";
    let droppedLive = false;
    const stack = [root];
    const nodes: string[] = [];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const kids = this.children.get(node);
      if (!kids) continue;
      for (const k of kids) {
        nodes.push(k);
        stack.push(k);
      }
    }
    for (const k of nodes) {
      const e = this.entries.get(k);
      // A link marker is content in the same sense a live file is.
      if (isLiveFile(e) || (e?.kind === "dir" && e.link)) droppedLive = true;
      this.entries.delete(k);
      this.children.delete(k);
    }
    this.children.delete(root);
    this.unlinkIfEmpty(root);
    return droppedLive;
  }

  /** Number of currently tracked entries (for testing). */
  get size(): number {
    return this.entries.size;
  }
}
