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
    const result = mcpError({
      toString() {
        return "objstr";
      },
    });
    expect(result).to.deep.equal({
      content: [{ type: "text", text: "objstr" }],
      isError: true,
    });
  });

  it("appends extraLines joined by newline", () => {
    const result = mcpError(new Error("boom"), ["extra line"]);
    expect((result.content[0] as { text: string }).text).to.equal("boom\nextra line");
  });

  it("type-checks: return value is assignable to CallToolResult", () => {
    // This is a compile-time assertion; if it compiles the test passes.
    const _: CallToolResult = mcpError(new Error("x"));
    expect(_).to.have.property("isError", true);
  });

  // Options object form
  it("options: { prefix } prepends prefix with a single space", () => {
    const result = mcpError(new Error("boom"), { prefix: "Error:" });
    expect((result.content[0] as { text: string }).text).to.equal("Error: boom");
  });

  it("options: { prefix, extraLines } prepends prefix and appends extraLines", () => {
    const result = mcpError(new Error("boom"), {
      prefix: "Error:",
      extraLines: ["txId: 5"],
    });
    expect((result.content[0] as { text: string }).text).to.equal("Error: boom\ntxId: 5");
  });

  it("options: { extraLines } without prefix matches legacy array form", () => {
    const legacy = mcpError(new Error("boom"), ["x"]);
    const opts = mcpError(new Error("boom"), { extraLines: ["x"] });
    expect((opts.content[0] as { text: string }).text).to.equal((legacy.content[0] as { text: string }).text);
  });

  it("options: { prefix: '' } produces no prefix and no leading space", () => {
    const result = mcpError(new Error("boom"), { prefix: "" });
    expect((result.content[0] as { text: string }).text).to.equal("boom");
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
    const wrapped = withMcpErrors(
      async () => "ok",
      () => {
        thunkCalled = true;
        return ["extra"];
      },
    );
    await wrapped();
    expect(thunkCalled).to.be.false;
  });

  // Options object form — onError hook
  it("onError is invoked with the caught error before formatting", async () => {
    let bumped = false;
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("fail");
      },
      {
        onError: (_err) => {
          bumped = true;
        },
      },
    );
    const result = await wrapped();
    expect(bumped).to.be.true;
    expect((result as CallToolResult).isError).to.be.true;
  });

  it("onError is NOT called on the success path", async () => {
    let onErrorCalled = false;
    const wrapped = withMcpErrors(async () => "ok", {
      onError: () => {
        onErrorCalled = true;
      },
    });
    await wrapped();
    expect(onErrorCalled).to.be.false;
  });

  it("async onError is awaited before the result is returned", async () => {
    let flagSet = false;
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("async-fail");
      },
      {
        onError: async () => {
          await Promise.resolve();
          flagSet = true;
        },
      },
    );
    const result = await wrapped();
    expect(flagSet).to.be.true;
    expect((result as CallToolResult).isError).to.be.true;
  });

  it("when onError throws, the thrown value is formatted and withMcpErrors does not reject", async () => {
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("original");
      },
      {
        onError: () => {
          throw new Error("hook-threw");
        },
      },
    );
    const result = await wrapped();
    expect((result as CallToolResult).isError).to.be.true;
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "hook-threw",
    });
  });

  it("options: prefix passthrough — result text starts with the prefix", async () => {
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("something");
      },
      { prefix: "Error:" },
    );
    const result = await wrapped();
    const text = ((result as CallToolResult).content[0] as { text: string }).text;
    expect(text).to.equal("Error: something");
  });

  it("legacy thunk form still works alongside options form (independent)", async () => {
    // Confirm legacy thunk still produces the right output
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("boom");
      },
      () => ["leg"],
    );
    const result = await wrapped();
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "boom\nleg",
    });
  });

  it("options: onError + extraLines — extraLines appended after error message", async () => {
    let sideEffect = false;
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("err");
      },
      {
        onError: () => {
          sideEffect = true;
        },
        extraLines: () => ["extra"],
      },
    );
    const result = await wrapped();
    expect(sideEffect).to.be.true;
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "err\nextra",
    });
  });

  it("legacy thunk that throws degrades gracefully (no extra lines, does not reject)", async () => {
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("primary");
      },
      () => {
        throw new Error("thunk-threw");
      },
    );
    const result = await wrapped();
    // The primary error is still reported; the throwing thunk contributes nothing.
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "primary",
    });
  });

  it("options: extraLines thunk that throws degrades gracefully (still never throws out)", async () => {
    const wrapped = withMcpErrors(
      async () => {
        throw new Error("primary");
      },
      {
        prefix: "Error:",
        extraLines: () => {
          throw new Error("thunk-threw");
        },
      },
    );
    const result = await wrapped();
    // Prefix still applies; the throwing extraLines thunk is dropped.
    expect((result as CallToolResult).content[0]).to.deep.equal({
      type: "text",
      text: "Error: primary",
    });
  });
});
