import { expect } from "chai";
import * as path from "node:path";
import * as fs from "node:fs";
import { resolveRootFolder, type ResolveRootFolderOpts } from "../src/resolveRootFolder.js";
import { isMcpError } from "../src/loadProjectConfig.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the text content from a CallToolResult error. */
function errorText(result: unknown): string {
  const r = result as CallToolResult;
  return (r.content[0] as { text: string }).text;
}

/**
 * Build a fake fs.Dirent-like entry for use in stub readdir implementations.
 * Only the fields used by resolveRootFolder are populated.
 */
function makeDirent(name: string, type: "file" | "dir"): fs.Dirent {
  return {
    name,
    isDirectory: () => type === "dir",
    isFile: () => type === "file",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: "",
    parentPath: "",
  } as unknown as fs.Dirent;
}

/**
 * Build a stub readdir that returns pre-configured entries per directory.
 * Any directory NOT in the map throws ENOENT (treated as absent).
 */
function makeStubReaddir(
  map: Record<string, fs.Dirent[]>,
): (dir: string, opts: { withFileTypes: true }) => fs.Dirent[] {
  return (dir: string) => {
    const normalised = path.normalize(dir);
    if (Object.prototype.hasOwnProperty.call(map, normalised)) {
      return map[normalised];
    }
    const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resolveRootFolder", () => {
  // Use path.resolve so the absolute path includes the drive letter on Windows
  // (path.normalize("/fake/cwd") → "\fake\cwd" which is NOT the same as
  // path.resolve("/fake/cwd") → "C:\fake\cwd" on Windows).
  const CWD = path.resolve("/fake/cwd");
  const MARKER = "project.c3proj";

  // -------------------------------------------------------------------------
  // explicit source
  // -------------------------------------------------------------------------

  it("explicit absolute path → source 'explicit', path unchanged", () => {
    const explicitPath = path.resolve("/some/other/dir");
    const opts: ResolveRootFolderOpts = {
      explicit: explicitPath,
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("explicit");
    expect(r.path).to.equal(explicitPath);
  });

  it("explicit relative path → resolved against cwd, source 'explicit'", () => {
    const opts: ResolveRootFolderOpts = {
      explicit: "relative/subdir",
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("explicit");
    expect(r.path).to.equal(path.resolve(CWD, "relative/subdir"));
    expect(path.isAbsolute(r.path)).to.be.true;
  });

  it("explicit '../sibling' (escapes cwd) is allowed", () => {
    const opts: ResolveRootFolderOpts = {
      explicit: "../sibling",
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("explicit");
    expect(r.path).to.equal(path.resolve(CWD, "../sibling"));
  });

  it("explicit empty string → falls through to lower precedence", () => {
    // empty explicit → should fall through to cwd fallback (no marker anywhere)
    const opts: ResolveRootFolderOpts = {
      explicit: "",
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [], // cwd has no marker
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  it("explicit whitespace-only string → falls through (treated as unset)", () => {
    const opts: ResolveRootFolderOpts = {
      explicit: "   ",
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  // -------------------------------------------------------------------------
  // env source
  // -------------------------------------------------------------------------

  it("env var set → source 'env', path resolved", () => {
    const envPath = path.resolve("/from/env/dir");
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: envPath };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("env");
    expect(r.path).to.equal(envPath);
  });

  it("env var set to relative path → resolved against cwd", () => {
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: "env/relative" };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("env");
    expect(r.path).to.equal(path.resolve(CWD, "env/relative"));
  });

  it("env var empty string → skipped, falls through", () => {
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: "" };
    const readdir = makeStubReaddir({
      [CWD]: [],
    });
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  it("env var whitespace-only → skipped, falls through", () => {
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: "   " };
    const readdir = makeStubReaddir({
      [CWD]: [],
    });
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  it("env var unset → skipped, falls through", () => {
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = {}; // MY_PROJECT_DIR not present
    const readdir = makeStubReaddir({
      [CWD]: [],
    });
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  // -------------------------------------------------------------------------
  // Precedence: explicit > env > discovery > cwd
  // -------------------------------------------------------------------------

  it("explicit beats env: both set → explicit wins", () => {
    const opts: ResolveRootFolderOpts = {
      explicit: path.resolve("/explicit/path"),
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: path.resolve("/env/path") };
    const readdir = makeStubReaddir({});
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("explicit");
    expect(r.path).to.equal(path.resolve("/explicit/path"));
  });

  it("env beats discovery: env set and marker found → env wins", () => {
    const childWithMarker = path.join(CWD, "childA");
    const opts: ResolveRootFolderOpts = {
      envVar: "MY_PROJECT_DIR",
      marker: MARKER,
      cwd: CWD,
    };
    const env = { MY_PROJECT_DIR: path.resolve("/env/path") };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      [childWithMarker]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("env");
    expect(r.path).to.equal(path.resolve("/env/path"));
  });

  it("discovery beats cwd fallback: marker found → discovery, not cwd", () => {
    const childWithMarker = path.join(CWD, "childA");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      [childWithMarker]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(childWithMarker);
  });

  // -------------------------------------------------------------------------
  // Discovery: cwd contains marker (depth 0)
  // -------------------------------------------------------------------------

  it("cwd contains marker → source 'discovery', path = cwd", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent(MARKER, "file"), makeDirent("src", "dir")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(CWD);
  });

  it("cwd contains marker as dir entry → source 'discovery' (matches by name, not type)", () => {
    const opts: ResolveRootFolderOpts = {
      marker: ".git",
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent(".git", "dir")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(CWD);
  });

  // -------------------------------------------------------------------------
  // Discovery: depth 1 search
  // -------------------------------------------------------------------------

  it("single marker dir at depth 1 → source 'discovery', returns that dir", () => {
    const childA = path.join(CWD, "childA");
    const childB = path.join(CWD, "childB");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      // cwd has no marker, two child dirs
      [CWD]: [makeDirent("childA", "dir"), makeDirent("childB", "dir")],
      // childA has the marker, childB does not
      [childA]: [makeDirent(MARKER, "file"), makeDirent("src", "dir")],
      [childB]: [makeDirent("other.txt", "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(childA);
  });

  it("marker found only in a file (not dir) entry → still counts as a match", () => {
    // marker check is by name regardless of file vs dir
    const childA = path.join(CWD, "childA");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      [childA]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(childA);
  });

  // -------------------------------------------------------------------------
  // Discovery: depth 2 / searchDepth
  // -------------------------------------------------------------------------

  it("marker at depth 2 missed when searchDepth=1 (default) → cwd fallback", () => {
    const childA = path.join(CWD, "childA");
    const grandChild = path.join(childA, "grand");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      // searchDepth defaults to 1 — depth 2 not searched
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      // childA has no marker, just a subdir
      [childA]: [makeDirent("grand", "dir")],
      // grandChild has the marker — but it's at depth 2, not searched
      [grandChild]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  it("marker at depth 2 found when searchDepth=2", () => {
    const childA = path.join(CWD, "childA");
    const grandChild = path.join(childA, "grand");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      searchDepth: 2,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      [childA]: [makeDirent("grand", "dir")],
      [grandChild]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(grandChild);
  });

  it("searchDepth=0 → only cwd (depth 0) checked, children not scanned → cwd fallback", () => {
    // cwd has no marker; childA does — but searchDepth=0 means no descent, so
    // the child is never scanned and we fall back to cwd.
    const childA = path.join(CWD, "childA");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      searchDepth: 0,
    };
    let childScanned = false;
    const stubbedReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const normalised = path.normalize(dir);
      if (normalised === CWD) {
        return [makeDirent("childA", "dir")];
      }
      if (normalised === childA) {
        childScanned = true;
        return [makeDirent(MARKER, "file")];
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = resolveRootFolder(opts, {}, stubbedReaddir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
    expect(r.path).to.equal(CWD);
    // Depth-0-only: children must not be scanned at all.
    expect(childScanned).to.be.false;
  });

  it("searchDepth=0 → cwd marker still found at depth 0", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      searchDepth: 0,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(CWD);
  });

  // -------------------------------------------------------------------------
  // Discovery: ambiguous (≥2 matches)
  // -------------------------------------------------------------------------

  it("two marker dirs (siblings) → mcpError, isMcpError true, mentions ambiguous", () => {
    const childA = path.join(CWD, "childA");
    const childB = path.join(CWD, "childB");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir"), makeDirent("childB", "dir")],
      [childA]: [makeDirent(MARKER, "file")],
      [childB]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.true;
    const text = errorText(result);
    expect(text).to.include("resolveRootFolder");
    expect(text).to.include("ambiguous");
    expect(text).to.include(MARKER);
    // The matching paths should be in the extra lines
    expect(text).to.include(childA);
    expect(text).to.include(childB);
  });

  it("ambiguous: match count included in error message", () => {
    const childA = path.join(CWD, "childA");
    const childB = path.join(CWD, "childB");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir"), makeDirent("childB", "dir")],
      [childA]: [makeDirent(MARKER, "file")],
      [childB]: [makeDirent(MARKER, "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("2");
  });

  // -------------------------------------------------------------------------
  // cwd fallback
  // -------------------------------------------------------------------------

  it("nothing found anywhere → source 'cwd', path = cwd", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const readdir = makeStubReaddir({
      [CWD]: [makeDirent("childA", "dir")],
      [path.join(CWD, "childA")]: [makeDirent("readme.txt", "file")],
    });
    const result = resolveRootFolder(opts, {}, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
    expect(r.path).to.equal(CWD);
  });

  it("no envVar option → env lookup skipped entirely", () => {
    // No envVar in opts, so even if env has something it should be ignored
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      // no envVar
    };
    const env = { MY_PROJECT_DIR: path.normalize("/env/path") };
    const readdir = makeStubReaddir({
      [CWD]: [],
    });
    const result = resolveRootFolder(opts, env, readdir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
  });

  // -------------------------------------------------------------------------
  // empty / whitespace marker
  // -------------------------------------------------------------------------

  it("empty marker → mcpError, mentions 'marker is required'", () => {
    const opts: ResolveRootFolderOpts = {
      marker: "",
      cwd: CWD,
    };
    const result = resolveRootFolder(opts, {}, makeStubReaddir({}));
    expect(isMcpError(result)).to.be.true;
    const text = errorText(result);
    expect(text).to.include("resolveRootFolder");
    expect(text).to.include("marker is required");
  });

  it("whitespace-only marker → mcpError", () => {
    const opts: ResolveRootFolderOpts = {
      marker: "   ",
      cwd: CWD,
    };
    const result = resolveRootFolder(opts, {}, makeStubReaddir({}));
    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("marker is required");
  });

  // -------------------------------------------------------------------------
  // Error handling: non-ENOENT readdir error
  // -------------------------------------------------------------------------

  it("non-ENOENT readdir error at cwd level → mcpError, does not throw", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    const throwingReaddir = (_dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const err = new Error("Permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    // Must not throw — must return mcpError
    let result: unknown;
    expect(() => {
      result = resolveRootFolder(opts, {}, throwingReaddir);
    }).to.not.throw();
    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("resolveRootFolder");
  });

  it("non-ENOENT readdir error during child scan → mcpError, does not throw", () => {
    const childA = path.join(CWD, "childA");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    // cwd readdir succeeds but child fails with EACCES
    const stubbedReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const normalised = path.normalize(dir);
      if (normalised === CWD) {
        return [makeDirent("childA", "dir")];
      }
      if (normalised === childA) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      const err = new Error(`ENOENT: no such file or directory`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    let result: unknown;
    expect(() => {
      result = resolveRootFolder(opts, {}, stubbedReaddir);
    }).to.not.throw();
    expect(isMcpError(result)).to.be.true;
    expect(errorText(result)).to.include("resolveRootFolder");
  });

  // -------------------------------------------------------------------------
  // ENOENT during discovery → treated as no match, not an error
  // -------------------------------------------------------------------------

  it("ENOENT during child directory scan → treated as no-match, falls through to cwd", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
    };
    // cwd lists a child dir but that child throws ENOENT when scanned
    const stubbedReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const normalised = path.normalize(dir);
      if (normalised === CWD) {
        return [makeDirent("childA", "dir")];
      }
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = resolveRootFolder(opts, {}, stubbedReaddir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
    expect(r.path).to.equal(CWD);
  });

  // -------------------------------------------------------------------------
  // Default cwd
  // -------------------------------------------------------------------------

  it("no cwd opt → defaults to process.cwd(), source 'cwd' when no marker", () => {
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      // no cwd
    };
    const processCwd = path.normalize(process.cwd());
    // Stub readdir: cwd (process.cwd()) returns no marker
    const stubbedReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const normalised = path.normalize(dir);
      if (normalised === processCwd) {
        return []; // no marker
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = resolveRootFolder(opts, {}, stubbedReaddir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("cwd");
    expect(r.path).to.equal(processCwd);
  });

  // -------------------------------------------------------------------------
  // Matched directory does not recurse deeper (match short-circuits subtree)
  // -------------------------------------------------------------------------

  it("matched directory at depth 1 is not further recursed (subtree short-circuited)", () => {
    // childA matches — its children should NOT be scanned
    // childB also has marker at depth 2 (child of child) — should not be found since we only descend into dirs that did NOT match
    const childA = path.join(CWD, "childA");
    const childAChild = path.join(childA, "sub");
    const opts: ResolveRootFolderOpts = {
      marker: MARKER,
      cwd: CWD,
      searchDepth: 2,
    };
    let subScanned = false;
    const stubbedReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      const normalised = path.normalize(dir);
      if (normalised === CWD) {
        return [makeDirent("childA", "dir")];
      }
      if (normalised === childA) {
        // childA has the marker AND a subdirectory
        return [makeDirent(MARKER, "file"), makeDirent("sub", "dir")];
      }
      if (normalised === childAChild) {
        subScanned = true;
        return [makeDirent(MARKER, "file")];
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = resolveRootFolder(opts, {}, stubbedReaddir);
    expect(isMcpError(result)).to.be.false;
    const r = result as { path: string; source: string };
    expect(r.source).to.equal("discovery");
    expect(r.path).to.equal(childA);
    // Subtree of matched dir must NOT be scanned
    expect(subScanned).to.be.false;
  });
});
