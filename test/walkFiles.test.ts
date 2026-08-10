import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { walkFiles } from "../src/walkFiles.js";

/**
 * Creates a symlink, skipping the calling test on platforms that refuse to make
 * one (Windows without Developer Mode or elevation, filesystems with no symlink
 * support). On win32 a directory link is created as a **junction**, which never
 * requires elevation and produces the same dirent shape these tests exercise:
 * `isDirectory()` is `false` and `isSymbolicLink()` is `true`.
 */
function symlinkOrSkip(
  ctx: Mocha.Context,
  target: string,
  linkPath: string,
  kind: "file" | "dir"
): void {
  const type = kind === "dir" && process.platform === "win32" ? "junction" : kind;
  try {
    fs.symlinkSync(target, linkPath, type);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      ctx.skip();
    }
    throw err;
  }
}

describe("walkFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walkfiles-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns matching files by string suffix filter", () => {
    // Build a nested tree: a.json, sub/b.json, sub/c.txt
    fs.writeFileSync(path.join(tmpDir, "a.json"), "{}");
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "b.json"), "{}");
    fs.writeFileSync(path.join(subDir, "c.txt"), "hello");

    const result = walkFiles(tmpDir, ".json").sort();
    const expected = [path.join(tmpDir, "a.json"), path.join(subDir, "b.json")].sort();
    expect(result).to.deep.equal(expected);
  });

  it("returns matching files using a predicate filter", () => {
    fs.writeFileSync(path.join(tmpDir, "a.json"), "{}");
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "b.json"), "{}");
    fs.writeFileSync(path.join(subDir, "c.txt"), "hello");

    const result = walkFiles(tmpDir, (p) => p.endsWith("c.txt"));
    expect(result).to.deep.equal([path.join(subDir, "c.txt")]);
  });

  it("returns [] for a missing directory, no throw", () => {
    const missing = path.join(tmpDir, "no", "such", "dir");
    const result = walkFiles(missing, ".json");
    expect(result).to.deep.equal([]);
  });

  it("propagates non-ENOENT errors (e.g. EACCES)", () => {
    // ESM namespace members can't be monkey-patched, so inject a stub reader
    // via the optional `readdir` parameter to simulate a permission error.
    const throwingReaddir = (): fs.Dirent[] => {
      const err = new Error("Permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    expect(() => walkFiles(tmpDir, ".json", throwingReaddir)).to.throw("Permission denied");
  });

  it("does not recurse into symlinked directories", function () {
    const realSubDir = path.join(tmpDir, "real");
    fs.mkdirSync(realSubDir);
    fs.writeFileSync(path.join(realSubDir, "secret.json"), "{}");

    const linkDir = path.join(tmpDir, "link");
    try {
      fs.symlinkSync(realSubDir, linkDir, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOSYS") {
        this.skip();
        return;
      }
      throw err;
    }

    // walkFiles on tmpDir should find secret.json under real/ but NOT under link/
    const result = walkFiles(tmpDir, ".json").sort();
    const expected = [path.join(realSubDir, "secret.json")];
    expect(result).to.deep.equal(expected);
  });

  it("does not return a directory symlink whose name matches the predicate", function () {
    const realFile = path.join(tmpDir, "real.json");
    fs.writeFileSync(realFile, "{}");
    const target = path.join(tmpDir, "sometree");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "inner.json"), "{}");

    // A directory link *named* like a match: the predicate would accept it, so
    // only the file-vs-directory classification can keep it out of the result.
    symlinkOrSkip(this, target, path.join(tmpDir, "linked.json"), "dir");

    const result = walkFiles(tmpDir, ".json").sort();
    const expected = [realFile, path.join(target, "inner.json")].sort();
    expect(result).to.deep.equal(expected);
  });

  it("returns a symlink that points at a regular file", function () {
    const realFile = path.join(tmpDir, "real.json");
    fs.writeFileSync(realFile, "{}");
    const link = path.join(tmpDir, "linked.json");
    symlinkOrSkip(this, realFile, link, "file");

    // Regression guard: a symlink to a regular file is readable, so it must stay
    // in the result. A bare `entry.isFile()` check would silently drop it.
    const result = walkFiles(tmpDir, ".json").sort();
    expect(result).to.deep.equal([realFile, link].sort());
  });

  it("does not return a broken symlink", function () {
    const realFile = path.join(tmpDir, "real.json");
    fs.writeFileSync(realFile, "{}");
    symlinkOrSkip(
      this,
      path.join(tmpDir, "missing-target"),
      path.join(tmpDir, "broken.json"),
      "file"
    );

    const result = walkFiles(tmpDir, ".json");
    expect(result).to.deep.equal([realFile]);
  });

  it("completes the walk when a symlink cycle matches the predicate", function () {
    const realFile = path.join(tmpDir, "real.json");
    fs.writeFileSync(realFile, "{}");
    const a = path.join(tmpDir, "a.json");
    const b = path.join(tmpDir, "b.json");
    symlinkOrSkip(this, b, a, "file"); // a -> b, dangling until b exists
    symlinkOrSkip(this, a, b, "file"); // b -> a, closing the cycle

    // Resolving either link raises ELOOP, which `throwIfNoEntry: false` does not
    // suppress — the walk must absorb it rather than propagate it to the caller.
    let result: string[] = [];
    expect(() => {
      result = walkFiles(tmpDir, ".json");
    }).to.not.throw();
    expect(result).to.deep.equal([realFile]);
  });
});
