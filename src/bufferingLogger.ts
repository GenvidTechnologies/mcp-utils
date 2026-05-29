import type { Logger } from "./types.js";

/**
 * Creates a buffering logger that captures all log calls in memory.
 *
 * Each call to `log` appends a line to an internal buffer; multiple arguments
 * are joined with a single space (via `String()` coercion), matching the
 * behaviour of `console.log`. The accumulated text is retrieved with `text()`,
 * where lines are joined with `"\n"`.
 *
 * Typical use: capture diagnostic output in tests or tool invocations without
 * writing to stdout, then inspect or forward the collected text as needed.
 *
 * @example
 * const { log, text } = bufferingLogger();
 * log("processed", 3, "files");
 * log("done");
 * console.log(text()); // "processed 3 files\ndone"
 */
export function bufferingLogger(): { log: Logger; text(): string } {
  const lines: string[] = [];

  const log: Logger = (...a) => {
    lines.push(a.map(String).join(" "));
  };

  const text = () => lines.join("\n");

  return { log, text };
}
