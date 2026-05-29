/**
 * Escapes all regex metacharacters in a string so it can be used as a
 * literal pattern inside `new RegExp(...)`.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts all backslashes in a path to forward slashes, producing a
 * POSIX-style path. No-ops on paths that already use forward slashes.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}
