import { expect } from "chai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpError, withMcpErrors } from "../src/mcpError.js";

describe("mcpError", () => {
  it("converts an Error to a CallToolResult with isError=true", () => {
    const result = mcpError(new Error("boom"));
    expect(result).to.deep.equal({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });

  it("converts a string using String(e)", () => {
    const result = mcpError("boom");
    expect(result).to.deep.equal({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });

  it("converts an arbitrary object via String(e)", () => {
    const result = mcpError({ toString() { return "objstr"; } });
    expect(result).to.deep.equal({
      content: [{ type: "text", text: "objstr" }],
      isError: true,
    });
  });

  it("appends extraLines joined by newline", () => {
    const result = mcpError(new Error("boom"), ["extra line"]);
    expect((result.content[0] as { text: string }).text).to.equal(
      "boom\nextra line"
    );
  });

  it("type-checks: return value is assignable to CallToolResult", () => {
    // This is a compile-time assertion; if it compiles the test passes.
    const _: CallToolResult = mcpError(new Error("x"));
    expect(_).to.have.property("isError", true);
  });
});

describe("withMcpErrors", () => {
  it("passes through the return value on success", async () => {
    const wrapped = withMcpErrors(async () => 42);
    const result = await wrapped();
    expect(result).to.equal(42);
  });

  it("catches a thrown error and returns a CallToolResult", async () => {
    const wrapped = withMcpErrors(async () => {
      throw new Error("fail");
    });
    const result = await wrapped();
    expect(result).to.deep.equal({
      content: [{ type: "text", text: "fail" }],
      isError: true,
    });
  });

  it("evaluates the extraLines thunk at catch time (not at wrap time)", async () => {
    const counter = { n: 0 };
    const fn = async () => {
      counter.n += 1;
      throw new Error("boom");
    };
    const wrapped = withMcpErrors(fn, () => [`count=${counter.n}`]);
    const result = await wrapped();
    // counter.n should be 1 (post-increment) when the thunk is called
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "boom\ncount=1",
    });
  });

  it("thunk is not called when no error is thrown", async () => {
    let thunkCalled = false;
    const wrapped = withMcpErrors(async () => "ok", () => {
      thunkCalled = true;
      return ["extra"];
    });
    await wrapped();
    expect(thunkCalled).to.be.false;
  });
});
