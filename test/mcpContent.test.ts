import { expect } from "chai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { paginatedContent, mcpContent } from "../src/mcpContent.js";
import { mcpStructuredContent } from "../src/index.js";

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
    const result = paginatedContent("a\nb\nc\n", { offset: 1, limit: 2 }, (r) => "more: " + r.hasMore);
    expect((result.content[0] as { text: string }).text).to.equal("a\nb\n\nlines: 1-2 / 3\nmore: true");
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

describe("mcpContent", () => {
  it("text only (no footer) → single block with input text, isError is undefined", () => {
    const result = mcpContent("hello world");
    expect(result.content).to.have.lengthOf(1);
    expect(result.content[0].type).to.equal("text");
    expect((result.content[0] as { text: string }).text).to.equal("hello world");
    expect(result.isError).to.equal(undefined);
  });

  it("text + footer → joined by a single newline", () => {
    const result = mcpContent("result", "txId: 5");
    expect((result.content[0] as { text: string }).text).to.equal("result\ntxId: 5");
  });

  it("empty text + footer → footer only, no leading newline", () => {
    const result = mcpContent("", "txId: 5");
    expect((result.content[0] as { text: string }).text).to.equal("txId: 5");
  });

  it("explicit empty-string footer with non-empty text → trailing newline (documents !== undefined behavior)", () => {
    const result = mcpContent("result", "");
    expect((result.content[0] as { text: string }).text).to.equal("result\n");
  });

  it("type-checks: return value is assignable to CallToolResult, content has length 1", () => {
    // Compile-time assertion; if it compiles the test passes.
    const _: CallToolResult = mcpContent("data", "txId: 1");
    expect(_.content).to.have.lengthOf(1);
  });
});

describe("mcpStructuredContent", () => {
  const cases: Array<{ name: string; text: string; footer: string | undefined }> = [
    { name: "text + footer", text: "result", footer: "txId: 5" },
    { name: "empty text + footer", text: "", footer: "txId: 5" },
    { name: "text with no footer", text: "result", footer: undefined },
  ];

  for (const c of cases) {
    it(`function form: builder is called once with the joined text (${c.name})`, () => {
      const bodies: string[] = [];
      mcpStructuredContent(c.text, c.footer, (body) => {
        bodies.push(body);
        return { n: 1 };
      });
      expect(bodies).to.have.lengthOf(1);
      expect(bodies[0]).to.equal((mcpContent(c.text, c.footer).content[0] as { text: string }).text);
    });
  }

  it("function form: content equals mcpContent's and structuredContent is the builder's return value", () => {
    const payload = { clean: true, report: "ok" };
    const result = mcpStructuredContent("result", "txId: 5", () => payload);
    expect(result.content).to.deep.equal(mcpContent("result", "txId: 5").content);
    expect(result.structuredContent).to.equal(payload);
  });

  it("value form: content equals mcpContent's and structuredContent is the given object", () => {
    const payload = { clean: false, report: "bad" };
    const result = mcpStructuredContent("result", undefined, payload);
    expect(result.content).to.deep.equal(mcpContent("result").content);
    expect(result.structuredContent).to.equal(payload);
  });

  it("sets no isError key", () => {
    expect("isError" in mcpStructuredContent("a", "b", { x: 1 })).to.equal(false);
    expect("isError" in mcpStructuredContent("a", "b", () => ({ x: 1 }))).to.equal(false);
  });

  it("leaves mcpContent without a structuredContent key", () => {
    expect("structuredContent" in mcpContent("a", "b")).to.equal(false);
  });

  it("propagates an error thrown by the builder", () => {
    let message: string | undefined;
    try {
      mcpStructuredContent("a", "b", () => {
        throw new Error("builder failed");
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal("builder failed");
  });

  it("type-checks: result is a CallToolResult and structuredContent has the payload type", () => {
    const result = mcpStructuredContent("a", undefined, { clean: true, report: "r" });
    const asResult: CallToolResult = result;
    const report: string = result.structuredContent.report;
    expect(asResult.content).to.have.lengthOf(1);
    expect(report).to.equal("r");
  });

  describe("over InMemoryTransport with an outputSchema", () => {
    async function callTool(handler: () => CallToolResult) {
      const server = new McpServer({ name: "test", version: "0.0.0" });
      server.registerTool(
        "check",
        { outputSchema: { clean: z.boolean(), report: z.string() } },
        // The SDK types the callback result from the schema; the control
        // case deliberately returns a result without structuredContent.
        handler as never,
      );
      const client = new Client({ name: "client", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        return await client.callTool({ name: "check", arguments: {} });
      } finally {
        await client.close();
        await server.close();
      }
    }

    it("a result from mcpStructuredContent passes output validation", async () => {
      const res = await callTool(() => mcpStructuredContent("all clean", undefined, { clean: true, report: "none" }));
      expect(res.isError).to.not.equal(true);
      expect(res.structuredContent).to.deep.equal({ clean: true, report: "none" });
    });

    it("control: a result from mcpContent is rejected with an output validation error", async () => {
      const res = await callTool(() => mcpContent("all clean"));
      expect(res.isError).to.equal(true);
      expect(JSON.stringify(res.content)).to.include("Output validation error");
    });
  });
});
