import * as fs from "node:fs";
import * as path from "node:path";
import type { ZodType } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpError } from "./mcpError.js";
import { resolveWithin } from "./resolveWithin.js";

/**
 * Options for {@link loadProjectConfig}.
 *
 * @template T - The validated config type produced by the zod schema.
 */
export interface LoadConfigOpts<T> {
  /**
   * Keys of `T` whose string values must resolve within `projectRoot` via
   * {@link resolveWithin}. This is an assertion-only check — the field value
   * is returned exactly as authored (it is NOT rewritten to an absolute path).
   * Non-string values for listed keys are silently skipped.
   */
  containedPaths?: (keyof T)[];

  /**
   * When `true`, a missing config file (ENOENT) is not treated as an error.
   * Instead the file layer is skipped entirely (treated as `{}`), and the
   * merge proceeds with `opts.defaults` and `overrides` only. Schema
   * `.default()` values fill any remaining gaps.
   *
   * When `false` or absent, a missing file returns an {@link mcpError}.
   */
  optional?: boolean;

  /**
   * Lowest-precedence values merged under the file contents and `overrides`.
   * Useful for supplying programmatic defaults that a file or caller can
   * override.  See {@link loadProjectConfig} for full merge precedence.
   */
  defaults?: Partial<T>;
}

/**
 * Narrows an unknown value to a {@link CallToolResult} error produced by
 * {@link mcpError}.
 *
 * Use this to discriminate the `T | CallToolResult` return of
 * {@link loadProjectConfig}:
 *
 * ```ts
 * const cfg = await loadProjectConfig(root, "cfg.json", MySchema);
 * if (isMcpError(cfg)) return cfg; // propagate the error
 * // cfg is now narrowed to T
 * ```
 *
 * The check is intentionally defensive: it returns `true` iff `x` is a
 * non-null object whose `isError` property is exactly `true` (boolean).
 */
export function isMcpError(x: unknown): x is CallToolResult {
  return typeof x === "object" && x !== null && (x as { isError?: unknown }).isError === true;
}

/**
 * Reads `<projectRoot>/<fileName>`, JSON-parses it, merges with `overrides`
 * and `opts.defaults`, validates through a zod `schema`, and optionally
 * asserts that nominated path fields stay within `projectRoot`.
 *
 * **Merge precedence (highest → lowest):**
 * `overrides` > file contents > `opts.defaults` > schema `.default()`.
 *
 * All layers are shallow-merged at the top level; nested objects are not
 * deep-merged.
 *
 * **Return value:** on success the validated `T` is returned; on any failure
 * (missing required file, JSON parse error, schema violation, path escape) a
 * {@link CallToolResult} with `isError: true` is returned instead of
 * throwing. Use {@link isMcpError} to narrow the union:
 *
 * ```ts
 * const cfg = await loadProjectConfig(root, "cfg.json", MySchema, overrides, opts);
 * if (isMcpError(cfg)) return cfg;
 * // cfg is now T
 * ```
 *
 * All error messages are prefixed with `loadProjectConfig(<fileName>):` for
 * unambiguous failure attribution in tool output.
 *
 * @param projectRoot - Absolute path to the project root directory. Used to
 *   resolve the config file path and to anchor `containedPaths` checks.
 * @param fileName - Name (or relative path) of the config file within
 *   `projectRoot`. E.g. `"project.json"` or `"config/settings.json"`.
 * @param schema - A zod schema used to validate the merged object. Zod
 *   `.default()` decorators fill fields still absent after the merge.
 * @param overrides - Highest-precedence partial values, applied over the file.
 *   Typically supplied by the MCP tool's request arguments. Pass `undefined`
 *   to skip.
 * @param opts - Optional behaviour flags: `optional`, `defaults`,
 *   `containedPaths`. See {@link LoadConfigOpts}.
 * @param readFile - Injectable file reader; defaults to
 *   `fs.promises.readFile`. **Test seam only — production callers must omit
 *   this parameter.** Follows the same `(path, "utf-8") => Promise<string>`
 *   signature as `fs.promises.readFile` so tests can pass a stub to simulate
 *   ENOENT, EACCES, or arbitrary content without touching the filesystem.
 *
 * @returns The validated `T` on success, or a {@link CallToolResult} error
 *   value on failure. Never throws.
 */
export async function loadProjectConfig<T>(
  projectRoot: string,
  fileName: string,
  schema: ZodType<T>,
  overrides?: Partial<T>,
  opts?: LoadConfigOpts<T>,
  readFile: (p: string, enc: "utf-8") => Promise<string> = (p, enc) => fs.promises.readFile(p, enc),
): Promise<T | CallToolResult> {
  const prefix = `loadProjectConfig(${fileName}): `;
  const filePath = path.join(projectRoot, fileName);

  // Step 1: Read the file
  let rawContents: string;
  try {
    rawContents = await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && opts?.optional) {
      // Optional + missing → treat as empty object, skip file layer
      rawContents = "{}";
    } else {
      return mcpError(new Error(`${prefix}${(err as Error).message ?? String(err)}`));
    }
  }

  // Step 2: Parse JSON
  let fileObj: Record<string, unknown>;
  try {
    fileObj = JSON.parse(rawContents) as Record<string, unknown>;
  } catch (err) {
    return mcpError(new Error(`${prefix}${(err as Error).message ?? String(err)}`));
  }

  // Step 3: Shallow merge — defaults < file < overrides
  const merged = {
    ...(opts?.defaults ?? {}),
    ...fileObj,
    ...(overrides ?? {}),
  };

  // Step 4: Validate with zod schema
  const result = schema.safeParse(merged);
  if (!result.success) {
    const zodIssueLines = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return mcpError(new Error(`${prefix}schema validation failed`), zodIssueLines);
  }

  const validated = result.data;

  // Step 5: containedPaths assertion (assert-only, do NOT rewrite)
  for (const key of opts?.containedPaths ?? []) {
    const value = (validated as Record<keyof T, unknown>)[key];
    if (typeof value !== "string") {
      // Non-string values are skipped per spec
      continue;
    }
    const resolved = resolveWithin(projectRoot, value);
    if (resolved === null) {
      return mcpError(new Error(`${prefix}path for field "${String(key)}" escapes projectRoot: ${value}`));
    }
  }

  return validated;
}
