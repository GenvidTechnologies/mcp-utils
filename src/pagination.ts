/**
 * Pagination helpers for large text content.
 *
 * Line-counting contract: `"a\nb\n"` has 2 lines — a trailing newline does NOT
 * create an extra empty line. Internally, text is split by `"\n"` and any
 * trailing empty string produced by a final `"\n"` is discarded.
 */

export interface PaginationOptions {
  /** 1-based start line (default: 1) */
  offset?: number;
  /** Maximum lines to return (default: all) */
  limit?: number;
}

export interface PaginatedResult {
  /** The slice of text for the requested page */
  text: string;
  /** Total line count of the input (trailing newline does not add a line) */
  totalLines: number;
  /** Actual offset used (1 if not specified) */
  offset: number;
  /** Actual limit used (totalLines if not specified) */
  limit: number;
  /** True if there are more lines after this page */
  hasMore: boolean;
}

/**
 * Paginate `fullText` using 1-based `offset` and `limit`.
 *
 * Line-counting contract: a trailing `"\n"` is not counted as an extra line.
 *
 * @example
 * paginateText("a\nb\nc\n", { offset: 2, limit: 1 })
 * // => { text: "b", totalLines: 3, offset: 2, limit: 1, hasMore: true }
 */
export function paginateText(fullText: string, options: PaginationOptions): PaginatedResult {
  // Split and discard the trailing empty string produced by a terminal "\n"
  const rawLines = fullText.split("\n");
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
      ? rawLines.slice(0, -1)
      : rawLines;

  const totalLines = lines.length;
  const actualOffset = options.offset ?? 1;
  const actualLimit = options.limit ?? totalLines;

  // Convert 1-based offset to 0-based index
  const startIndex = actualOffset - 1;
  const endIndex = startIndex + actualLimit; // exclusive

  const pageLines = startIndex >= totalLines ? [] : lines.slice(startIndex, endIndex);
  const hasMore = endIndex < totalLines;

  return {
    text: pageLines.join("\n"),
    totalLines,
    offset: actualOffset,
    limit: actualLimit,
    hasMore,
  };
}
