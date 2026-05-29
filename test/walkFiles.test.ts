import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { walkFiles, _walkFilesHooks } from "../src/walkFiles.js";

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
    // ESM live bindings are read-only from consumers, so we cannot
    // monkey-patch fs.readdirSync directly. Instead we swap the property on
    // the _walkFilesHooks object, which is a plain mutable object whose
    // properties CAN be reassigned.
    const original = _walkFilesHooks.readdirSync;
    try {
      _walkFilesHooks.readdirSync = () => {
        const err = new Error("Permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      };
      expect(() => walkFiles(tmpDir, ".json")).to.throw("Permission denied");
    } finally {
      _walkFilesHooks.readdirSync = original;
    }
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
});
