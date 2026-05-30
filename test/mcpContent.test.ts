import { expect } from "chai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { paginatedContent } from "../src/mcpContent.js";

describe("paginatedContent", () => {
  it("returns correct text block for first page with limit", () => {
    // paginateText("a\nb\nc\n", { offset: 1, limit: 2 })
    //   => { text: "a\nb", totalLines: 3, offset: 1, limit: 2, hasMore: true }
    // returnedLines = 2, endLine = 1 + max(0, 2-1) = 1+1 = 2
    const result = paginatedContent("a\nb\nc\n", { offset: 1, limit: 2 });
    expect(result.content[0].type).to.equal("text");
    expect((result.content[0] as { text: string }).text).to.equal("a\nb\n\nlines: 1-2 / 3");
    expect(result.isError).to.equal(undefined);
  });

  it("returns correct text block for second page with limit", () => {
    // paginateText("a\nb\nc\n", { offset: 2, limit: 2 })
    //   => { text: "b\nc", totalLines: 3, offset: 2, limit: 2, hasMore: false }
    // returnedLines = 2, endLine = 2 + max(0, 2-1) = 2+1 = 3
    const result = paginatedContent("a\nb\nc\n", { offset: 2, limit: 2 });
    expect((result.content[0] as { text: string }).text).to.equal("b\nc\n\nlines: 2-3 / 3");
  });

  it("appends footer callback result after range footer", () => {
    // r.hasMore is true (endIndex 2 < totalLines 3)
    const result = paginatedContent(
      "a\nb\nc\n",
      { offset: 1, limit: 2 },
      (r) => "more: " + r.hasMore,
    );
    expect((result.content[0] as { text: string }).text).to.equal(
      "a\nb\n\nlines: 1-2 / 3\nmore: true",
    );
  });

  it("handles empty page (offset beyond total): 'lines: 0 / N', no leading blanks", () => {
    // paginateText("a\nb\nc\n", { offset: 5, limit: 2 })
    //   => { text: "", returnedLines: 0, totalLines: 3, offset: 5, ... }
    // An out-of-range page returns zero lines, so the footer reports a count
    // of 0 (not a misleading "5-5" range) and there is no page text to prefix.
    const result = paginatedContent("a\nb\nc\n", { offset: 5, limit: 2 });
    expect((result.content[0] as { text: string }).text).to.equal("lines: 0 / 3");
  });

  it("omits the range footer when neither offset nor limit is supplied", () => {
    const result = paginatedContent("a\nb\nc\n", {});
    expect((result.content[0] as { text: string }).text).to.equal("a\nb\nc");
  });

  it("still appends a footer callback when not paginated", () => {
    const result = paginatedContent("a\nb\nc\n", {}, () => "note");
    expect((result.content[0] as { text: string }).text).to.equal("a\nb\nc\nnote");
  });

  it("type-checks: return value is assignable to CallToolResult", () => {
    // Compile-time assertion; if it compiles the test passes.
    const _: CallToolResult = paginatedContent("a\n", { offset: 1 });
    expect(_.content).to.have.lengthOf(1);
  });
});
