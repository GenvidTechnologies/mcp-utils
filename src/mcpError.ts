import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Options object accepted by {@link mcpError} as an alternative to the
 *  legacy `string[]` positional form. */
export interface McpErrorOptions {
  /** Prefix prepended to the message: `${prefix} ${message}` (single space).
   *  Pass without a trailing space (e.g. `"Error:"`). Default: no prefix. */
  prefix?: string;
  /** Additional lines appended after the message, joined with `"\n"`. */
  extraLines?: string[];
}

/**
 * Converts a caught value into a {@link CallToolResult} with `isError: true`.
 *
 * @param e - The caught value. `Error` instances use `.message`; everything
 *   else is converted with `String(e)`.
 * @param optsOrExtraLines - Either a legacy `string[]` of extra lines to
 *   append, or a {@link McpErrorOptions} object. Evaluated eagerly — pass a
 *   thunk via {@link withMcpErrors} when you need lazy evaluation.
 *   - Array form: `mcpError(e, ["extra line"])` — backward-compatible.
 *   - Options form: `mcpError(e, { prefix: "Error:", extraLines: [...] })`.
 */
export function mcpError(e: unknown, optsOrExtraLines?: string[] | McpErrorOptions): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);

  let prefix: string | undefined;
  let extraLines: string[] | undefined;

  if (Array.isArray(optsOrExtraLines)) {
    extraLines = optsOrExtraLines;
  } else if (optsOrExtraLines !== undefined) {
    prefix = optsOrExtraLines.prefix;
    extraLines = optsOrExtraLines.extraLines;
  }

  const baseMessage = prefix !== undefined && prefix !== "" ? `${prefix} ${message}` : message;
  const text = [baseMessage, ...(extraLines ?? [])].join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

/** Options object accepted by {@link withMcpErrors} as an alternative to the
 *  legacy `() => string[]` positional thunk form. */
export interface WithMcpErrorsOptions {
  /** Catch-time thunk returning extra lines (same semantics as the legacy
   *  positional thunk). Called only when an error is caught. */
  extraLines?: () => string[];
  /** Side-effect hook invoked with the caught error BEFORE it is formatted.
   *  Awaited. If it throws, the THROWN value is formatted instead of the
   *  original error — {@link withMcpErrors} still never throws out. */
  onError?: (err: unknown) => void | Promise<void>;
  /** Prefix passed through to {@link mcpError} (see
   *  {@link McpErrorOptions.prefix}). */
  prefix?: string;
}

/**
 * Wraps an async function so that any thrown error is caught and returned as a
 * {@link CallToolResult} error response instead of propagating.
 *
 * @param fn - The async function to wrap. Its type is preserved.
 * @param opts - Either a legacy `() => string[]` thunk (backward-compatible)
 *   or a {@link WithMcpErrorsOptions} object.
 *   - Legacy form: `withMcpErrors(fn, () => ["extra"])` — the thunk is
 *     called at catch time (not at wrap time) so it can read mutable state.
 *   - Options form: `withMcpErrors(fn, { prefix: "Error:", onError, extraLines })`.
 *     `onError` is awaited before formatting; if it throws, the thrown value
 *     replaces the original error in the formatted result.
 */
export function withMcpErrors<T extends (...a: any[]) => Promise<any>>(
  fn: T,
  opts?: (() => string[]) | WithMcpErrorsOptions,
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (typeof opts === "function") {
        // Legacy positional thunk form
        return mcpError(err, opts());
      }

      // Options object form (or undefined)
      let errorToFormat: unknown = err;
      if (opts?.onError !== undefined) {
        try {
          await opts.onError(err);
        } catch (hookErr) {
          errorToFormat = hookErr;
        }
      }
      return mcpError(errorToFormat, {
        prefix: opts?.prefix,
        extraLines: opts?.extraLines?.(),
      });
    }
  }) as T;
}
