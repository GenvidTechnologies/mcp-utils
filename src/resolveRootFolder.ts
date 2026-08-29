import * as fs from "node:fs";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpError } from "./mcpError.js";

/** Signature of the synchronous directory reader resolveRootFolder depends on. */
type ReaddirSync = (dir: string, opts: { withFileTypes: true }) => fs.Dirent[];

/**
 * Options for {@link resolveRootFolder} and {@link resolveRootFolders}.
 */
export interface ResolveRootFolderOpts {
  /**
   * Highest-precedence override. Wins if set and non-empty/non-whitespace.
   * Typically sourced from a CLI `--project-dir` flag.
   * Relative values are resolved against `cwd`. Absolute values used as-is.
   * **No containment restriction** — a `../sibling` override is permitted.
   */
  explicit?: string;

  /**
   * Name of an environment variable to honour as the second-highest precedence
   * source. Only used when `explicit` is absent or blank.
   * Relative env values are resolved against `cwd`.
   */
  envVar?: string;

  /**
   * Filename or directory name that identifies a project root.
   * E.g. `"project.c3proj"` or `".git"`.
   * Matched by entry name regardless of whether it is a file or directory.
   * Required and must be non-whitespace — otherwise {@link resolveRootFolder}
   * / {@link resolveRootFolders} return an `mcpError`.
   */
  marker: string;

  /**
   * Starting directory for discovery and the resolution base for relative
   * `explicit`/`envVar` values. Defaults to `process.cwd()`.
   */
  cwd?: string;

  /**
   * Maximum depth below `cwd` at which to search for the marker.
   * Depth 1 means immediate children of `cwd` are searched (the default).
   * Depth 0 means only `cwd` itself is checked (same as omitting discovery).
   */
  searchDepth?: number;
}

/**
 * The resolved project root returned by {@link resolveRootFolder} on success.
 */
export interface ResolvedRoot {
  /** Absolute path to the resolved project root. */
  path: string;

  /**
   * How the root was determined:
   * - `"explicit"` — the caller's `opts.explicit` value was used.
   * - `"env"` — the named environment variable was used.
   * - `"discovery"` — a directory containing the marker was found.
   * - `"cwd"` — fallback: no marker found, `cwd` is returned as-is.
   *   Consumers typically warn when they receive this source.
   */
  source: "explicit" | "env" | "discovery" | "cwd";
}

/**
 * The resolved project root candidates returned by {@link resolveRootFolders}
 * on success.
 */
export interface ResolvedRoots {
  /**
   * Absolute paths to the resolved project root candidate(s). Always
   * non-empty. More than one entry occurs only for `source: "discovery"`,
   * when the marker was found in two or more sibling directories.
   */
  paths: string[];

  /**
   * How the candidates were determined:
   * - `"explicit"` — the caller's `opts.explicit` value was used.
   * - `"env"` — the named environment variable was used.
   * - `"discovery"` — one or more directories containing the marker were found.
   * - `"cwd"` — fallback: no marker found, `cwd` is returned as-is.
   *   Consumers typically warn when they receive this source.
   */
  source: "explicit" | "env" | "discovery" | "cwd";
}

/** Narrows a resolveRootFolders result to its `CallToolResult` error case. */
function isErrorResult(result: ResolvedRoots | CallToolResult): result is CallToolResult {
  return (result as CallToolResult).isError === true;
}

/**
 * Resolves the project root candidate(s) using a four-level precedence chain:
 * `explicit` > `env` > `discovery` > `cwd`.
 *
 * This is the plural counterpart of {@link resolveRootFolder}: identical
 * precedence and discovery behaviour, but ambiguous discovery (two or more
 * directories containing the marker) is a **success** carrying every
 * candidate, rather than an error. `resolveRootFolder` is implemented on top
 * of this function.
 *
 * **Resolution algorithm:**
 * 1. If `opts.explicit` is truthy after trimming → return `{ paths: [it] }`
 *    (resolved against `cwd` if relative). No containment restriction.
 * 2. Else if `opts.envVar` is set and the named env var is truthy after
 *    trimming → return `{ paths: [it] }` (resolved against `cwd` if relative).
 * 3. Else search for directories that contain `opts.marker`:
 *    - Check `cwd` itself (depth 0) — if it matches, return immediately with
 *      `{ paths: [cwd] }` without scanning children.
 *    - Search child directories up to `opts.searchDepth` (default 1).
 *    - 1 or more matches → return `{ paths: matches, source: "discovery" }`.
 *    - 0 matches → fall through to step 4.
 *    A directory that **contains** the marker is not recursed further (its
 *    subtree is skipped), but sibling subtrees continue to be scanned.
 * 4. Return `{ paths: [cwd], source: "cwd" }` (no marker found anywhere).
 *
 * **Never throws.** All `readdir` errors are caught:
 * - `ENOENT` → treated as "no entries / no match".
 * - Other I/O errors (e.g. `EACCES`) → returned as `mcpError`.
 *
 * @param opts - Resolution options. See {@link ResolveRootFolderOpts}.
 * @param env - Environment object; defaults to `process.env`. **Test seam only
 *   — production callers must omit this parameter.**
 * @param readdir - Injectable directory reader; defaults to `fs.readdirSync`.
 *   **Test seam only — production callers must omit this parameter.**
 *
 * @returns A {@link ResolvedRoots} on success, or a {@link CallToolResult}
 *   with `isError: true` on failure. Never throws.
 */
export function resolveRootFolders(
  opts: ResolveRootFolderOpts,
  env: NodeJS.ProcessEnv = process.env,
  readdir: ReaddirSync = (d, o) => fs.readdirSync(d, o),
): ResolvedRoots | CallToolResult {
  // Validate marker
  if (!opts.marker.trim()) {
    return mcpError(new Error("resolveRootFolder: marker is required"));
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const marker = opts.marker;
  const searchDepth = opts.searchDepth ?? 1;

  // Helper: resolve a user-supplied path value against cwd
  function resolveValue(value: string): string {
    return path.isAbsolute(value) ? value : path.resolve(cwd, value);
  }

  // 1. explicit
  const explicitTrimmed = opts.explicit?.trim();
  if (explicitTrimmed) {
    return { paths: [resolveValue(explicitTrimmed)], source: "explicit" };
  }

  // 2. env
  if (opts.envVar !== undefined) {
    const envValue = env[opts.envVar]?.trim();
    if (envValue) {
      return { paths: [resolveValue(envValue)], source: "env" };
    }
  }

  // 3. discovery
  //
  // We collect all directories containing the marker.
  // ENOENT → skip (treat as absent).
  // Other errors → return mcpError immediately.
  //
  // matches[i] is the absolute path of a directory that contains the marker.
  const matches: string[] = [];
  let ioError: CallToolResult | null = null;

  /**
   * Read `dir`'s entries. Returns the entries array on success, `null` on
   * ENOENT (treat as absent), or sets `ioError` and returns `null` on other
   * errors.
   */
  function safeReaddir(dir: string): fs.Dirent[] | null {
    try {
      return readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      ioError = mcpError(new Error(`resolveRootFolder: ${(err as Error).message ?? String(err)}`));
      return null;
    }
  }

  /**
   * Returns true iff `dir` contains an entry whose name equals `marker`.
   * Also sets `ioError` if a non-ENOENT error occurs.
   */
  function containsMarker(dir: string): boolean {
    const entries = safeReaddir(dir);
    if (entries === null) return false;
    return entries.some((e) => e.name === marker);
  }

  /**
   * Recursively scan `dir` looking for subdirectories that contain the
   * marker. `currentDepth` is how deep we are below `cwd` (1 = immediate
   * children of cwd).
   *
   * Pushes matching absolute paths into `matches`. Returns false normally,
   * or true to signal an early-abort (ioError set).
   */
  const scanDir = (dir: string, currentDepth: number): boolean => {
    const entries = safeReaddir(dir);
    if (ioError !== null) return true; // abort
    if (entries === null) return false; // ENOENT — skip

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const childPath = path.join(dir, entry.name);

      // Check if this child contains the marker
      if (containsMarker(childPath)) {
        if (ioError !== null) return true;
        matches.push(childPath);
        // Do NOT recurse into this matched directory — short-circuit its subtree
        continue;
      }
      if (ioError !== null) return true;

      // Recurse deeper if within depth budget
      if (currentDepth < searchDepth) {
        const abort = scanDir(childPath, currentDepth + 1);
        if (abort) return true;
      }
    }
    return false;
  };

  // Depth-0 check: does cwd itself contain the marker?
  if (containsMarker(cwd)) {
    return { paths: [cwd], source: "discovery" };
  }
  if (ioError !== null) return ioError;

  // Depth 1..searchDepth: scan child directories
  if (searchDepth >= 1) {
    const abort = scanDir(cwd, 1);
    if (abort && ioError !== null) return ioError;
  }

  if (matches.length >= 1) {
    return { paths: matches, source: "discovery" };
  }

  // 4. cwd fallback
  return { paths: [cwd], source: "cwd" };
}

/**
 * Resolves the project root directory using a four-level precedence chain:
 * `explicit` > `env` > `discovery` > `cwd`.
 *
 * Implemented on top of {@link resolveRootFolders}, which owns the discovery
 * walk: this function narrows a single-candidate result to a `path`, and
 * formats the multi-candidate ("ambiguous") case as an `mcpError` instead of
 * the plural's success. See {@link resolveRootFolders} for the full
 * resolution algorithm and never-throws contract.
 *
 * @param opts - Resolution options. See {@link ResolveRootFolderOpts}.
 * @param env - Environment object; defaults to `process.env`. **Test seam only
 *   — production callers must omit this parameter.**
 * @param readdir - Injectable directory reader; defaults to `fs.readdirSync`.
 *   **Test seam only — production callers must omit this parameter.**
 *
 * @returns A {@link ResolvedRoot} on success, or a {@link CallToolResult} with
 *   `isError: true` on failure (including ambiguous discovery — two or more
 *   directories containing the marker). Never throws.
 */
export function resolveRootFolder(
  opts: ResolveRootFolderOpts,
  env: NodeJS.ProcessEnv = process.env,
  readdir: ReaddirSync = (d, o) => fs.readdirSync(d, o),
): ResolvedRoot | CallToolResult {
  const result = resolveRootFolders(opts, env, readdir);

  if (isErrorResult(result)) {
    return result;
  }

  if (result.paths.length === 1) {
    return { path: result.paths[0], source: result.source };
  }

  // >= 2 candidates only occurs for source: "discovery" — ambiguous root.
  return mcpError(
    new Error(`resolveRootFolder: ambiguous root — ${result.paths.length} directories contain "${opts.marker}"`),
    result.paths,
  );
}
