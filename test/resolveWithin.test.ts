import * as path from "node:path";
import { expect } from "chai";
import { resolveWithin } from "../src/resolveWithin.js";

describe("resolveWithin", () => {
  const base = path.resolve("base");

  it("inside relative path → returns the resolved absolute path", () => {
    const result = resolveWithin(base, "child/file.txt");
    const expected = path.resolve(base, "child/file.txt");
    expect(result).to.equal(expected);
    expect(result).to.not.be.null;
    // confirm it starts with base
    expect(result!.startsWith(base)).to.be.true;
  });

  it('"../outside" → null', () => {
    const result = resolveWithin(base, "../outside");
    expect(result).to.be.null;
  });

  it("nested .. escape (a/../../escape) → null", () => {
    const result = resolveWithin(base, "a/../../escape");
    expect(result).to.be.null;
  });

  it('bare ".." (parent traversal) → null', () => {
    expect(resolveWithin(base, "..")).to.be.null;
  });

  it('".."-prefixed filename that stays inside base (..gitkeep) → returned, not rejected', () => {
    const result = resolveWithin(base, "..gitkeep");
    expect(result).to.equal(path.resolve(base, "..gitkeep"));
    expect(result).to.not.be.null;
    expect(result!.startsWith(base)).to.be.true;
  });

  it('"" → returns base (resolved)', () => {
    const result = resolveWithin(base, "");
    expect(result).to.equal(path.resolve(base));
  });

  it('"." → returns base (resolved)', () => {
    const result = resolveWithin(base, ".");
    expect(result).to.equal(path.resolve(base));
  });

  it("abs-inside: absolute path inside base → returns it", function () {
    if (process.platform === "win32") this.skip();
    const absInside = path.join(base, "child.txt");
    const result = resolveWithin(base, absInside);
    expect(result).to.equal(absInside);
  });

  it("abs-outside: absolute path clearly outside base → null", () => {
    const outsidePath =
      process.platform === "win32"
        ? path.resolve("C:\\Windows\\System32\\outside.txt")
        : "/etc/passwd";
    const result = resolveWithin(base, outsidePath);
    expect(result).to.be.null;
  });

  it("cross-drive: resolveWithin C:\\base, D:\\other → null", function () {
    if (process.platform !== "win32") this.skip();
    const result = resolveWithin("C:\\base", "D:\\other");
    expect(result).to.be.null;
  });
});
