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
 * (stored by `prime` or by a walk that recorded the children), false only when
 * the walk of its children failed. `stamp` is the directory's `ctimeNs` as a
 * string, or "" when unknown (a link, a failed `lstat`, a failed walk, or a
 * ctime inside the racy window); "" never matches.
 */
type Entry =
  | { kind: "file"; fp: string }
  | { kind: "dir"; link: boolean; id: string; scanned: boolean; stamp: string };

/** A ctime younger than this (1000 ms, in ns) is "racily clean": see `ObservedState.racyStamp`. */
const RACY_WINDOW_NS = 1000n * 1_000_000n;

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
 * matches) is decided by its change time. The marker stores the directory's
 * ctime: renaming the directory itself changes it (as does adding, removing
 * or renaming an entry in it), so a directory renamed out, edited and renamed
 * back is seen, which an inode alone cannot do. When the stored ctime equals the current one (and is not "racy", see
 * below) the directory is unchanged and nothing is walked or fingerprinted.
 * Otherwise a `scanned` marker on a non-lossy ledger is re-checked: every file
 * beneath it, at any depth, is evaluated, a recorded file that is gone counts
 * as a change, and the ctime read before the walk is stored. An unscanned
 * marker or a lossy ledger fails open: the children are re-recorded silently
 * and the directory reports changed. A ctime younger than one second (or in
 * the future, or 0) is "racily clean", as in a git index: a later rename within
 * the clock's granularity can reproduce it, so it is stored as unknown and the
 * next event takes the re-check. A link marker is unchanged on identity alone.
 * A different directory swapped in at the path or a dir/link flip replaces the
 * marker: the old subtree is dropped (changed if a live file was) and the new
 * one is evaluated like a never-seen directory. A marker is `scanned` when its
 * children are known to be recorded (`prime`, or any walk of them that
 * succeeded, `record` included) and unscanned only after a failed walk; a
 * directory that later vanishes or becomes a file while unscanned is changed,
 * since dropping no live entries proves nothing. Descendants are found through a parent→children
 * index, so a drop costs the subtree, not the ledger. A live file
 * replaced by a directory is changed; a never-seen directory is changed
 * unless it lies under a `prime`d root, the ledger is not lossy and it is
 * not a link, in which case every file beneath it is evaluated and the
 * directory is changed only if one of them is; otherwise its children are
 * recorded silently and it is changed. On a path that is now a file
 * or missing, all entries beneath it are dropped, whatever its own stored
 * entry is (a file has no children, so they can only be orphans), so a
 * directory later moved back in is re-evaluated rather than matched against
 * orphaned children; the path is changed if it is now a file, a dropped entry
 * was a live file, the ledger is lossy, or the marker was a link. `record`
 * and `forget` drop the same descendants.
 *
 * `prime` fills gaps only: it never overwrites an entry, never descends into a
 * path whose entry conflicts with the disk (a different kind, identity or link
 * flag — the event path reports those and fails open), and skips any subtree
 * already under a root from an earlier `prime` call, which belongs to whoever
 * primed it and to that owner's queued events.
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
  private classify(p: string): { kind: Kind; id: string; stamp: string } {
    try {
      const st = lstatSync(p, { bigint: true, throwIfNoEntry: false });
      if (!st) return { kind: "file", id: "", stamp: "" };
      const id = st.ino === 0n ? "" : st.ino.toString();
      if (st.isDirectory()) return { kind: "dir", id, stamp: ObservedState.racyStamp(st.ctimeNs) };
      if (st.isSymbolicLink() && statSync(p).isDirectory()) return { kind: "dirlink", id, stamp: "" };
      return { kind: "file", id: "", stamp: "" };
    } catch {
      return { kind: "file", id: "", stamp: "" };
    }
  }

  /**
   * Encodes a directory's change time (`ctimeNs`) as a stamp, or "" (unknown,
   * never matches) when it cannot be trusted. Like git's "racily clean" entries:
   * a ctime younger than `RACY_WINDOW_NS` (or in the future, or 0) can be
   * reproduced by a later rename within the clock's granularity, so it is
   * treated as unknown. `now` is in nanoseconds and is a parameter for tests.
   */
  private static racyStamp(ctimeNs: bigint, now: bigint = BigInt(Date.now()) * 1_000_000n): string {
    if (ctimeNs === 0n || ctimeNs + RACY_WINDOW_NS > now) return "";
    return ctimeNs.toString();
  }

  /**
   * True when `p` is a primed root or lies beneath one. Used to decide whether the ledger vouches for a directory.
   * A root that already ends in a separator (a bare "/" or a drive root "C:/", the only keys `normalize` leaves
   * with one) is its own prefix; any other root gets "/" appended.
   */
  private isUnderPrimedRoot(p: string): boolean {
    const key = ObservedState.normalize(p);
    return this.primedRoots.some((r) => key === r || key.startsWith(r.endsWith("/") ? r : r + "/"));
  }

  /**
   * Walks `roots` recursively and records a baseline: directories (and links
   * to directories, which are not descended into) as markers, files as
   * fingerprints. Fills gaps only, and only where nothing else has spoken:
   * - an existing entry is never overwritten;
   * - a path whose existing entry conflicts with the disk (a file entry where
   *   there is now a directory, a directory marker where there is now a file,
   *   or a marker with a different identity or link flag) is left alone and not
   *   descended into — the event path reports it and fails open;
   * - a root that is equal to or beneath a root from an earlier `prime` call
   *   (typically another watcher sharing this ledger, which owns those paths
   *   and their queued events) is skipped, and a directory that is itself such
   *   a root is not descended into. The root is still recorded as primed.
   * Never throws: a directory that cannot be read, or a fingerprinter that
   * throws, marks the ledger incomplete and the walk continues. A missing root
   * counts as empty. A root that is a regular file, or a link to one, is
   * recorded as a file (counted in `files`) under the same fill-gaps-only rule;
   * directory roots themselves get no marker. The summary counts
   * only what this call added. `complete: false` means the ledger can no
   * longer vouch; size `maxEntries` to at least files plus directories.
   */
  prime(roots: string[]): PrimeSummary {
    const summary: PrimeSummary = { files: 0, directories: 0, complete: true };
    for (const root of roots) {
      const key = ObservedState.normalize(root);
      if (this.isUnderPrimedRoot(root)) continue;
      const earlier = new Set(this.primedRoots);
      this.primedRoots.push(key);
      if (this.isFileRoot(root)) {
        if (this.entries.has(key)) continue; // never overwrite
        try {
          this.touch(key, { kind: "file", fp: this.fingerprint(root) });
          summary.files++;
        } catch {
          this.lossy = true;
        }
        continue;
      }
      this.walk(root, summary, earlier);
    }
    summary.complete = !this.lossy;
    return summary;
  }

  /** True when `p` is a regular file or a link to one. Anything else (or any error) is left to `walk`. */
  private isFileRoot(p: string): boolean {
    try {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) return false;
      if (st.isFile()) return true;
      return st.isSymbolicLink() && statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /** Returns false when `dir` could not be listed (it vanished, or the read failed). */
  private walk(dir: string, summary: PrimeSummary, earlier: Set<string>): boolean {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.lossy = true;
      return false;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const key = ObservedState.normalize(full);
      try {
        const { kind, id, stamp } = this.classify(full);
        const prev = this.entries.get(key);
        const link = kind === "dirlink";
        if (kind === "file") {
          if (prev !== undefined) continue; // never overwrite; a conflicting dir marker is left to its event
          this.touch(key, { kind: "file", fp: this.fingerprint(full) });
          summary.files++;
          continue;
        }
        if (prev !== undefined) {
          // Same kind and identity: fill gaps beneath it. Anything else conflicts: leave it entirely.
          if (prev.kind !== "dir" || prev.id !== id || prev.link !== link) continue;
        } else {
          this.touch(key, { kind: "dir", link, id, scanned: true, stamp });
          summary.directories++;
        }
        if (kind === "dir" && !earlier.has(key)) {
          if (!this.walk(full, summary, earlier) && prev === undefined) {
            // The children were never recorded, so the marker we just added must not claim they were.
            const added = this.entries.get(key);
            if (added?.kind === "dir") {
              added.scanned = false;
              added.stamp = ""; // an unscanned marker must not be vouched for by its ctime
            }
          }
        }
      } catch {
        this.lossy = true;
      }
    }
    return true;
  }

  /**
   * Record `filePath` now, unconditionally — "this state is accounted for".
   * A directory (or link to one) is stored as a marker; the fingerprinter is
   * only called for files. A directory already recorded with the same identity
   * and an unchanged (non-racy) ctime keeps its marker. If its ctime moved, its
   * children are re-recorded silently (a recorded file that is gone is dropped)
   * and the new ctime is stored, so a later event does not report what this
   * call accounted for. A different directory replaces the marker and drops the
   * old subtree. Whenever a directory is recorded its children are recorded
   * with it; the marker is `scanned` unless that walk failed.
   */
  record(filePath: string): void {
    const key = ObservedState.normalize(filePath);
    const { kind, id, stamp } = this.classify(filePath);
    const prev = this.entries.get(key);
    if (kind === "file") {
      // Same orphan rule as isChanged: a directory that became a file or went
      // missing takes its descendants with it (silently — this is "accounted for").
      this.dropBeneath(key);
      this.touch(key, { kind: "file", fp: this.fingerprint(filePath) });
      return;
    }
    const link = kind === "dirlink";
    if (prev?.kind === "dir" && id !== "" && prev.id === id && prev.link === link) {
      if (link || (stamp !== "" && prev.stamp === stamp)) {
        this.touch(key, prev);
        return;
      }
      // The directory changed under the same identity: account for its children.
      this.rewalkSilently(key, filePath, id, stamp);
      return;
    }
    if (prev?.kind === "dir") this.dropBeneath(key);
    this.touch(key, this.newDirMarker(key, filePath, link, id, stamp));
  }

  /**
   * Marker for a directory with no usable marker of its own: records its
   * children silently (a recorded file the walk did not find is stale and
   * dropped) and sets `scanned` from the walk's success. A link has no children
   * to record. A failed walk stores no stamp, so the hot path cannot vouch for
   * children that were never recorded.
   */
  private newDirMarker(key: string, dirPath: string, link: boolean, id: string, stamp: string): Entry {
    if (link) return { kind: "dir", link, id, scanned: true, stamp };
    const res = this.recordChildren(key, dirPath, false, true);
    return { kind: "dir", link, id, scanned: res.ok, stamp: res.ok ? stamp : "" };
  }

  /**
   * Silently re-records the children of a same-identity directory and stores
   * `stamp` (read before the walk, so an edit during the walk is seen next
   * time). `scanned` follows the walk's success; a failed walk stores no stamp.
   */
  private rewalkSilently(key: string, dirPath: string, id: string, stamp: string): void {
    const res = this.recordChildren(key, dirPath, false, true);
    this.touch(key, { kind: "dir", link: false, id, scanned: res.ok, stamp: res.ok ? stamp : "" });
  }

  /**
   * Check-and-record: compares `filePath`'s current state against the stored
   * entry, stores the new state, and returns whether it differed. See the
   * class doc for the directory rules.
   */
  isChanged(filePath: string): boolean {
    const key = ObservedState.normalize(filePath);
    const prev = this.entries.get(key);
    const { kind, id, stamp } = this.classify(filePath);

    if (kind !== "file") {
      const link = kind === "dirlink";
      if (prev?.kind === "dir" && id !== "" && prev.id === id && prev.link === link) {
        // Same identity. A link, or a non-racy ctime equal to the stored one, is
        // unchanged without walking or fingerprinting anything.
        if (link || (stamp !== "" && prev.stamp === stamp)) {
          this.touch(key, prev);
          return false;
        }
        // The ctime moved (or is unknown): look beneath it.
        if (prev.scanned && !this.lossy) {
          // Re-check the whole subtree. A recorded file that is gone is a
          // change even though a marker exists.
          const res = this.recordChildren(key, filePath, true, true);
          this.touch(key, { kind: "dir", link, id, scanned: res.ok, stamp: res.ok ? stamp : "" });
          return res.changed;
        }
        // Unscanned marker or lossy ledger: fail open, and re-record the children.
        this.rewalkSilently(key, filePath, id, stamp);
        return true;
      }
      if (prev?.kind === "file" && prev.fp !== "absent") {
        this.touch(key, this.newDirMarker(key, filePath, link, id, stamp));
        return true; // live file replaced by a directory
      }
      // A different directory (or a link flip) replaces the recorded one:
      // its old subtree is stale, so drop it before evaluating the new one.
      let droppedLive = false;
      if (prev?.kind === "dir") droppedLive = this.dropBeneath(key);
      const linkFlip = prev?.kind === "dir" && prev.link !== link;
      // Scan only if the ledger can vouch for it.
      const vouched = !link && !this.lossy && this.isUnderPrimedRoot(filePath);
      if (!vouched) {
        // Still a change, but record the children so the marker does not
        // claim less than we know (a link has none).
        this.touch(key, this.newDirMarker(key, filePath, link, id, stamp));
        return true;
      }
      // With no marker to compare (never seen, or evicted while its
      // children survived), a recorded file the scan did not find was
      // removed: that is a change, and its entry is stale.
      const res = this.recordChildren(key, filePath, true, prev?.kind !== "dir");
      this.touch(key, { kind: "dir", link, id, scanned: res.ok, stamp: res.ok ? stamp : "" });
      return res.changed || droppedLive || linkFlip;
    }

    const next = this.fingerprint(filePath);
    // A file or missing path has no children, so anything indexed beneath it
    // is an orphan: a directory marker evicted or forgotten while its children
    // survived, or a stale file entry at a path that was a directory when its
    // children were recorded. The parent index makes this O(1) when there is
    // nothing beneath the path, which is the ordinary-modify case.
    const droppedLive = this.dropBeneath(key);
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
   * Walk the subtree at `dirPath` (`key` is its normalized form) with
   * `walkFiles` and record every file found. Returns `{ ok, changed }`:
   * `ok: false` means the walk threw, nothing was recorded, and the caller must
   * not mark the directory `scanned` (`changed` is then `true`, the fail-open
   * answer). Otherwise `changed` is meaningful only when `report` is true.
   * - `report: true` runs `isChanged` on each found file (no short-circuit, so
   *   each is recorded) and reports whether any differed, including a dropped
   *   live entry when `dropStale` is set.
   * - `report: false` is silent: each found file is `record`ed, `changed` is
   *   `false`.
   * `dropStale` removes recorded files beneath `key` the walk did not find via
   * `dropUnfound`; the caller decides when that is valid.
   */
  private recordChildren(
    key: string,
    dirPath: string,
    report: boolean,
    dropStale: boolean,
  ): { ok: boolean; changed: boolean } {
    let files: string[];
    try {
      files = walkFiles(dirPath, () => true);
    } catch {
      return { ok: false, changed: true };
    }
    let changed = false;
    for (const f of files) {
      if (report) {
        if (this.isChanged(f)) changed = true;
      } else this.record(f);
    }
    if (dropStale) {
      const found = new Set(files.map((f) => ObservedState.normalize(f)));
      if (this.dropUnfound(key, found) && report) changed = true;
    }
    return { ok: true, changed };
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
