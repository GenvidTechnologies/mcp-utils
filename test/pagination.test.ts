import { expect } from "chai";
import { paginateText } from "../src/pagination.js";

const TEST_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

describe("paginateText", () => {
  it("returns lines 5–14 with offset: 5, limit: 10 (1-based)", () => {
    const result = paginateText(TEST_TEXT, { offset: 5, limit: 10 });
    const lines = result.text.split("\n");
    expect(lines).to.have.length(10);
    expect(lines[0]).to.equal("line 5");
    expect(lines[9]).to.equal("line 14");
    expect(result.offset).to.equal(5);
    expect(result.limit).to.equal(10);
    expect(result.totalLines).to.equal(20);
    expect(result.hasMore).to.be.true;
  });

  it("returns lines 5 to end with offset: 5, no limit", () => {
    const result = paginateText(TEST_TEXT, { offset: 5 });
    const lines = result.text.split("\n");
    expect(lines).to.have.length(16);
    expect(lines[0]).to.equal("line 5");
    expect(lines[15]).to.equal("line 20");
    expect(result.offset).to.equal(5);
    expect(result.limit).to.equal(20);
    expect(result.totalLines).to.equal(20);
    expect(result.hasMore).to.be.false;
  });

  it("returns first 10 lines with limit: 10, no offset", () => {
    const result = paginateText(TEST_TEXT, { limit: 10 });
    const lines = result.text.split("\n");
    expect(lines).to.have.length(10);
    expect(lines[0]).to.equal("line 1");
    expect(lines[9]).to.equal("line 10");
    expect(result.offset).to.equal(1);
    expect(result.limit).to.equal(10);
    expect(result.totalLines).to.equal(20);
    expect(result.hasMore).to.be.true;
  });

  it("returns full text when neither offset nor limit is provided", () => {
    const result = paginateText(TEST_TEXT, {});
    expect(result.text).to.equal(TEST_TEXT);
    expect(result.offset).to.equal(1);
    expect(result.limit).to.equal(20);
    expect(result.totalLines).to.equal(20);
    expect(result.hasMore).to.be.false;
  });

  it("totalLines always reflects the total count of input text", () => {
    const result = paginateText(TEST_TEXT, { offset: 10, limit: 3 });
    expect(result.totalLines).to.equal(20);
  });

  it("returns empty text when offset > totalLines", () => {
    const result = paginateText(TEST_TEXT, { offset: 25 });
    expect(result.text).to.equal("");
    expect(result.returnedLines).to.equal(0);
    expect(result.totalLines).to.equal(20);
    expect(result.hasMore).to.be.false;
  });

  it("returnedLines reflects the number of lines actually returned", () => {
    expect(paginateText(TEST_TEXT, { offset: 5, limit: 10 }).returnedLines).to.equal(10);
    expect(paginateText(TEST_TEXT, { offset: 19, limit: 10 }).returnedLines).to.equal(2);
    expect(paginateText(TEST_TEXT, {}).returnedLines).to.equal(20);
  });

  it("hasMore is true when there are lines after the returned range", () => {
    const resultWithMore = paginateText(TEST_TEXT, { offset: 1, limit: 19 });
    expect(resultWithMore.hasMore).to.be.true;

    const resultWithoutMore = paginateText(TEST_TEXT, { offset: 1, limit: 20 });
    expect(resultWithoutMore.hasMore).to.be.false;

    const resultExactEnd = paginateText(TEST_TEXT, { offset: 11, limit: 10 });
    expect(resultExactEnd.hasMore).to.be.false;
  });

  it("grep-then-paginate: totalLines reflects filtered count", () => {
    // Simulate grep: keep only odd-numbered lines (line 1, 3, 5, ..., 19) — 10 lines
    const filtered = TEST_TEXT.split("\n")
      .filter((_, i) => i % 2 === 0)
      .join("\n");

    const result = paginateText(filtered, { offset: 3, limit: 4 });
    // filtered lines: line 1, line 3, line 5, ..., line 19 (10 total)
    // offset 3 = "line 5", limit 4 = lines 5, 7, 9, 11
    const lines = result.text.split("\n");
    expect(lines).to.have.length(4);
    expect(lines[0]).to.equal("line 5");
    expect(lines[3]).to.equal("line 11");
    expect(result.totalLines).to.equal(10);
    expect(result.hasMore).to.be.true;
  });

  it("handles trailing newline correctly — does not count extra empty line", () => {
    const textWithTrailingNewline = TEST_TEXT + "\n";
    const result = paginateText(textWithTrailingNewline, {});
    expect(result.totalLines).to.equal(20);
    expect(result.text.split("\n")).to.have.length(20);
  });
});
