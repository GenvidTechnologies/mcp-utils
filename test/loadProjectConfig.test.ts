import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { loadProjectConfig, isMcpError } from "../src/loadProjectConfig.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the text content from a CallToolResult error. */
function errorText(result: unknown): string {
  const r = result as CallToolResult;
  return (r.content[0] as { text: string }).text;
}

/** Minimal test schema. */
const BaseSchema = z.object({
  host: z.string(),
  port: z.number(),
});
type BaseConfig = z.infer<typeof BaseSchema>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("loadProjectConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lpc-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("happy path: valid file → returns parsed T", async () => {
    const config: BaseConfig = { host: "localhost", port: 8080 };
    await fs.promises.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(config));

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema);

    expect(isMcpError(result)).to.be.false;
    expect(result).to.deep.equal(config);
  });

  // -------------------------------------------------------------------------
  // Precedence: opts.defaults < file < overrides
  // -------------------------------------------------------------------------

  it("precedence: opts.defaults < file < overrides", async () => {
    // defaults has all three keys set; file overrides 'port'; overrides overrides 'host'
    const defaults: Partial<BaseConfig> = { host: "defaults-host", port: 1000 };
    const fileContent: Partial<BaseConfig> = { host: "file-host", port: 2000 };
    const overrides: Partial<BaseConfig> = { host: "override-host" };

    await fs.promises.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(fileContent));

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema, overrides, { defaults });

    expect(isMcpError(result)).to.be.false;
    const cfg = result as BaseConfig;
    // overrides wins for 'host'
    expect(cfg.host).to.equal("override-host");
    // file wins for 'port' (override didn't set it, defaults had 1000 but file has 2000)
    expect(cfg.port).to.equal(2000);
  });

  // -------------------------------------------------------------------------
  // Schema .default() fills a missing field
  // -------------------------------------------------------------------------

  it("schema .default() fills a field absent from defaults/file/overrides", async () => {
    const SchemaWithDefault = z.object({
      host: z.string(),
      port: z.number().default(9999),
    });

    // File only has 'host'
    await fs.promises.writeFile(path.join(tmpDir, "config.json"), JSON.stringify({ host: "example.com" }));

    const result = await loadProjectConfig(tmpDir, "config.json", SchemaWithDefault);

    expect(isMcpError(result)).to.be.false;
    const cfg = result as z.infer<typeof SchemaWithDefault>;
    expect(cfg.host).to.equal("example.com");
    expect(cfg.port).to.equal(9999);
  });

  // -------------------------------------------------------------------------
  // optional: true + missing file → returns schema-applied defaults
  // -------------------------------------------------------------------------

  it("optional: true + missing file → returns defaults, not an error", async () => {
    const SchemaAllDefault = z.object({
      host: z.string().default("default-host"),
      port: z.number().default(3000),
    });

    const result = await loadProjectConfig(tmpDir, "nonexistent.json", SchemaAllDefault, undefined, { optional: true });

    expect(isMcpError(result)).to.be.false;
    const cfg = result as z.infer<typeof SchemaAllDefault>;
    expect(cfg.host).to.equal("default-host");
    expect(cfg.port).to.equal(3000);
  });

  it("optional: true + missing file + opts.defaults → merges defaults with schema defaults", async () => {
    const SchemaWithDefault = z.object({
      host: z.string(),
      port: z.number().default(4000),
    });

    const result = await loadProjectConfig(tmpDir, "nonexistent.json", SchemaWithDefault, undefined, {
      optional: true,
      defaults: { host: "from-opts-defaults" },
    });

    expect(isMcpError(result)).to.be.false;
    const cfg = result as z.infer<typeof SchemaWithDefault>;
    expect(cfg.host).to.equal("from-opts-defaults");
    expect(cfg.port).to.equal(4000);
  });

  // -------------------------------------------------------------------------
  // not optional + missing file → isMcpError
  // -------------------------------------------------------------------------

  it("not optional + missing file → isMcpError true", async () => {
    const result = await loadProjectConfig(tmpDir, "nonexistent.json", BaseSchema);

    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("loadProjectConfig(nonexistent.json)");
  });

  // -------------------------------------------------------------------------
  // Malformed JSON
  // -------------------------------------------------------------------------

  it("malformed JSON file → isMcpError true", async () => {
    await fs.promises.writeFile(path.join(tmpDir, "config.json"), "{ not valid json }");

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema);

    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("loadProjectConfig(config.json)");
  });

  // -------------------------------------------------------------------------
  // Schema validation failure
  // -------------------------------------------------------------------------

  it("schema validation failure → isMcpError true, mentions offending field", async () => {
    // port should be a number but we write a string
    await fs.promises.writeFile(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ host: "localhost", port: "not-a-number" }),
    );

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema);

    expect(isMcpError(result)).to.be.true;
    const text = errorText(result);
    expect(text).to.include("loadProjectConfig(config.json)");
    // The zod issue line should mention the 'port' field
    expect(text).to.include("port");
  });

  // -------------------------------------------------------------------------
  // containedPaths
  // -------------------------------------------------------------------------

  it("containedPaths: value inside projectRoot → ok, returns T", async () => {
    const PathSchema = z.object({
      outputDir: z.string(),
      name: z.string(),
    });

    await fs.promises.writeFile(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ outputDir: "subdir/output", name: "test" }),
    );

    const result = await loadProjectConfig(tmpDir, "config.json", PathSchema, undefined, {
      containedPaths: ["outputDir"],
    });

    expect(isMcpError(result)).to.be.false;
    const cfg = result as z.infer<typeof PathSchema>;
    // The value is assert-only — it is NOT rewritten to absolute
    expect(cfg.outputDir).to.equal("subdir/output");
  });

  it("containedPaths: value escaping via ../ → isMcpError true", async () => {
    const PathSchema = z.object({
      outputDir: z.string(),
      name: z.string(),
    });

    await fs.promises.writeFile(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ outputDir: "../escape", name: "test" }),
    );

    const result = await loadProjectConfig(tmpDir, "config.json", PathSchema, undefined, {
      containedPaths: ["outputDir"],
    });

    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("loadProjectConfig(config.json)");
    expect(errorText(result)).to.include("outputDir");
  });

  it("containedPaths: non-string values are skipped (not checked)", async () => {
    // Port is a number — containedPaths on it should not crash or reject
    await fs.promises.writeFile(path.join(tmpDir, "config.json"), JSON.stringify({ host: "localhost", port: 8080 }));

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema, undefined, { containedPaths: ["port"] });

    // Non-string value → skipped, result is T
    expect(isMcpError(result)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // readFile seam
  // -------------------------------------------------------------------------

  it("readFile seam: stub rejects with EACCES → isMcpError true", async () => {
    const stubReadFile = (_p: string, _enc: "utf-8"): Promise<string> => {
      const err = new Error("Permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      return Promise.reject(err);
    };

    const result = await loadProjectConfig(tmpDir, "config.json", BaseSchema, undefined, undefined, stubReadFile);

    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("loadProjectConfig(config.json)");
  });

  it("readFile seam: stub that returns valid JSON → uses its content", async () => {
    const stubReadFile = (_p: string, _enc: "utf-8"): Promise<string> => {
      return Promise.resolve(JSON.stringify({ host: "stubbed", port: 1234 }));
    };

    const result = await loadProjectConfig(
      tmpDir,
      "this-file-does-not-exist.json",
      BaseSchema,
      undefined,
      undefined,
      stubReadFile,
    );

    expect(isMcpError(result)).to.be.false;
    const cfg = result as BaseConfig;
    expect(cfg.host).to.equal("stubbed");
    expect(cfg.port).to.equal(1234);
  });

  // -------------------------------------------------------------------------
  // Error message prefix
  // -------------------------------------------------------------------------

  it("all errors include the loadProjectConfig(<fileName>) prefix", async () => {
    // Test with a custom fileName to confirm the prefix uses the passed fileName
    await fs.promises.writeFile(path.join(tmpDir, "my-config.json"), "INVALID");

    const result = await loadProjectConfig(tmpDir, "my-config.json", BaseSchema);

    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("loadProjectConfig(my-config.json)");
  });
});

// ---------------------------------------------------------------------------
// isMcpError
// ---------------------------------------------------------------------------

describe("isMcpError", () => {
  it("returns true for an object with isError === true", () => {
    const errResult = { content: [{ type: "text", text: "boom" }], isError: true };
    expect(isMcpError(errResult)).to.be.true;
  });

  it("returns false for a plain config object (no isError)", () => {
    const cfg: BaseConfig = { host: "localhost", port: 8080 };
    expect(isMcpError(cfg)).to.be.false;
  });

  it("returns false for null", () => {
    expect(isMcpError(null)).to.be.false;
  });

  it("returns false for undefined", () => {
    expect(isMcpError(undefined)).to.be.false;
  });

  it("returns false for a number", () => {
    expect(isMcpError(42)).to.be.false;
  });

  it("returns false for an object with isError === false", () => {
    expect(isMcpError({ isError: false })).to.be.false;
  });

  it("returns false for an object with isError as string 'true'", () => {
    expect(isMcpError({ isError: "true" })).to.be.false;
  });

  it("returns true for a real mcpError() result", async () => {
    // Import mcpError to verify the actual shape matches
    const { mcpError } = await import("../src/mcpError.js");
    const result = mcpError(new Error("test"));
    expect(isMcpError(result)).to.be.true;
  });
});
