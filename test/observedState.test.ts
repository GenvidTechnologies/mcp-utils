import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObservedState, contentFingerprint, type Fingerprinter } from "../src/observedState.js";
import { toPosixPath } from "../src/strings.js";

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

  describe("directory classification", () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-dir-"));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function mkLink(target: string, link: string, ctx: Mocha.Context): void {
      try {
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "ENOSYS") ctx.skip();
        throw err;
      }
    }

    it("O12: the fingerprinter is never called with a directory path", () => {
      const dir = path.join(root, "d");
      const nested = path.join(root, "d", "n");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "f.txt"), "x");
      const called: string[] = [];
      const state = new ObservedState({
        fingerprint: (p) => {
          called.push(p);
          return "fp";
        },
      });
      state.record(dir);
      state.isChanged(dir);
      state.prime([root]);
      const dirs = new Set([dir, nested, root].map((d) => toPosixPath(d)));
      expect(called.filter((p) => dirs.has(toPosixPath(p)))).to.have.length(0);
      expect(called).to.have.length.greaterThan(0); // the file was fingerprinted
    });

    it("O20: a known directory marker reports unchanged", () => {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      const state = new ObservedState();
      state.record(dir);
      expect(state.isChanged(dir)).to.be.false;
      expect(state.isChanged(dir)).to.be.false;
    });

    it("O21: a live file replaced by a directory reports changed", () => {
      const p = path.join(root, "thing");
      fs.writeFileSync(p, "x");
      const state = new ObservedState();
      state.record(p);
      fs.rmSync(p);
      fs.mkdirSync(p);
      expect(state.isChanged(p)).to.be.true;
      expect(state.isChanged(p)).to.be.false; // now a known marker
    });

    it("O22: a directory marker now missing with no live children reports unchanged", () => {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      const state = new ObservedState();
      state.record(dir);
      fs.rmSync(dir, { recursive: true });
      expect(state.isChanged(dir)).to.be.false;
    });

    it("O23: a directory marker now missing with a live child reports changed and drops the child", () => {
      const dir = path.join(root, "d");
      const child = path.join(dir, "c.txt");
      fs.mkdirSync(dir);
      fs.writeFileSync(child, "same");
      const state = new ObservedState();
      state.record(dir);
      state.record(child);
      fs.rmSync(dir, { recursive: true });
      expect(state.isChanged(dir)).to.be.true;
      fs.mkdirSync(dir);
      fs.writeFileSync(child, "same");
      expect(state.isChanged(child)).to.be.true; // child entry was dropped
    });

    it("O24: a directory marker now missing on a lossy ledger reports changed", () => {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      const x = path.join(root, "x.txt");
      const y = path.join(root, "y.txt");
      fs.writeFileSync(x, "x");
      fs.writeFileSync(y, "y");
      const state = new ObservedState({ maxEntries: 1 });
      state.record(dir);
      state.record(x); // evicts the dir marker (not live; not lossy)
      state.record(y); // evicts a live file -> lossy
      state.record(dir);
      fs.rmSync(dir, { recursive: true });
      expect(state.isChanged(dir)).to.be.true;
    });

    it("O25: a directory marker now a file reports changed", () => {
      const p = path.join(root, "thing");
      fs.mkdirSync(p);
      const state = new ObservedState();
      state.record(p);
      fs.rmSync(p, { recursive: true });
      fs.writeFileSync(p, "x");
      expect(state.isChanged(p)).to.be.true;
    });

    it("O26: an unknown directory on an unprimed ledger reports changed", () => {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      const state = new ObservedState();
      expect(state.isChanged(dir)).to.be.true;
      expect(state.isChanged(dir)).to.be.false;
    });

    it("O27: an unknown directory under a primed root holding a new file reports changed", () => {
      const state = new ObservedState();
      state.prime([root]);
      const dir = path.join(root, "moved");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      expect(state.isChanged(dir)).to.be.true;
    });

    it("O28: an unknown directory under a primed root holding only recorded files reports unchanged", () => {
      const state = new ObservedState();
      state.prime([root]);
      const dir = path.join(root, "moved");
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "deep", "b.txt");
      fs.mkdirSync(path.join(dir, "deep"), { recursive: true });
      fs.writeFileSync(a, "a");
      fs.writeFileSync(b, "b");
      state.record(a);
      state.record(b);
      expect(state.isChanged(dir)).to.be.false;
    });

    it("O29: after a moved-in directory scan, an event on a child does not report changed", () => {
      const state = new ObservedState();
      state.prime([root]);
      const dir = path.join(root, "moved");
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      fs.mkdirSync(dir);
      fs.writeFileSync(a, "a");
      fs.writeFileSync(b, "b");
      expect(state.isChanged(dir)).to.be.true; // evaluates every file, no short-circuit
      expect(state.isChanged(a)).to.be.false;
      expect(state.isChanged(b)).to.be.false;
    });

    it("O30: an unknown directory under a primed root on a lossy ledger reports changed", () => {
      const f1 = path.join(root, "f1.txt");
      const f2 = path.join(root, "f2.txt");
      fs.writeFileSync(f1, "1");
      fs.writeFileSync(f2, "2");
      const state = new ObservedState({ maxEntries: 1 });
      expect(state.prime([root]).complete).to.be.false;
      const dir = path.join(root, "moved");
      fs.mkdirSync(dir);
      expect(state.isChanged(dir)).to.be.true;
    });

    it("O31: dropping entries under a directory does not drop a sibling sharing its prefix", () => {
      const sub = path.join(root, "sub");
      const subway = path.join(root, "subway");
      fs.mkdirSync(sub);
      fs.mkdirSync(subway);
      const inSub = path.join(sub, "f.txt");
      const inSubway = path.join(subway, "f.txt");
      fs.writeFileSync(inSub, "x");
      fs.writeFileSync(inSubway, "x");
      const state = new ObservedState();
      state.record(sub);
      state.record(inSub);
      state.record(inSubway);
      fs.rmSync(sub, { recursive: true });
      expect(state.isChanged(sub)).to.be.true;
      expect(state.isChanged(inSubway)).to.be.false; // survived
    });

    it("O32: a link to a directory is stored as a link marker and its removal reports changed", function () {
      const target = path.join(root, "target");
      const link = path.join(root, "link");
      fs.mkdirSync(target);
      mkLink(target, link, this);
      const called: string[] = [];
      const state = new ObservedState({
        fingerprint: (p) => {
          called.push(p);
          return "fp";
        },
      });
      state.record(link);
      expect(called).to.have.length(0);
      expect(state.isChanged(link)).to.be.false;
      fs.rmSync(link, { recursive: true });
      expect(state.isChanged(link)).to.be.true;
    });

    describe("orphaned descendants", () => {
      let tree: string;
      let outside: string;
      let d: string;
      let dOut: string;
      let x: string;

      beforeEach(() => {
        tree = path.join(root, "tree");
        outside = path.join(root, "outside");
        d = path.join(tree, "d");
        dOut = path.join(outside, "d");
        x = path.join(d, "x.json");
        fs.mkdirSync(d, { recursive: true });
        fs.mkdirSync(outside);
        fs.writeFileSync(x, "A");
      });

      it("O33: forget(dir), then move out and back in with identical files, reports the move-in changed", () => {
        const state = new ObservedState();
        state.prime([tree]);
        state.forget(d);
        fs.renameSync(d, dOut);
        state.isChanged(d); // move-out
        fs.renameSync(dOut, d);
        expect(state.isChanged(d)).to.be.true;
      });

      it("O34: a directory marker evicted without going lossy does not leave its children vouching for a move-in", () => {
        const state = new ObservedState({ maxEntries: 3 });
        expect(state.prime([tree]).complete).to.be.true; // d, d/x.json
        state.isChanged(path.join(tree, "q1")); // absent entry
        state.isChanged(path.join(tree, "q2")); // evicts d (a marker, so not lossy)
        state.isChanged(x); // keep x.json hot
        fs.renameSync(d, dOut);
        state.isChanged(d); // move-out
        fs.renameSync(dOut, d);
        expect(state.isChanged(d)).to.be.true;
      });

      it("O35: record(dir) after the directory became a file drops its children", () => {
        const state = new ObservedState();
        state.prime([tree]);
        fs.rmSync(d, { recursive: true, force: true });
        fs.writeFileSync(d, "file now");
        state.record(d); // self-write path
        fs.rmSync(d);
        expect(state.isChanged(d)).to.be.true; // the file is gone
        fs.mkdirSync(dOut);
        fs.writeFileSync(path.join(dOut, "x.json"), "A");
        fs.renameSync(dOut, d);
        expect(state.isChanged(d)).to.be.true;
      });

      it("O36: a modified known live file skips the descendant drop", () => {
        const f = path.join(tree, "f.txt");
        fs.writeFileSync(f, "one");
        const state = new ObservedState({
          fingerprint: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "absent"),
        });
        state.record(f);
        state.record(f + "/below"); // cannot exist on disk; planted to observe the drop
        const before = state.size;
        fs.writeFileSync(f, "two");
        expect(state.isChanged(f)).to.be.true;
        expect(state.size).to.equal(before); // planted entry survived: no drop for a live file
      });

      it("O37: forget(dir) removes the directory and every entry beneath it, but not a sibling", () => {
        const sibling = path.join(tree, "dx.txt");
        fs.mkdirSync(path.join(d, "nest"));
        fs.writeFileSync(path.join(d, "a.txt"), "a");
        fs.writeFileSync(path.join(d, "nest", "b.txt"), "b");
        fs.writeFileSync(sibling, "s");
        const state = new ObservedState();
        state.prime([tree]);
        const before = state.size;
        state.forget(d);
        // d, d/x.json, d/a.txt, d/nest, d/nest/b.txt are gone; the sibling dx.txt remains.
        expect(state.size).to.equal(before - 5);
        expect(state.isChanged(sibling)).to.be.false;
        expect(state.isChanged(path.join(d, "a.txt"))).to.be.true; // never seen again
      });
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

describe("ObservedState.prime", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-prime-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** root/a.txt, root/d1/b.txt, root/d2/c.txt: 3 files, 2 directories. */
  function makeTree(): void {
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.mkdirSync(path.join(root, "d1"));
    fs.writeFileSync(path.join(root, "d1", "b.txt"), "b");
    fs.mkdirSync(path.join(root, "d2"));
    fs.writeFileSync(path.join(root, "d2", "c.txt"), "c");
  }

  it("O9: reports complete with the default limit for 3 files and 2 directories", () => {
    makeTree();
    const state = new ObservedState();
    expect(state.prime([root])).to.deep.equal({ files: 3, directories: 2, complete: true });
    expect(state.size).to.equal(5);
  });

  it("O10: reports incomplete when maxEntries is smaller than the tree", () => {
    makeTree();
    const state = new ObservedState({ maxEntries: 3 });
    expect(state.prime([root]).complete).to.be.false;
  });

  it("O10: prime fills gaps only and does not overwrite an existing entry", () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "before");
    const state = new ObservedState();
    state.record(file);
    fs.writeFileSync(file, "after");
    state.prime([root]);
    // An overwriting prime would store the "after" fingerprint and report false here.
    expect(state.isChanged(file)).to.be.true;
  });

  it("prime of a missing root counts as empty and complete", () => {
    const state = new ObservedState();
    expect(state.prime([path.join(root, "nope")])).to.deep.equal({
      files: 0,
      directories: 0,
      complete: true,
    });
  });

  it("prime with a throwing fingerprinter does not throw and is incomplete", () => {
    makeTree();
    const state = new ObservedState({
      fingerprint: () => {
        throw new Error("boom");
      },
    });
    let summary: ReturnType<ObservedState["prime"]> | undefined;
    expect(() => {
      summary = state.prime([root]);
    }).to.not.throw();
    expect(summary?.complete).to.be.false;
  });
});
