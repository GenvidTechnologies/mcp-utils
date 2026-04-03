import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exposeDocs } from "../src/exposeDocs.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "expose-docs-test-"));
}

describe("exposeDocs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when docs/ directory is missing", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => exposeDocs(server, tmpDir)).not.to.throw();
  });

  it("does not throw when README.md exists but docs/ is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello");
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => exposeDocs(server, tmpDir)).not.to.throw();
  });

  it("does not throw with README.md and docs/ containing markdown files", () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Readme");
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, "guide.md"), "# Guide");
    fs.writeFileSync(path.join(docsDir, "api.md"), "# API");

    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => exposeDocs(server, tmpDir)).not.to.throw();
  });

  it("does not throw when docs/ is empty", () => {
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => exposeDocs(server, tmpDir)).not.to.throw();
  });
});
