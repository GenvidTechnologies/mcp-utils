/**
 * MCP response helpers for paginated text content.
 *
 * `paginatedContent` consolidates the page text and a range-footer line into a
 * **single** MCP content block (one `{ type: "text", text }` entry), joined
 * with `"\n\n"`. This mirrors the footer-line format used by the consumer's
 * `paginatedResponse` helper (construct3-chef `server.ts`) but collapses the
 * two content blocks into one.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { paginateText, type PaginationOptions, type PaginatedResult } from "./pagination.js";

/**
 * Paginate `fullText` and return a single-block `CallToolResult`.
 *
 * The returned content block contains:
 * 1. The page text from `paginateText`.
 * 2. A blank line separator (`"\n\n"`).
 * 3. A range-footer line: `lines: <offset>-<endLine> / <totalLines>`.
 * 4. Optionally, if `footer` is provided, a newline followed by the string
 *    returned by `footer(r)` where `r` is the full `PaginatedResult`.
 *
 * The range-footer line format matches the consumer reference exactly:
 * ```
 * const returnedLines = page.text === "" ? 0 : page.text.split("\n").length;
 * const endLine = page.offset + Math.max(0, returnedLines - 1);
 * // → `lines: ${page.offset}-${endLine} / ${page.totalLines}`
 * ```
 *
 * The range footer is always included regardless of whether `offset`/`limit`
 * were supplied.
 *
 * @param fullText   The full text to paginate.
 * @param options    Pagination options (`offset`, `limit`).
 * @param footer     Optional callback receiving the `PaginatedResult`; its
 *                   return value is appended after the range footer on a new
 *                   line.
 * @returns A `CallToolResult` with a single text content block. No `isError`
 *          field is set (this is always a success response).
 */
export function paginatedContent(
  fullText: string,
  options: PaginationOptions,
  footer?: (r: PaginatedResult) => string,
): CallToolResult {
  const page = paginateText(fullText, options);

  const returnedLines = page.text === "" ? 0 : page.text.split("\n").length;
  const endLine = page.offset + Math.max(0, returnedLines - 1);
  const rangeFooterLine = `lines: ${page.offset}-${endLine} / ${page.totalLines}`;

  let text = page.text + "\n\n" + rangeFooterLine;
  if (footer) {
    text = text + "\n" + footer(page);
  }

  return {
    content: [{ type: "text", text }],
  };
}
