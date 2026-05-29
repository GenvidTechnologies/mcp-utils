import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Internal hooks object that delegates filesystem calls used by `walkFiles`.
 * Exposed so tests can substitute implementations to simulate I/O errors
 * without relying on ESM live-binding mutation (which is read-only from
 * consumers in Node.js 22+).
 *
 * @internal
 */
export const _walkFilesHooks = {
  readdirSync: (d: string, opts: { withFileTypes: true }): fs.Dirent[] =>
    fs.readdirSync(d, opts),
};

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
 *
 * Symlinks are not followed: only entries for which `entry.isDirectory()`
 * returns `true` are recursed into. A symlink to a directory returns `false`
 * from `isDirectory()` and is therefore treated as a leaf (not recursed).
 */
export function walkFiles(
  dir: string,
  match: string | ((filePath: string) => boolean)
): string[] {
  const predicate: (filePath: string) => boolean =
    typeof match === "string" ? (p) => p.endsWith(match) : match;

  const results: string[] = [];

  function recurse(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = _walkFilesHooks.readdirSync(d, { withFileTypes: true });
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
