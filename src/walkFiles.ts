import * as fs from "node:fs";
import * as path from "node:path";

/** Signature of the synchronous directory reader `walkFiles` depends on. */
type ReaddirSync = (dir: string, opts: { withFileTypes: true }) => fs.Dirent[];

/**
 * Recursively walks `dir` and returns absolute paths of all files whose path
 * satisfies `match`.
 *
 * @param dir   - Root directory to walk. If the directory does not exist the
 *                function returns `[]` without throwing. Other I/O errors
 *                (e.g. EACCES) are re-thrown.
 * @param match - Either a suffix string (e.g. `".json"`) for a simple
 *                `path.endsWith(suffix)` test, or an arbitrary predicate
 *                `(absolutePath: string) => boolean`.
 * @param readdir - Injectable directory reader; defaults to `fs.readdirSync`.
 *                Exists so tests can substitute a stub (e.g. to simulate
 *                `EACCES`) — ESM namespace members can't be monkey-patched in
 *                Node 22+. Production callers should omit it.
 *
 * Symlinks are not followed: only entries for which `entry.isDirectory()`
 * returns `true` are recursed into. A symlink to a directory returns `false`
 * from `isDirectory()` and is therefore treated as a leaf (not recursed).
 */
export function walkFiles(
  dir: string,
  match: string | ((filePath: string) => boolean),
  readdir: ReaddirSync = (d, opts) => fs.readdirSync(d, opts)
): string[] {
  const predicate: (filePath: string) => boolean =
    typeof match === "string" ? (p) => p.endsWith(match) : match;

  const results: string[] = [];

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
      } else if (predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  recurse(dir);
  return results;
}
