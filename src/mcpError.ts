import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Converts a caught value into a {@link CallToolResult} with `isError: true`.
 *
 * @param e - The caught value. `Error` instances use `.message`; everything
 *   else is converted with `String(e)`.
 * @param extraLines - Optional additional lines appended to the message,
 *   joined with `"\n"`. Evaluated eagerly — pass a thunk via
 *   {@link withMcpErrors} when you need lazy evaluation.
 */
export function mcpError(e: unknown, extraLines?: string[]): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  const text = [message, ...(extraLines ?? [])].join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Wraps an async function so that any thrown error is caught and returned as a
 * {@link CallToolResult} error response instead of propagating.
 *
 * The `extraLines` thunk is called **at catch time**, not at wrap time, so it
 * can read mutable state that has changed between the call and the throw (e.g.
 * a request counter or accumulated log lines).
 *
 * @param fn - The async function to wrap. Its type is preserved.
 * @param extraLines - Optional thunk that returns additional lines to append to
 *   the error message. Called only when an error is caught.
 */
export function withMcpErrors<T extends (...a: any[]) => Promise<any>>(
  fn: T,
  extraLines?: () => string[],
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      return mcpError(err, extraLines?.());
    }
  }) as T;
}
