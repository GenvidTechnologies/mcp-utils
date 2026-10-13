import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObservedState, contentFingerprint, type Fingerprinter } from "../src/observedState.js";

describe("ObservedState", () => {
  it("isChanged on a never-seen path returns true", () => {
    const os1 = new ObservedState({ fingerprint: () => "x" });
    expect(os1.isChanged("a.json")).to.be.true;
  });

  it("record then isChanged with an unchanged fingerprint returns false", () => {
    const os1 = new ObservedState({ fingerprint: () => "x" });
    os1.record("a.json");
    expect(os1.isChanged("a.json")).to.be.false;
  });

  it("isChanged reports true, then false, across a changed fingerprint", () => {
    let value = "a";
    const fingerprint: Fingerprinter = () => value;
    const os1 = new ObservedState({ fingerprint });
    expect(os1.isChanged("a.json")).to.be.true; // never seen
    value = "b";
    expect(os1.isChanged("a.json")).to.be.true; // changed since last record
    expect(os1.isChanged("a.json")).to.be.false; // unchanged since previous call
  });

  it("scripted fingerprints across three calls all report changed", () => {
    const scripted = ["a", "b", "c"];
    let i = 0;
    const fingerprint: Fingerprinter = () => scripted[i++];
    const os1 = new ObservedState({ fingerprint });
    expect(os1.isChanged("a.json")).to.be.true;
    expect(os1.isChanged("a.json")).to.be.true;
    expect(os1.isChanged("a.json")).to.be.true;
  });

  it("forget removes an entry so the next isChanged reports true again", () => {
    const os1 = new ObservedState({ fingerprint: () => "x" });
    os1.record("a.json");
    expect(os1.size).to.equal(1);
    os1.forget("a.json");
    expect(os1.size).to.equal(0);
    expect(os1.isChanged("a.json")).to.be.true;
  });

  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const os1 = new ObservedState({ fingerprint: () => "x", maxEntries: 2 });
    os1.record("a.json");
    os1.record("b.json");
    os1.record("c.json"); // evicts a.json (least recently used)
    expect(os1.size).to.equal(2);
    // a.json was evicted, so it looks never-seen again -> reports changed
    expect(os1.isChanged("a.json")).to.be.true;
  });

  describe("real-fs pins", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observedstate-pin-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("O3: a path recorded as a directory then replaced by a file reports changed", () => {
      const target = path.join(tmpDir, "thing");
      fs.mkdirSync(target);
      const state = new ObservedState();
      state.record(target);
      fs.rmSync(target, { recursive: true });
      fs.writeFileSync(target, "now a file");
      expect(state.isChanged(target)).to.be.true;
    });

    it("O15: a self-referencing link (ELOOP) reports changed on every call", function () {
      const link = path.join(tmpDir, "loop");
      try {
        fs.symlinkSync(link, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "ENOSYS") this.skip();
        throw err;
      }
      const state = new ObservedState();
      expect(state.isChanged(link)).to.be.true;
      expect(state.isChanged(link)).to.be.true;
    });
  });

  describe("contentFingerprint", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observedstate-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns distinct digests for distinct content", () => {
      const fileA = path.join(tmpDir, "a.txt");
      const fileB = path.join(tmpDir, "b.txt");
      fs.writeFileSync(fileA, "hello");
      fs.writeFileSync(fileB, "world");
      expect(contentFingerprint(fileA)).to.not.equal(contentFingerprint(fileB));
    });

    it("returns identical digests for identical content", () => {
      const fileA = path.join(tmpDir, "a.txt");
      const fileB = path.join(tmpDir, "b.txt");
      fs.writeFileSync(fileA, "same content");
      fs.writeFileSync(fileB, "same content");
      expect(contentFingerprint(fileA)).to.equal(contentFingerprint(fileB));
    });

    it("returns 'absent' for a missing path", () => {
      const missing = path.join(tmpDir, "does-not-exist.txt");
      expect(contentFingerprint(missing)).to.equal("absent");
    });

    it("returns a unique token per call for a non-ENOENT error, failing open", () => {
      // Reading a directory as a file fails with EISDIR, not ENOENT.
      const first = contentFingerprint(tmpDir);
      const second = contentFingerprint(tmpDir);
      expect(first).to.not.equal("absent");
      expect(second).to.not.equal("absent");
      expect(first).to.not.equal(second);
    });
  });
});
