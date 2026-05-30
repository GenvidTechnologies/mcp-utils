import * as path from "node:path";

/**
 * Resolves `rel` against `base` and returns the absolute path only if it stays
 * within `base`; otherwise returns `null`.
 *
 * - `""` and `"."` both resolve to `base` itself and are returned.
 * - An absolute `rel` that is inside `base` is returned as-is.
 * - A `rel` that escapes `base` via `..` segments, an absolute path outside
 *   `base`, or a cross-drive path on Windows all return `null`.
 * - A filename that merely *starts* with `..` but does not traverse upward
 *   (e.g. `..gitkeep`, `..cache`) stays inside `base` and is returned.
 *
 * **This is a purely lexical check** — it does no filesystem access and does
 * not resolve symlinks. A symlink inside `base` that points outside `base`
 * will be accepted, because `..`/absolute escapes are detected on the path
 * string only. For an on-disk containment guarantee (e.g. sandboxing
 * attacker-supplied paths against symlink escapes), `fs.realpath` the resolved
 * path and re-check, or combine this with a realpath step.
 */
export function resolveWithin(base: string, rel: string): string | null {
  const resolved = path.resolve(base, rel);
  const relToBase = path.relative(path.resolve(base), resolved);
  const escapes =
    relToBase === ".." ||
    relToBase.startsWith(".." + path.sep) ||
    path.isAbsolute(relToBase);
  return escapes ? null : resolved;
}
