import * as fs from "node:fs";
import * as path from "node:path";

/** Signature of the synchronous directory reader `walkFiles` depends on. */
type ReaddirSync = (dir: string, opts: { withFileTypes: true }) => fs.Dirent[];

/**
 * Signature of the symlink-resolving stat `walkFiles` depends on. Returns
 * `undefined` when the path does not resolve, matching `fs.statSync`'s
 * `throwIfNoEntry: false` contract.
 */
type StatSync = (p: string) => fs.Stats | undefined;

/**
 * Recursively walks `dir` and returns absolute paths of all files whose path
 * satisfies `match`.
 *
 * **Every returned path is a regular file.** Callers may read any element of
 * the result without a further check. Entries that are not regular files —
 * directories, symlinks to directories (including Windows junctions), broken
 * symlinks, symlink cycles, sockets, devices — are never returned, even when
 * their *name* satisfies `match`. A symlink that resolves to a regular file
 * *is* returned, since reading it succeeds.
 *
 * @param dir   - Root directory to walk. If the directory does not exist the
 *                function returns `[]` without throwing. Other I/O errors
 *                (e.g. EACCES) from reading a directory are re-thrown.
 * @param match - Either a suffix string (e.g. `".json"`) for a simple
 *                `path.endsWith(suffix)` test, or an arbitrary predicate
 *                `(absolutePath: string) => boolean`.
 * @param readdir - Injectable directory reader; defaults to `fs.readdirSync`.
 * @param stat  - Injectable symlink-resolving stat; defaults to `fs.statSync`
 *                with `throwIfNoEntry: false`.
 *
 * `readdir` and `stat` exist so tests can substitute a stub (e.g. to simulate
 * `EACCES`) — ESM namespace members can't be monkey-patched in Node 22+.
 * Production callers should omit both.
 *
 * Symlinked directories are not followed: `recurse` descends only into entries
 * for which `entry.isDirectory()` is `true`, which excludes every symlink
 * whatever its target. That is what bounds the walk — a cycle is never entered.
 *
 * Classification is a fast path plus a fallback. `isDirectory()`/`isFile()`
 * settle ordinary entries with no extra syscall; anything else — every symlink,
 * plus special files — costs one resolving `stat`, and only if it already
 * matched `match`. A `stat` that fails for any reason (`ENOENT` for a broken
 * link, `ELOOP` for a cycle, `EACCES` for an unreadable parent) means the entry
 * is not *provably* a regular file, so it is dropped rather than propagated:
 * failing to classify one leaf should not abort the walk, whereas failing to
 * enumerate a directory genuinely stops it. See
 * `docs/decisions/0001-walkfiles-returns-only-regular-files.md`.
 */
export function walkFiles(
  dir: string,
  match: string | ((filePath: string) => boolean),
  readdir: ReaddirSync = (d, opts) => fs.readdirSync(d, opts),
  stat: StatSync = (p) => fs.statSync(p, { throwIfNoEntry: false })
): string[] {
  const predicate: (filePath: string) => boolean =
    typeof match === "string" ? (p) => p.endsWith(match) : match;

  const results: string[] = [];

  /** True only when `p` provably resolves to a regular file. */
  function isRegularFile(p: string): boolean {
    try {
      return stat(p)?.isFile() ?? false;
    } catch {
      return false;
    }
  }

  function recurse(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);

      if (entry.isDirectory()) {
        recurse(fullPath);
        continue;
      }

      // Filter first: an entry that cannot match is never worth a stat.
      if (!predicate(fullPath)) {
        continue;
      }

      if (entry.isFile() || isRegularFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  recurse(dir);
  return results;
}
