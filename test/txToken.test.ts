import { expect } from "chai";
import { formatTxToken, parseTxToken, compareTxToken, isValidProjectId } from "../src/txToken.js";

describe("formatTxToken", () => {
  it("formats a byte-exact token — the delimiter IS the contract", () => {
    expect(formatTxToken("alpha", 3)).to.equal("alpha:3");
  });

  it("accepts n: 0", () => {
    expect(formatTxToken("alpha", 0)).to.equal("alpha:0");
  });

  it("throws TypeError when the id contains ':'", () => {
    expect(() => formatTxToken("a:b", 1)).to.throw(TypeError);
  });

  it("throws TypeError when n is negative", () => {
    expect(() => formatTxToken("alpha", -1)).to.throw(TypeError);
  });

  it("throws TypeError when the id contains whitespace", () => {
    expect(() => formatTxToken("a b", 1)).to.throw(TypeError);
  });

  it("throws TypeError when the id is empty", () => {
    expect(() => formatTxToken("", 1)).to.throw(TypeError);
  });

  it("throws TypeError when n is not an integer", () => {
    expect(() => formatTxToken("alpha", 3.5)).to.throw(TypeError);
  });

  it("throws TypeError when n is not a safe integer", () => {
    expect(() => formatTxToken("alpha", Number.MAX_SAFE_INTEGER + 2)).to.throw(TypeError);
  });

  it("accepts n at MAX_SAFE_INTEGER", () => {
    expect(formatTxToken("alpha", Number.MAX_SAFE_INTEGER)).to.equal(`alpha:${Number.MAX_SAFE_INTEGER}`);
  });
});

describe("parseTxToken", () => {
  it("parses a well-formed token", () => {
    expect(parseTxToken("alpha:3")).to.deep.equal({ ok: true, projectId: "alpha", n: 3 });
  });

  it("rejects a token with no delimiter with reason 'no-separator', and does not throw", () => {
    expect(parseTxToken("garbage")).to.deep.equal({ ok: false, reason: "no-separator" });
  });

  it("rejects a token with an extra colon (split on the first ':') with reason 'invalid-counter-shape'", () => {
    expect(parseTxToken("a:b:c")).to.deep.equal({ ok: false, reason: "invalid-counter-shape" });
  });

  it("rejects the empty string with reason 'no-separator'", () => {
    expect(parseTxToken("")).to.deep.equal({ ok: false, reason: "no-separator" });
  });

  it("parses n: 0", () => {
    expect(parseTxToken("alpha:0")).to.deep.equal({ ok: true, projectId: "alpha", n: 0 });
  });

  it("parses n at MAX_SAFE_INTEGER", () => {
    expect(parseTxToken(`alpha:${Number.MAX_SAFE_INTEGER}`)).to.deep.equal({
      ok: true,
      projectId: "alpha",
      n: Number.MAX_SAFE_INTEGER,
    });
  });

  describe("the 7 malformed-shape cases pledged in A5 — all reject (ok: false)", () => {
    const cases = [
      "alpha:",
      "alpha:+3",
      "alpha: 3",
      "alpha:1e3",
      "alpha:0x10",
      "alpha:03",
      "alpha:9007199254740993",
    ];
    for (const token of cases) {
      it(`${JSON.stringify(token)} -> ok: false`, () => {
        const parsed = parseTxToken(token);
        expect(parsed.ok).to.equal(false);
      });
    }
  });

  describe("never throws for non-string input", () => {
    const nonStrings: unknown[] = [undefined, null, 42, {}, []];
    for (const value of nonStrings) {
      it(`${JSON.stringify(value === undefined ? "undefined" : value)} -> ok: false, reason: 'not-a-string'`, () => {
        expect(parseTxToken(value as unknown as string)).to.deep.equal({ ok: false, reason: "not-a-string" });
      });
    }
  });

  describe("round-trip invariant: format(parse(t)) === t for every token that parses", () => {
    const tokens = ["alpha:3", "alpha:0", `alpha:${Number.MAX_SAFE_INTEGER}`, "beta:12"];
    for (const token of tokens) {
      it(`holds for ${JSON.stringify(token)}`, () => {
        const parsed = parseTxToken(token);
        expect(parsed.ok).to.equal(true);
        if (!parsed.ok) throw new Error("unreachable");
        expect(formatTxToken(parsed.projectId, parsed.n)).to.equal(token);
      });
    }
  });
});

describe("compareTxToken", () => {
  it("returns true when projectId and n both match", () => {
    expect(compareTxToken("alpha:3", "alpha", 3)).to.equal(true);
  });

  it("returns false when the projectId differs — same counter, different project", () => {
    expect(compareTxToken("alpha:3", "beta", 3)).to.equal(false);
  });

  it("returns false when n differs", () => {
    expect(compareTxToken("alpha:3", "alpha", 4)).to.equal(false);
  });

  it("returns false (not throw) for a malformed token", () => {
    expect(compareTxToken("garbage", "alpha", 3)).to.equal(false);
  });

  describe("never throws for non-string token input, and always returns boolean", () => {
    const nonStrings: unknown[] = [undefined, null, 42, {}, []];
    for (const value of nonStrings) {
      it(`${JSON.stringify(value === undefined ? "undefined" : value)} -> false`, () => {
        expect(compareTxToken(value as unknown as string, "alpha", 3)).to.equal(false);
      });
    }
  });
});

describe("isValidProjectId", () => {
  it("returns true for a plain identifier", () => {
    expect(isValidProjectId("alpha")).to.equal(true);
  });

  it("returns false when it contains ':'", () => {
    expect(isValidProjectId("a:b")).to.equal(false);
  });

  it("returns false when it contains whitespace", () => {
    expect(isValidProjectId("a b")).to.equal(false);
  });

  it("returns false for the empty string", () => {
    expect(isValidProjectId("")).to.equal(false);
  });
});
