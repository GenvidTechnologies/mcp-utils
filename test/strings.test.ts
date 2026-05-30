import { expect } from "chai";
import { escapeRegExp, toPosixPath } from "../src/strings.js";

describe("escapeRegExp", () => {
  it("returns empty string unchanged", () => {
    expect(escapeRegExp("")).to.equal("");
  });

  it("returns strings with no metacharacters unchanged", () => {
    expect(escapeRegExp("hello world")).to.equal("hello world");
    expect(escapeRegExp("abc123")).to.equal("abc123");
  });

  it("round-trips every metacharacter so the result matches the literal character", () => {
    const metachars = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"];
    for (const c of metachars) {
      const escaped = escapeRegExp(c);
      const re = new RegExp(escaped);
      expect(re.test(c), `metachar '${c}' should match itself after escaping`).to.be.true;
    }
  });

  it("does not match unintended characters when metachar is escaped", () => {
    // '.' escaped should not match 'a'
    const escaped = escapeRegExp(".");
    const re = new RegExp(`^${escaped}$`);
    expect(re.test("a")).to.be.false;
    expect(re.test(".")).to.be.true;
  });

  it("escapes a string with mixed metacharacters and literals", () => {
    const input = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    const escaped = escapeRegExp(input);
    const re = new RegExp(`^${escaped}$`);
    expect(re.test(input)).to.be.true;
  });
});

describe("toPosixPath", () => {
  it("returns empty string unchanged", () => {
    expect(toPosixPath("")).to.equal("");
  });

  it("returns a path with no backslashes unchanged", () => {
    expect(toPosixPath("a/b/c")).to.equal("a/b/c");
  });

  it("converts backslashes to forward slashes", () => {
    expect(toPosixPath("a\\b\\c")).to.equal("a/b/c");
  });

  it("converts mixed separators", () => {
    expect(toPosixPath("a\\b/c\\d")).to.equal("a/b/c/d");
  });

  it("converts Windows absolute paths", () => {
    expect(toPosixPath("C:\\Users\\foo\\bar.txt")).to.equal("C:/Users/foo/bar.txt");
  });
});
