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

    it("O44: prime leaves a stale file entry at a path that is now a directory to the event path", () => {
      const r = path.join(root, "r");
      const out = path.join(root, "out");
      const D = path.join(r, "D");
      fs.mkdirSync(r);
      fs.mkdirSync(out);
      fs.writeFileSync(D, "x");
      const state = new ObservedState();
      state.prime([r]);
      state.record(D);
      fs.rmSync(D);
      fs.mkdirSync(D);
      fs.writeFileSync(path.join(D, "a.txt"), "A");
      state.prime([r]);
      // prime neither overwrote the file entry nor descended into D, so the event path sees a
      // live file replaced by a directory: an extra bump (fail-open), not a silent baseline.
      expect(state.isChanged(D)).to.be.true;
      fs.renameSync(D, path.join(out, "D"));
      state.isChanged(D);
      fs.renameSync(path.join(out, "D"), D);
      expect(state.isChanged(D)).to.be.true;
    });

    it("O50: a first prime does not descend into a path recorded as a file that is now a directory", () => {
      const r = path.join(root, "r");
      const out = path.join(root, "out");
      const D = path.join(r, "D");
      fs.mkdirSync(r);
      fs.mkdirSync(out);
      fs.writeFileSync(D, "x");
      const state = new ObservedState();
      state.record(D); // recorded as a file, before any prime
      fs.rmSync(D);
      fs.mkdirSync(D);
      fs.writeFileSync(path.join(D, "a.txt"), "A");
      const summary = state.prime([r]);
      // D's entry conflicts with the disk, so prime neither records nor descends into it.
      expect(summary).to.deep.equal({ files: 0, directories: 0, complete: true });
      // Move out and back with no event in between the prime and the move-out.
      fs.renameSync(D, path.join(out, "D"));
      expect(state.isChanged(D)).to.be.true;
      fs.renameSync(path.join(out, "D"), D);
      // Had prime recorded a.txt under the stale file entry, it would match here and read unchanged.
      expect(state.isChanged(D)).to.be.true;
    });

    it("O51: a child recorded beneath a stale file entry is dropped when that path goes missing", () => {
      const r = path.join(root, "r");
      const out = path.join(root, "out");
      const D = path.join(r, "D");
      const a = path.join(D, "a.txt");
      fs.mkdirSync(r);
      fs.mkdirSync(out);
      fs.writeFileSync(D, "x");
      const state = new ObservedState();
      state.prime([r]); // D recorded as a file
      fs.rmSync(D);
      fs.mkdirSync(D);
      fs.writeFileSync(a, "A");
      state.isChanged(a); // the child's own event arrives first and records it
      fs.renameSync(D, path.join(out, "D")); // one event, for D
      expect(state.isChanged(D)).to.be.true;
      fs.renameSync(path.join(out, "D"), D);
      // The orphaned a.txt must not vouch for the directory coming back.
      expect(state.isChanged(D)).to.be.true;
    });

    it("O47: a root passed with a trailing slash still vouches for a never-seen directory beneath it", () => {
      const r = path.join(root, "r");
      const D = path.join(r, "D");
      fs.mkdirSync(r);
      const state = new ObservedState();
      state.prime([r + "/"]);
      fs.mkdirSync(D);
      fs.writeFileSync(path.join(D, "a.txt"), "A");
      state.record(path.join(D, "a.txt"));
      // Vouched: the scan finds only an already-accounted file. An unvouched directory is always changed.
      expect(state.isChanged(D)).to.be.false;
    });

    it("O48: prime skips a subtree already under a primed root", () => {
      const r = path.join(root, "r");
      const sub = path.join(r, "sub");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(root, "top.txt"), "t");
      const state = new ObservedState();
      state.prime([sub]);
      const late = path.join(sub, "late.txt");
      fs.writeFileSync(late, "L"); // no event: another owner's queued event must still see it as new
      state.prime([sub]); // the same root again
      expect(state.isChanged(late)).to.be.true;
      const late2 = path.join(sub, "late2.txt");
      fs.writeFileSync(late2, "L2");
      const summary = state.prime([root]); // an ancestor: sub is not descended into
      expect(summary.files).to.equal(1); // top.txt only
      expect(state.isChanged(late2)).to.be.true;
      expect(state.isChanged(path.join(root, "top.txt"))).to.be.false;
    });

    it("O49: prime leaves a directory marker whose identity no longer matches the disk", () => {
      const r = path.join(root, "r");
      const D = path.join(r, "D");
      const X = path.join(root, "X");
      fs.mkdirSync(D, { recursive: true });
      fs.mkdirSync(X);
      fs.writeFileSync(path.join(X, "a.txt"), "A");
      const state = new ObservedState();
      state.record(D);
      fs.renameSync(D, path.join(root, "Dold"));
      fs.renameSync(X, D);
      state.prime([r]);
      // Untouched marker: the event path sees a different directory and reports it.
      expect(state.isChanged(D)).to.be.true;
    });

    it("O45: removing a directory that holds only a link reads as changed", function () {
      const r = path.join(root, "r");
      const D = path.join(r, "D");
      const target = path.join(root, "target");
      fs.mkdirSync(D, { recursive: true });
      fs.mkdirSync(target);
      mkLink(target, path.join(D, "L"), this);
      const state = new ObservedState();
      state.prime([r]);
      fs.renameSync(D, path.join(root, "moved"));
      expect(state.isChanged(D)).to.be.true;
    });

    it("O46: a trailing slash does not create a second key", () => {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "x");
      const state = new ObservedState();
      state.record(dir + "/");
      const size = state.size;
      state.record(dir);
      expect(state.size).to.equal(size);
      expect(state.isChanged(dir + "/")).to.equal(state.isChanged(dir));
    });

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
        const before = state.size;
        state.record(d); // self-write path
        // d becomes a file entry; its one child (x.json) is dropped by record itself.
        expect(state.size).to.equal(before - 1);
        fs.rmSync(d);
        expect(state.isChanged(d)).to.be.true; // the file is gone
        fs.mkdirSync(dOut);
        fs.writeFileSync(path.join(dOut, "x.json"), "A");
        fs.renameSync(dOut, d);
        expect(state.isChanged(d)).to.be.true;
      });

      it("O36: entries beneath a modified known file are orphans and are dropped", () => {
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
        // A file cannot have children, so the planted entry is an orphan and goes.
        expect(state.size).to.equal(before - 1);
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

      it("O38: a directory moved in by a self-write and recorded, then moved out, reports changed", () => {
        const r = path.join(root, "r");
        const staging = path.join(outside, "staging");
        fs.mkdirSync(r);
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "a.txt"), "A");
        const state = new ObservedState();
        state.prime([r]);
        const moved = path.join(r, "D");
        fs.renameSync(staging, moved);
        state.record(moved); // a suppressed self-write: records the directory and its children
        fs.renameSync(moved, path.join(outside, "D2"));
        expect(state.isChanged(moved)).to.be.true;
      });

      describe("directory swapped by rename", () => {
        const swapIn = (state: ObservedState, files: Record<string, string>): string => {
          const r = path.join(root, "r");
          const dir = path.join(r, "D");
          fs.renameSync(dir, path.join(outside, "Dold"));
          const staging = path.join(outside, "staging");
          fs.mkdirSync(staging);
          for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(staging, n), c);
          fs.renameSync(staging, dir);
          return dir;
        };
        const setup = (): ObservedState => {
          const dir = path.join(root, "r", "D");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "a.txt"), "A");
          fs.writeFileSync(path.join(dir, "c.txt"), "C");
          const state = new ObservedState();
          state.prime([path.join(root, "r")]);
          return state;
        };

        it("O39: one event on a directory swapped by two renames reports changed (added file; removal only)", () => {
          const added = setup();
          const dir = swapIn(added, { "a.txt": "A", "b.txt": "B" });
          expect(added.isChanged(dir)).to.be.true;
          fs.rmSync(path.join(root, "r"), { recursive: true, force: true });
          fs.rmSync(path.join(outside, "Dold"), { recursive: true, force: true });
          const removed = setup();
          const dir2 = swapIn(removed, { "a.txt": "A" });
          // a.txt is byte-identical: only the old subtree's drop (c.txt was live) can report this.
          expect(removed.isChanged(dir2)).to.be.true;
          expect(removed.isChanged(dir2)).to.be.false; // settled
        });
      });

      it("O40: listing, reading, writing and deleting inside a primed directory keeps its identity", () => {
        const state = new ObservedState();
        state.prime([tree]);
        fs.readdirSync(d);
        fs.readFileSync(x);
        const tmp = path.join(d, "tmp.txt");
        fs.writeFileSync(tmp, "t");
        fs.rmSync(tmp);
        expect(state.isChanged(d)).to.be.false;
      });

      it("O41: evicting a directory's children then forgetting it leaves a consistent ledger", () => {
        const y = path.join(d, "y.json");
        fs.writeFileSync(y, "Y");
        const state = new ObservedState({ maxEntries: 4 });
        state.prime([tree]); // d, d/x.json, d/y.json
        state.isChanged(d); // d is now most recent: x.json is the oldest
        state.isChanged(path.join(tree, "q1"));
        state.isChanged(path.join(tree, "q2")); // evicts x.json
        state.forget(d);
        expect(state.size).to.equal(2); // q1, q2: d and y.json gone, evicted x.json not resurrected
        state.record(x);
        expect(state.size).to.equal(3);
        fs.renameSync(d, dOut);
        // x.json is dropped (live, so changed); q1 and q2 are not dropped.
        expect(state.isChanged(d)).to.be.true;
        expect(state.size).to.equal(3); // q1, q2 and d's absent entry
        fs.renameSync(dOut, d);
        expect(state.isChanged(x)).to.be.true; // dropped, so re-evaluated
      });

      it("O42: children whose directory marker was evicted are still found by its move-out", () => {
        const state = new ObservedState({ maxEntries: 4 });
        state.prime([tree]); // d, d/x.json
        state.isChanged(path.join(tree, "q1"));
        state.isChanged(path.join(tree, "q2"));
        state.isChanged(path.join(tree, "q3")); // evicts d (a marker)
        state.isChanged(x); // keep x.json hot
        fs.renameSync(d, dOut);
        expect(state.isChanged(d)).to.be.true;
        fs.renameSync(dOut, d);
        // Had x.json survived the move-out it would still match "A" and report unchanged.
        expect(state.isChanged(x)).to.be.true;
      });

      it("O43: a directory swapped while its marker was evicted is not matched against the old children", () => {
        const c = path.join(d, "c.txt");
        fs.writeFileSync(c, "C");
        const state = new ObservedState({ maxEntries: 5 });
        state.prime([tree]); // d, d/c.txt, d/x.json
        state.isChanged(path.join(tree, "q1"));
        state.isChanged(path.join(tree, "q2"));
        state.isChanged(path.join(tree, "q3")); // evicts d (a marker), not lossy
        state.isChanged(x); // keep both children hot
        state.isChanged(c);
        // Swap d for a directory holding only an identical x.json: c.txt is gone.
        fs.renameSync(d, dOut);
        fs.mkdirSync(d);
        fs.writeFileSync(x, "A");
        expect(state.isChanged(d)).to.be.true;
      });
    });
  });

  describe("directory round trips (ctime re-check)", () => {
    let base: string;
    const R = (n: string) => path.join(base, n, "root");
    const OUT = (n: string) => path.join(base, n, "out");
    const D = (n: string) => path.join(R(n), "D");

    // Moves `dir` out of the primed root, runs `edit` on the moved copy, and moves it back, all synchronously.
    function roundTrip(n: string, dir: string, edit: (moved: string) => void): void {
      const moved = path.join(OUT(n), path.basename(dir));
      fs.renameSync(dir, moved);
      edit(moved);
      fs.renameSync(moved, dir);
    }

    before(async function () {
      this.timeout(10000);
      base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "obs-rt-"));
      const layouts: Record<string, (root: string) => void> = {
        o54: (r) => fs.mkdirSync(path.join(r, "D")),
        o55: (r) => fs.mkdirSync(path.join(r, "D")),
        o56: (r) => fs.mkdirSync(path.join(r, "D")),
        o57: (r) => fs.mkdirSync(path.join(r, "D")),
        o58: (r) => fs.mkdirSync(path.join(r, "P", "D"), { recursive: true }),
        o59: (r) => fs.mkdirSync(path.join(r, "D")),
        o60: (r) => fs.mkdirSync(path.join(r, "D")),
        o61: (r) => fs.mkdirSync(path.join(r, "D")),
        o63: (r) => fs.mkdirSync(path.join(r, "D")),
      };
      for (const [n, make] of Object.entries(layouts)) {
        fs.mkdirSync(R(n), { recursive: true });
        fs.mkdirSync(OUT(n), { recursive: true });
        make(R(n));
      }
      fs.writeFileSync(path.join(D("o54"), "a.txt"), "A");
      fs.writeFileSync(path.join(D("o55"), "a.txt"), "A");
      fs.writeFileSync(path.join(D("o56"), "a.txt"), "A");
      fs.writeFileSync(path.join(D("o56"), "b.txt"), "B");
      fs.writeFileSync(path.join(R("o58"), "P", "D", "a.txt"), "A");
      fs.writeFileSync(path.join(D("o59"), "a.txt"), "A");
      fs.writeFileSync(path.join(D("o60"), "a.txt"), "A");
      fs.writeFileSync(path.join(D("o61"), "a.txt"), "A");
      fs.writeFileSync(path.join(R("o61"), "s.txt"), "S");
      fs.writeFileSync(path.join(D("o63"), "a.txt"), "A");
      // Age every directory's ctime past the 1000 ms racy window (once, for the whole block).
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });

    after(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("O54: a primed directory moved out, edited and moved back reports changed, then unchanged", () => {
      const state = new ObservedState();
      state.prime([R("o54")]);
      roundTrip("o54", D("o54"), (m) => fs.writeFileSync(path.join(m, "a.txt"), "B"));
      expect(state.isChanged(D("o54"))).to.be.true;
      expect(state.isChanged(D("o54"))).to.be.false;
    });

    it("O55: a round trip that adds a file reports changed, and the added file is then accounted for", () => {
      const state = new ObservedState();
      state.prime([R("o55")]);
      roundTrip("o55", D("o55"), (m) => fs.writeFileSync(path.join(m, "n.txt"), "N"));
      expect(state.isChanged(D("o55"))).to.be.true;
      expect(state.isChanged(path.join(D("o55"), "n.txt"))).to.be.false;
    });

    it("O56: a round trip that removes a file reports changed", () => {
      const state = new ObservedState();
      state.prime([R("o56")]);
      roundTrip("o56", D("o56"), (m) => fs.rmSync(path.join(m, "b.txt")));
      expect(state.isChanged(D("o56"))).to.be.true;
    });

    it("O57: a file added by a round trip to an empty directory is recorded, so moving it out reports changed", () => {
      const state = new ObservedState();
      state.prime([R("o57")]);
      roundTrip("o57", D("o57"), (m) => fs.writeFileSync(path.join(m, "n.txt"), "N"));
      expect(state.isChanged(D("o57"))).to.be.true;
      fs.renameSync(D("o57"), path.join(OUT("o57"), "D"));
      expect(state.isChanged(D("o57"))).to.be.true;
    });

    it("O58: a round trip of an ancestor with an edit two levels down reports the ancestor changed", () => {
      const P = path.join(R("o58"), "P");
      const state = new ObservedState();
      state.prime([R("o58")]);
      roundTrip("o58", P, (m) => fs.writeFileSync(path.join(m, "D", "a.txt"), "B"));
      expect(state.isChanged(P)).to.be.true;
    });

    it("O59: a round trip with no change reports unchanged", () => {
      const state = new ObservedState();
      state.prime([R("o59")]);
      roundTrip("o59", D("o59"), () => undefined);
      expect(state.isChanged(D("o59"))).to.be.false;
    });

    it("O60: record accounts for a round trip's children, so an in-place edit back is seen", () => {
      const a = path.join(D("o60"), "a.txt");
      const state = new ObservedState();
      state.prime([R("o60")]);
      roundTrip("o60", D("o60"), (m) => fs.writeFileSync(path.join(m, "a.txt"), "B"));
      state.record(D("o60"));
      fs.writeFileSync(a, "A"); // the original bytes: only a re-recorded child can tell this changed
      expect(state.isChanged(a)).to.be.true;
    });

    it("O61: a lossy ledger fails open on a round trip even though the directory marker survived", () => {
      const fingerprint: Fingerprinter = (p) => {
        if (p.endsWith("s.txt")) throw new Error("boom");
        return contentFingerprint(p);
      };
      const state = new ObservedState({ fingerprint });
      expect(state.prime([R("o61")]).complete).to.be.false;
      roundTrip("o61", D("o61"), (m) => fs.writeFileSync(path.join(m, "a.txt"), "B"));
      expect(state.isChanged(D("o61"))).to.be.true;
    });

    it("O62: racyStamp is empty for a ctime that is recent, zero or in the future, and set for an old one", () => {
      const racyStamp = (ObservedState as any).racyStamp as (c: bigint, now: bigint) => string;
      const now = 1_700_000_000_000n * 1_000_000n;
      const ms = 1_000_000n;
      expect(racyStamp(now - 1n * ms, now)).to.equal("");
      expect(racyStamp(now - 5000n * ms, now)).to.not.equal("");
      expect(racyStamp(0n, now)).to.equal("");
      expect(racyStamp(now + 5n * ms, now)).to.equal("");
    });

    it("O63: isChanged on an unchanged aged directory is a hot path that fingerprints nothing", () => {
      let calls = 0;
      const fingerprint: Fingerprinter = (p) => {
        calls++;
        return contentFingerprint(p);
      };
      const state = new ObservedState({ fingerprint });
      state.prime([R("o63")]);
      fs.readdirSync(D("o63"));
      fs.readFileSync(path.join(D("o63"), "a.txt"));
      calls = 0;
      expect(state.isChanged(D("o63"))).to.be.false;
      expect(state.isChanged(D("o63"))).to.be.false;
      expect(calls).to.equal(0);
    });

    it("O64: a directory moved in and recorded has its children accounted for", () => {
      const r = path.join(base, "o64", "root");
      const staging = path.join(base, "o64", "staging");
      const E = path.join(r, "D", "E");
      fs.mkdirSync(path.join(r, "D"), { recursive: true });
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, "x.txt"), "X");
      const state = new ObservedState();
      state.prime([r]);
      fs.renameSync(staging, E);
      state.record(E);
      expect(state.isChanged(path.join(E, "x.txt"))).to.be.false;
      expect(state.isChanged(E)).to.be.false;
    });

    it("O65: a directory recorded while unreadable stays unscanned, so moving it out reports changed", function () {
      if (process.platform === "win32" || process.getuid?.() === 0) this.skip();
      const r = path.join(base, "o65", "root");
      const dir = path.join(r, "D");
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(base, "o65", "out"));
      fs.writeFileSync(path.join(dir, "a.txt"), "A");
      const state = new ObservedState(); // D is never primed: record(D) is the first the ledger hears of it
      fs.chmodSync(dir, 0o000);
      try {
        state.record(dir);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      fs.renameSync(dir, path.join(base, "o65", "out", "D"));
      expect(state.isChanged(dir)).to.be.true;
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

  it("O66: a root that is a regular file is recorded as a file, complete, and reads unchanged", () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "a");
    const state = new ObservedState();
    expect(state.prime([file])).to.deep.equal({ files: 1, directories: 0, complete: true });
    expect(state.isChanged(file)).to.be.false;
  });

  it("O67: after priming a file root, an external edit reports changed", () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "before");
    const state = new ObservedState();
    state.prime([file]);
    fs.writeFileSync(file, "after");
    expect(state.isChanged(file)).to.be.true;
  });

  it("O68: a root that is a symbolic link to a regular file is recorded as a file", function () {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    fs.writeFileSync(target, "t");
    try {
      fs.symlinkSync(target, link, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOSYS") this.skip();
      throw err;
    }
    const state = new ObservedState();
    expect(state.prime([link])).to.deep.equal({ files: 1, directories: 0, complete: true });
  });

  it("O69: a file root that already has an entry is not overwritten", () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "before");
    const state = new ObservedState();
    state.record(file);
    fs.writeFileSync(file, "after");
    expect(state.prime([file]).files).to.equal(0);
    expect(state.isChanged(file)).to.be.true;
  });

  it("O70: a file root beneath a root from an earlier prime is skipped", () => {
    makeTree();
    const state = new ObservedState();
    state.prime([root]);
    // Created after the first prime, so it has no entry: only the skip can keep
    // the second prime from recording it and hiding its creation.
    const file = path.join(root, "new.txt");
    fs.writeFileSync(file, "new");
    expect(state.prime([file])).to.deep.equal({
      files: 0,
      directories: 0,
      complete: true,
    });
    expect(state.isChanged(file)).to.be.true;
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
