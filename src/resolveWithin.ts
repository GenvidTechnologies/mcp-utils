import * as path from "node:path";

/**
 * Resolves `rel` against `base` and returns the absolute path only if it stays
 * within `base`; otherwise returns `null`.
 *
 * - `""` and `"."` both resolve to `base` itself and are returned.
 * - An absolute `rel` that is inside `base` is returned as-is.
 * - A `rel` containing `..` segments that escape `base`, an absolute path
 *   outside `base`, or a cross-drive path on Windows all return `null`.
 */
export function resolveWithin(base: string, rel: string): string | null {
  const resolved = path.resolve(base, rel);
  const relToBase = path.relative(path.resolve(base), resolved);
  return relToBase === "" ||
    (!relToBase.startsWith("..") && !path.isAbsolute(relToBase))
    ? resolved
    : null;
}
