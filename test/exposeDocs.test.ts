import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { exposeDocs } from "../src/exposeDocs.js";
import type { ExposeDocsOptions } from "../src/exposeDocs.js";

/**
 * Await `p`, returning the rejection message, or `null` if it resolved.
 * `chai-as-promised` is not a dependency here, and this package is
 * deliberately dependency-light — a local helper is cheaper than adding one.
 */
async function rejectionMessage(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

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

describe("exposeDocs — document set and resource behaviour", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write `content` to `rel` under tmpDir, creating parent directories. */
  function write(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Connect a client to a server with exposeDocs registered, over memory. */
  async function connect(options?: ExposeDocsOptions): Promise<Client> {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    exposeDocs(server, tmpDir, options);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  /** The text of the single content block returned for `uri`. */
  async function readText(client: Client, uri: string): Promise<string> {
    const result = await client.readResource({ uri });
    const block = result.contents[0];
    // `contents` is a text-or-blob union; exposeDocs only ever emits text.
    expect(block, `expected a content block for ${uri}`).to.not.equal(undefined);
    expect(block, `expected a text block for ${uri}`).to.have.property("text");
    return String((block as { text: unknown }).text);
  }

  it("serves a flat document at its unchanged URI", async () => {
    write("docs/guide.md", "# Guide");
    const client = await connect();
    expect(await readText(client, "docs:///guide")).to.equal("# Guide");
  });

  it("serves from an alternate directory named by docsDir", async () => {
    write("wiki/guide.md", "# Wiki guide");
    const client = await connect({ docsDir: "wiki" });
    expect(await readText(client, "docs:///guide")).to.equal("# Wiki guide");
  });

  it("serves a nested document at its path-shaped URI when recursive", async () => {
    write("wiki/reference/cli.md", "# CLI");
    write("wiki/index.md", "# Index");
    const client = await connect({ docsDir: "wiki", recursive: true });
    expect(await readText(client, "docs:///reference/cli")).to.equal("# CLI");
    expect(await readText(client, "docs:///index")).to.equal("# Index");
  });

  it("keeps nested names addressable at every depth", async () => {
    write("docs/a/b/c/deep.md", "# Deep");
    const client = await connect({ recursive: true });
    expect(await readText(client, "docs:///a/b/c/deep")).to.equal("# Deep");
  });

  it("enumerates every document through resources/list", async () => {
    write("wiki/index.md", "# Index");
    write("wiki/reference/cli.md", "# CLI");
    write("wiki/reference/ops.md", "# Ops");
    const client = await connect({ docsDir: "wiki", recursive: true });

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).to.include("docs:///index");
    expect(uris).to.include("docs:///reference/cli");
    expect(uris).to.include("docs:///reference/ops");
  });

  it("lists nothing from the template when the directory is missing", async () => {
    const client = await connect({ docsDir: "absent" });
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris.filter((u) => u !== "docs:///readme")).to.deep.equal([]);
  });

  it("omits nested documents from the listing when not recursive", async () => {
    write("docs/flat.md", "# Flat");
    write("docs/nested/deep.md", "# Deep");
    const client = await connect();

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).to.include("docs:///flat");
    expect(uris).not.to.include("docs:///nested/deep");
  });

  it("refuses to serve a nested document when not recursive", async () => {
    write("docs/nested/deep.md", "# Deep");
    const client = await connect();
    const message = await rejectionMessage(client.readResource({ uri: "docs:///nested/deep" }));
    expect(message, "expected the nested read to be refused").to.be.a("string");
    expect(message).to.match(/non-recursively/);
  });

  it("never serves a document from outside the documentation directory", async () => {
    write("docs/guide.md", "# Guide");
    fs.writeFileSync(path.join(tmpDir, "secret.md"), "TOP SECRET");
    const client = await connect({ recursive: true });

    // Note *how* these are refused, because it is not what it looks like. The
    // SDK builds `new URL(uri)` and matches the template against the
    // *normalised* form, so RFC 3986 collapses the `..` segments before the
    // template is consulted at all: `docs:///../secret` arrives as
    // `docs:///secret`. Each of these therefore fails as an ordinary
    // not-found *inside* docsDir, never reaching the resolveWithin guard.
    // The guard is defence in depth against that normalisation not holding —
    // see ADR-0003 — which is why this asserts the outcome (nothing outside
    // docsDir is ever served) rather than the guard's own message.
    for (const uri of [
      "docs:///../secret",
      "docs:///a/../../secret",
      "docs:///../../../etc/passwd",
      "docs:///..%2F..%2Fsecret",
    ]) {
      const message = await rejectionMessage(client.readResource({ uri }));
      expect(message, `expected ${uri} to be refused`).to.be.a("string");
      expect(message).to.match(/not found/);
    }
  });

  it("does not leak file content through a traversal", async () => {
    write("docs/guide.md", "# Guide");
    fs.writeFileSync(path.join(tmpDir, "secret.md"), "TOP SECRET");
    const client = await connect({ recursive: true });

    let leaked = "";
    try {
      leaked = await readText(client, "docs:///../secret");
    } catch {
      leaked = "";
    }
    expect(leaked).to.not.contain("TOP SECRET");
  });

  it("raises a typed error, not a raw ENOENT, for an unknown name", async () => {
    write("docs/guide.md", "# Guide");
    const client = await connect();

    const message = await rejectionMessage(client.readResource({ uri: "docs:///missing" }));
    expect(message, "expected the unknown read to be refused").to.be.a("string");
    expect(message).to.match(/not found/);
    // The point of the criterion: a typed protocol error, not a raw filesystem
    // failure carrying an absolute host path back to the client.
    expect(message).to.not.match(/ENOENT/);
    expect(message).to.not.contain(tmpDir);
  });

  it("does not offer a directory whose name ends in .md", async () => {
    write("docs/real.md", "# Real");
    fs.mkdirSync(path.join(tmpDir, "docs", "decoy.md"));
    const client = await connect();

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).to.include("docs:///real");
    expect(uris).not.to.include("docs:///decoy");
  });

  it("builds nested names with forward slashes on every platform", async () => {
    write("docs/reference/cli.md", "# CLI");
    const client = await connect({ recursive: true });

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).to.include("docs:///reference/cli");
    expect(uris.some((u) => u.includes("\\"))).to.equal(false);
  });
});
