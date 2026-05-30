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
 * 2. **Only when `offset` or `limit` was supplied** (i.e. the output was
 *    actually paginated): a blank-line separator (`"\n\n"`) and a range footer.
 *    - Non-empty page: `lines: <offset>-<offset+returnedLines-1> / <totalLines>`.
 *    - Empty/out-of-range page: `lines: 0 / <totalLines>` (no misleading range,
 *      and no leading blank lines since there is no page text).
 * 3. Optionally, if `footer` is provided, a newline followed by `footer(r)`
 *    where `r` is the full `PaginatedResult`. The footer callback always runs.
 *
 * When neither `offset` nor `limit` is supplied the whole text is returned with
 * no range footer — matching the consumer's `paginatedResponse`, which only
 * emits the footer when pagination narrowed the output.
 *
 * @param fullText   The full text to paginate.
 * @param options    Pagination options (`offset`, `limit`).
 * @param footer     Optional callback receiving the `PaginatedResult`; its
 *                   return value is appended on a new line.
 * @returns A `CallToolResult` with a single text content block. No `isError`
 *          field is set (this is always a success response).
 */
export function paginatedContent(
  fullText: string,
  options: PaginationOptions,
  footer?: (r: PaginatedResult) => string,
): CallToolResult {
  const page = paginateText(fullText, options);
  const paginated = options.offset !== undefined || options.limit !== undefined;

  let text = page.text;

  if (paginated) {
    const rangeFooterLine =
      page.returnedLines === 0
        ? `lines: 0 / ${page.totalLines}`
        : `lines: ${page.offset}-${page.offset + page.returnedLines - 1} / ${page.totalLines}`;
    text = text === "" ? rangeFooterLine : `${text}\n\n${rangeFooterLine}`;
  }

  if (footer) {
    const extra = footer(page);
    text = text === "" ? extra : `${text}\n${extra}`;
  }

  return {
    content: [{ type: "text", text }],
  };
}
