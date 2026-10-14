import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "chai";
import { ExpectedChanges } from "../src/expectedChanges.js";
import { ObservedState, type Fingerprinter } from "../src/observedState.js";
import { toPosixPath } from "../src/strings.js";
import {
  OptimisticWatcher,
  type WatcherFactory,
} from "../src/optimisticWatcher.js";

// ---------------------------------------------------------------------------
// Fake factory helper
// ---------------------------------------------------------------------------
function makeFakeFactory() {
  const watchers: { dir: string; onEvent: (f: string) => void; closed: boolean }[] = [];
  const factory: WatcherFactory = (dir, onEvent) => {
    const entry = { dir, onEvent, closed: false };
    watchers.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  const fireAll = (f: string) => watchers.forEach(w => !w.closed && w.onEvent(f));
  return { factory, watchers, fireAll };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("OptimisticWatcher", () => {

  // -------------------------------------------------------------------------
  // R7.1 Primitives
  // -------------------------------------------------------------------------
  describe("R7.1 primitives", () => {
    it("new watcher has txId === 0", () => {
      const { factory } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: ec,
        watcherFactory: factory,
      });
      expect(w.txId).to.equal(0);
    });

    it("bump() increments txId", () => {
      const { factory } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: ec,
        watcherFactory: factory,
      });
      w.bump();
      expect(w.txId).to.equal(1);
      w.bump();
      expect(w.txId).to.equal(2);
    });

    it("expect(p) delegates to expected.add → expected.size === 1", () => {
      const { factory } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: ec,
        watcherFactory: factory,
      });
      w.expect("/some/path/file.ts");
      expect(ec.size).to.equal(1);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  describe("lifecycle", () => {
    it("start() with 2 watchDirs calls factory twice", () => {
      const { factory, watchers } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a", "/tmp/b"],
        expected: new ExpectedChanges(),
        watcherFactory: factory,
      });
      w.start();
      expect(watchers.length).to.equal(2);
    });

    it("stop() closes all handles", () => {
      const { factory, watchers } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a", "/tmp/b"],
        expected: new ExpectedChanges(),
        watcherFactory: factory,
      });
      w.start();
      w.stop();
      expect(watchers.every(e => e.closed)).to.be.true;
    });

    it("double start() is idempotent (still 2 watchers, not 4)", () => {
      const { factory, watchers } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a", "/tmp/b"],
        expected: new ExpectedChanges(),
        watcherFactory: factory,
      });
      w.start();
      w.start(); // second call should be a no-op
      expect(watchers.length).to.equal(2);
    });
  });

  // -------------------------------------------------------------------------
  // R7.3 External change
  // -------------------------------------------------------------------------
  describe("R7.3 external change", () => {
    it("unexpected fire → txId becomes 1 and onExternalChange called once", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      fireAll("/tmp/a/somefile.ts");
      await Promise.resolve();

      expect(w.txId).to.equal(1);
      expect(externalCalls).to.deep.equal(["/tmp/a/somefile.ts"]);
    });
  });

  // -------------------------------------------------------------------------
  // R7.4 Layer 1 — suppress depth
  // -------------------------------------------------------------------------
  describe("R7.4 suppress L1 (suppressDepth > 0)", () => {
    it("event fired inside suppress window → no bump, no onExternalChange", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      await w.suppress(async () => {
        fireAll("/tmp/a/somefile.ts");
        await Promise.resolve();
      });

      expect(w.txId).to.equal(0);
      expect(externalCalls).to.have.length(0);
    });
  });

  // -------------------------------------------------------------------------
  // R7.4 Layer 2 — expected.consume
  // -------------------------------------------------------------------------
  describe("R7.4 L2 expected.consume", () => {
    it("pre-registered path fired outside suppress → consumed, no bump, no callback, size === 0", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: ec,
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/known.ts";
      w.expect(p);
      // Mirror the default factory: it fires the resolved absolute POSIX path.
      fireAll(toPosixPath(path.resolve(p)));
      await Promise.resolve();

      expect(w.txId).to.equal(0);
      expect(externalCalls).to.have.length(0);
      expect(ec.size).to.equal(0);
    });

    it("relative expect() path matches the resolved absolute path the watcher fires", async () => {
      // Regression: a caller registers a relative/non-canonical write path
      // (as handed to fs.writeFile), but the default factory fires the
      // resolved absolute POSIX path. expect() must resolve so they match,
      // otherwise the program's own write is misclassified as external.
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const w = new OptimisticWatcher({
        watchDirs: [path.resolve("data")],
        expected: ec,
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      w.expect("data/x.json"); // relative, as a write path would be
      fireAll(toPosixPath(path.resolve("data/x.json"))); // what the real factory fires
      await Promise.resolve();

      expect(w.txId).to.equal(0);
      expect(externalCalls).to.have.length(0);
      expect(ec.size).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  // R7.5 throw-in-suppress
  // -------------------------------------------------------------------------
  describe("R7.5 throw-in-suppress", () => {
    it("suppress rejects, suppressDepth returns to 0, txId reflects bump", async () => {
      const { factory } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        watcherFactory: factory,
      });

      let rejected = false;
      try {
        await w.suppress(async () => {
          w.expect("/tmp/a/file.ts");
          w.bump();
          throw new Error("cancelled");
        });
      } catch {
        rejected = true;
      }

      expect(rejected).to.be.true;
      expect((w as any).suppressDepth).to.equal(0);
      expect(w.txId).to.equal(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stop during suppress
  // -------------------------------------------------------------------------
  describe("stop during suppress", () => {
    it("events fired after stop() are not delivered (closed handles skipped by fireAll)", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();
      w.stop();

      // fireAll skips closed handles, so onEvent is never called
      fireAll("/tmp/a/file.ts");
      await Promise.resolve();

      expect(w.txId).to.equal(0);
      expect(externalCalls).to.have.length(0);
    });
  });

  // -------------------------------------------------------------------------
  // Layer 3 — content unchanged since last accounted for
  // -------------------------------------------------------------------------
  describe("Layer 3 (observed content fingerprint)", () => {
    it("T1: expect(p) then 3 duplicate fires, constant fingerprint → txId stays 0, onExternalChange never called", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const ec = new ExpectedChanges();
      const observed = new ObservedState({ fingerprint: () => "constant" });
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: ec,
        observed,
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/known.ts";
      w.expect(p);
      const fired = toPosixPath(path.resolve(p));
      fireAll(fired);
      fireAll(fired);
      fireAll(fired);
      await Promise.resolve();

      expect(w.txId).to.equal(0);
      expect(externalCalls).to.have.length(0);
    });

    // T2 and T3 are a deliberate pair over one harness: T2 pins that
    // duplicate events for unchanged content collapse into a single bump,
    // T3 pins that genuinely distinct content never collapses — together
    // they rule out the gate being trivially dead in either direction.
    it("T2: never-expect()'d path, 3 duplicate fires, constant fingerprint → txId becomes 1, onExternalChange called once", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const observed = new ObservedState({ fingerprint: () => "constant" });
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        observed,
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/unknown.ts";
      fireAll(p);
      fireAll(p);
      fireAll(p);
      await Promise.resolve();

      expect(w.txId).to.equal(1);
      expect(externalCalls).to.have.length(1);
    });

    it("T3: 3 fires with distinct fingerprints (a, b, c) → txId becomes 3", async () => {
      const { factory, fireAll } = makeFakeFactory();
      const values = ["a", "b", "c"];
      let calls = 0;
      const fingerprint: Fingerprinter = () => values[calls++];
      const observed = new ObservedState({ fingerprint });
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        observed,
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/unknown.ts";
      fireAll(p);
      fireAll(p);
      fireAll(p);
      await Promise.resolve();

      expect(w.txId).to.equal(3);
    });

    it("T4: a recorded value followed by an 'absent' fingerprint still bumps (deletion detected)", async () => {
      const { factory, fireAll } = makeFakeFactory();
      let currentValue = "abc";
      const fingerprint: Fingerprinter = () => currentValue;
      const observed = new ObservedState({ fingerprint });
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        observed,
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/deleted.ts";
      observed.record(p); // seals "abc" as accounted for
      currentValue = "absent"; // simulate deletion, per contentFingerprint's ENOENT contract

      fireAll(p);
      await Promise.resolve();

      expect(w.txId).to.equal(1);
    });

    it("T5: a throwing fingerprinter fails open — 2 fires produce 2 bumps, never staleness", async () => {
      const { factory, fireAll } = makeFakeFactory();
      const fingerprint: Fingerprinter = () => {
        throw new Error("fingerprinter boom");
      };
      const observed = new ObservedState({ fingerprint });
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        observed,
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/unstable.ts";
      fireAll(p);
      fireAll(p);
      await Promise.resolve();

      expect(w.txId).to.equal(2);
    });

    it("observed: null fully disables Layer 3 — 2 fires of the same path produce 2 bumps (opt-out preserved)", async () => {
      const externalCalls: string[] = [];
      const { factory, fireAll } = makeFakeFactory();
      const w = new OptimisticWatcher({
        watchDirs: ["/tmp/a"],
        expected: new ExpectedChanges(),
        observed: null,
        onExternalChange: (p) => externalCalls.push(p),
        watcherFactory: factory,
      });
      w.start();

      const p = "/tmp/a/x.ts";
      fireAll(p);
      fireAll(p);
      await Promise.resolve();

      expect(w.txId).to.equal(2);
      expect(externalCalls).to.have.length(2);
    });

    describe("real-fs pins", () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-pin-"));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it("W3: a real content modification of a recorded file bumps exactly once", async () => {
        const { factory, fireAll } = makeFakeFactory();
        const file = path.join(tmpDir, "a.txt");
        fs.writeFileSync(file, "one");
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          watcherFactory: factory,
        });
        w.start();

        const fired = toPosixPath(path.resolve(file));
        fireAll(fired); // first sight: records it
        await Promise.resolve();
        const before = w.txId;

        fs.writeFileSync(file, "two");
        fireAll(fired);
        await Promise.resolve();

        expect(w.txId - before).to.equal(1);
      });

      it("W1: three events on a recorded subdirectory do not bump", async () => {
        const { factory, fireAll } = makeFakeFactory();
        const sub = path.join(tmpDir, "sub");
        fs.mkdirSync(sub);
        const observed = new ObservedState();
        observed.record(sub);
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          observed,
          watcherFactory: factory,
        });
        w.start();

        const before = w.txId;
        const fired = toPosixPath(path.resolve(sub));
        fireAll(fired);
        fireAll(fired);
        fireAll(fired);
        await Promise.resolve();

        expect(w.txId - before).to.equal(0);
      });

      it("W10: observed: null — two events for a subdirectory both bump", async () => {
        const { factory, fireAll } = makeFakeFactory();
        const sub = path.join(tmpDir, "sub");
        fs.mkdirSync(sub);
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          observed: null,
          watcherFactory: factory,
        });
        w.start();

        const before = w.txId;
        const fired = toPosixPath(path.resolve(sub));
        fireAll(fired);
        fireAll(fired);
        await Promise.resolve();

        expect(w.txId - before).to.equal(2);
      });

      it("W11: L1 suppress with a throwing fingerprinter — does not throw, no bump", async () => {
        const { factory, fireAll } = makeFakeFactory();
        const externalCalls: string[] = [];
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          observed: new ObservedState({
            fingerprint: () => {
              throw new Error("boom");
            },
          }),
          onExternalChange: (p) => externalCalls.push(p),
          watcherFactory: factory,
        });
        w.start();

        const before = w.txId;
        const fired = toPosixPath(path.resolve(tmpDir, "w11.txt"));
        await w.suppress(async () => {
          fireAll(fired);
          await Promise.resolve();
        });

        expect(w.txId - before).to.equal(0);
        expect(externalCalls).to.have.length(0);
      });

      it("W12: L2 expect with a throwing fingerprinter — does not throw, no bump, no callback", async () => {
        const { factory, fireAll } = makeFakeFactory();
        const externalCalls: string[] = [];
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          observed: new ObservedState({
            fingerprint: () => {
              throw new Error("boom");
            },
          }),
          onExternalChange: (p) => externalCalls.push(p),
          watcherFactory: factory,
        });
        w.start();

        const before = w.txId;
        const target = path.join(tmpDir, "w12.txt");
        w.expect(target);
        fireAll(toPosixPath(path.resolve(target)));
        await Promise.resolve();

        expect(w.txId - before).to.equal(0);
        expect(externalCalls).to.have.length(0);
      });
    });

    describe("baseline priming (real fs)", () => {
      let tmpDir: string;
      let outside: string;
      let sub: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-prime-"));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), "ow-out-"));
        sub = path.join(tmpDir, "sub");
        fs.mkdirSync(sub);
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      });

      const fp = (p: string) => toPosixPath(path.resolve(p));
      const make = (observed?: ObservedState | null, extra = {}) => {
        const fake = makeFakeFactory();
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          watcherFactory: fake.factory,
          ...(observed === undefined ? {} : { observed }),
          ...extra,
        });
        return { w, fire: (p: string) => fake.fireAll(fp(p)) };
      };
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const removeLink = (l: string) =>
        process.platform === "win32" ? fs.rmdirSync(l) : fs.unlinkSync(l);

      it("W2: first event on a file that existed before start() does not bump", () => {
        const f = path.join(sub, "a.txt");
        fs.writeFileSync(f, "one");
        const { w, fire } = make();
        w.start();
        fire(f);
        expect(w.txId).to.equal(0);
      });

      it("W4: creating an empty directory, events on it and its parent, do not bump", () => {
        const { w, fire } = make();
        w.start();
        const d = path.join(sub, "newdir");
        fs.mkdirSync(d);
        fire(d);
        fire(sub);
        expect(w.txId).to.equal(0);
      });

      it("W5: removing an empty directory that was in the baseline does not bump", () => {
        const d = path.join(sub, "empty");
        fs.mkdirSync(d);
        const { w, fire } = make();
        w.start();
        fs.rmdirSync(d);
        fire(d);
        expect(w.txId).to.equal(0);
      });

      it("W6: a file replaced by a directory bumps once across path, parent, path", () => {
        const x = path.join(sub, "x.txt");
        fs.writeFileSync(x, "one");
        const { w, fire } = make();
        w.start();
        fs.rmSync(x);
        fs.mkdirSync(x);
        fire(x);
        fire(sub);
        fire(x);
        expect(w.txId).to.equal(1);
      });

      it("W7: moving a non-empty directory in bumps once, its child adds nothing", () => {
        const src = path.join(outside, "mv");
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, "c.txt"), "child");
        const { w, fire } = make();
        w.start();
        const dest = path.join(sub, "mv");
        fs.renameSync(src, dest);
        fire(dest);
        expect(w.txId).to.equal(1);
        fire(path.join(dest, "c.txt"));
        expect(w.txId).to.equal(1);
      });

      it("W8: moving a directory out bumps, moving it back with identical files bumps again", () => {
        const inner = path.join(sub, "inner");
        fs.mkdirSync(inner);
        fs.writeFileSync(path.join(inner, "f.txt"), "same");
        const { w, fire } = make();
        w.start();
        const away = path.join(outside, "inner");
        fs.renameSync(inner, away);
        fire(inner);
        expect(w.txId).to.equal(1);
        fs.renameSync(away, inner);
        fire(inner);
        expect(w.txId).to.equal(2);
      });

      it("W9: a lossy ledger (maxEntries 2) bumps for a new empty directory", () => {
        fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
        fs.writeFileSync(path.join(sub, "b.txt"), "b");
        fs.writeFileSync(path.join(sub, "c.txt"), "c");
        const { w, fire } = make(new ObservedState({ maxEntries: 2 }));
        w.start();
        const d = path.join(sub, "newdir");
        fs.mkdirSync(d);
        fire(d);
        expect(w.txId).to.equal(1);
      });

      it("W16: creating a directory link after start bumps once (link, then parent)", function () {
        const target = path.join(outside, "tgt");
        fs.mkdirSync(target);
        const { w, fire } = make();
        w.start();
        const link = path.join(sub, "lnk");
        try {
          fs.symlinkSync(target, link, linkType);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "ENOSYS") return this.skip();
          throw e;
        }
        fire(link);
        fire(sub);
        expect(w.txId).to.equal(1);
      });

      it("W17: removing a directory link that existed before start: 0 then 1", function () {
        const target = path.join(outside, "tgt");
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, "keep.txt"), "keep");
        const link = path.join(sub, "lnk");
        try {
          fs.symlinkSync(target, link, linkType);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "ENOSYS") return this.skip();
          throw e;
        }
        const { w, fire } = make();
        w.start();
        fire(link);
        expect(w.txId).to.equal(0);
        removeLink(link);
        fire(link);
        expect(w.txId).to.equal(1);
        expect(fs.existsSync(path.join(target, "keep.txt"))).to.equal(true);
      });

      it("W18: a self-referencing directory link (ELOOP) created before start() bumps on every event", function () {
        // Created before start() so the baseline walk meets it too; classify
        // falls back to "file" (stat -> ELOOP) and the fingerprinter's unique
        // error token makes every event differ from the last.
        const link = path.join(sub, "self");
        try {
          fs.symlinkSync(link, link, linkType);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "ENOSYS") return this.skip();
          throw e;
        }
        const { w, fire } = make();
        w.start();
        fire(link);
        fire(link);
        expect(w.txId).to.equal(2);
      });

      it("W19: a directory moved in by a self-write, then moved out externally, bumps once", async () => {
        const { w, fire } = make();
        w.start();
        const staging = path.join(outside, "staging");
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "a.txt"), "A");
        const dest = path.join(sub, "D");
        await w.suppress(async () => {
          fs.renameSync(staging, dest);
          fire(dest);
        });
        expect(w.txId).to.equal(0);
        fs.renameSync(dest, path.join(outside, "D2"));
        fire(dest);
        expect(w.txId).to.equal(1);
      });

      it("W20: a primed directory swapped by two renames bumps once on a single event", () => {
        const dest = path.join(sub, "D");
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, "a.txt"), "A");
        fs.writeFileSync(path.join(dest, "c.txt"), "C");
        const { w, fire } = make();
        w.start();
        fs.renameSync(dest, path.join(outside, "Dold"));
        const staging = path.join(outside, "staging");
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "a.txt"), "A");
        fs.writeFileSync(path.join(staging, "b.txt"), "B");
        fs.renameSync(staging, dest);
        fire(dest); // one event, handled after both renames
        // Exactly 1: the replaced directory is evaluated once; the old subtree is dropped, then b.txt is new.
        expect(w.txId).to.equal(1);
      });

      // Two watchers share one ledger; A's raw events are held back and delivered by hand.
      const twoWatchers = () => {
        const shared = new ObservedState();
        const fa = makeFakeFactory();
        const fb = makeFakeFactory();
        const mk = (f: ReturnType<typeof makeFakeFactory>) =>
          new OptimisticWatcher({
            watchDirs: [tmpDir],
            expected: new ExpectedChanges(),
            observed: shared,
            watcherFactory: f.factory,
          });
        return { a: mk(fa), b: mk(fb), deliverToA: (p: string) => fa.fireAll(fp(p)) };
      };

      it("W21: a file turned directory after A started is still reported when B starts first", () => {
        const P = path.join(sub, "P");
        fs.writeFileSync(P, "file-v1");
        const { a, b, deliverToA } = twoWatchers();
        a.start();
        fs.rmSync(P);
        fs.mkdirSync(P);
        fs.writeFileSync(path.join(P, "g.txt"), "G");
        b.start(); // shares the ledger; must not record P's new state
        deliverToA(P);
        expect(a.txId).to.equal(1);
      });

      it("W22: a file created after A started is still reported when B starts first", () => {
        const { a, b, deliverToA } = twoWatchers();
        a.start();
        const Q = path.join(sub, "Q.txt");
        fs.writeFileSync(Q, "new");
        b.start();
        deliverToA(Q);
        expect(a.txId).to.equal(1);
      });

      it("W13: restart does not rebuild the baseline", () => {
        fs.writeFileSync(path.join(sub, "a.txt"), "one");
        let calls = 0;
        const { w } = make(
          new ObservedState({ fingerprint: () => (++calls, "fp") }),
        );
        w.start();
        const afterFirst = calls;
        expect(afterFirst).to.be.greaterThan(0);
        w.stop();
        w.start();
        expect(calls).to.equal(afterFirst);
      });

      it("W14: the watcher factory is called before the first fingerprint", () => {
        fs.writeFileSync(path.join(sub, "a.txt"), "one");
        const seq: string[] = [];
        const fake = makeFakeFactory();
        let fpSeen = false;
        const w = new OptimisticWatcher({
          watchDirs: [tmpDir],
          expected: new ExpectedChanges(),
          watcherFactory: (dir, onEvent) => {
            seq.push("factory");
            return fake.factory(dir, onEvent);
          },
          observed: new ObservedState({
            fingerprint: () => {
              if (!fpSeen) seq.push("fingerprint");
              fpSeen = true;
              return "fp";
            },
          }),
        });
        w.start();
        expect(seq).to.include("fingerprint");
        expect(seq.indexOf("factory")).to.be.lessThan(seq.indexOf("fingerprint"));
      });

      it("W15: logger receives the baseline summary, and a separate incomplete line when lossy", () => {
        fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
        fs.writeFileSync(path.join(sub, "b.txt"), "b");
        fs.writeFileSync(path.join(sub, "c.txt"), "c");
        const normal: string[] = [];
        make(undefined, { logger: (...a: unknown[]) => normal.push(a.join(" ")) }).w.start();
        expect(normal.filter((l) => /baseline/i.test(l)).length).to.be.at.least(1);
        expect(normal.filter((l) => /incomplete/i.test(l))).to.have.length(0);

        const lossy: string[] = [];
        make(new ObservedState({ maxEntries: 2 }), {
          logger: (...a: unknown[]) => lossy.push(a.join(" ")),
        }).w.start();
        expect(lossy.filter((l) => /baseline/i.test(l)).length).to.be.at.least(2);
        expect(lossy.filter((l) => /incomplete/i.test(l)).length).to.be.at.least(1);
      });

      it("W26: a single-file watch root logs no incomplete baseline, and a read-only first event does not bump", () => {
        const f = path.join(tmpDir, "c.json");
        fs.writeFileSync(f, "{}");
        const lines: string[] = [];
        const { w, fire } = make(undefined, {
          watchDirs: [f],
          logger: (...a: unknown[]) => lines.push(a.join(" ")),
        });
        w.start();
        expect(lines.filter((l) => /incomplete/i.test(l))).to.have.length(0);
        fire(f);
        expect(w.txId).to.equal(0);
      });
    });

    describe("directory round trips (ctime re-check)", () => {
      let base: string;
      const R = (n: string) => path.join(base, n, "root");
      const OUT = (n: string) => path.join(base, n, "out");
      const fp = (p: string) => toPosixPath(path.resolve(p));
      const make = (n: string) => {
        const fake = makeFakeFactory();
        const w = new OptimisticWatcher({
          watchDirs: [R(n)],
          expected: new ExpectedChanges(),
          watcherFactory: fake.factory,
        });
        return { w, fire: (p: string) => fake.fireAll(fp(p)) };
      };

      before(async function () {
        this.timeout(10000);
        base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ow-rt-"));
        for (const n of ["w23", "w24", "w25"]) {
          fs.mkdirSync(path.join(R(n), "D"), { recursive: true });
          fs.mkdirSync(OUT(n), { recursive: true });
        }
        fs.writeFileSync(path.join(R("w23"), "D", "a.txt"), "A");
        fs.writeFileSync(path.join(R("w25"), "D", "a.txt"), "A");
        // Age every directory's ctime past the 1000 ms racy window (once, for the whole block).
        await new Promise((resolve) => setTimeout(resolve, 1400));
      });

      after(() => {
        fs.rmSync(base, { recursive: true, force: true });
      });

      it("W23: a synchronous round-trip edit of an aged directory bumps once", () => {
        const D = path.join(R("w23"), "D");
        const moved = path.join(OUT("w23"), "D");
        const { w, fire } = make("w23");
        w.start();
        fs.renameSync(D, moved);
        fs.writeFileSync(path.join(moved, "a.txt"), "B");
        fs.renameSync(moved, D);
        const before = w.txId;
        fire(D);
        expect(w.txId - before).to.equal(1);
        fire(D);
        expect(w.txId - before).to.equal(1);
      });

      it("W24: a file added by a round trip to an empty directory bumps, and so does moving it out", () => {
        const D = path.join(R("w24"), "D");
        const moved = path.join(OUT("w24"), "D");
        const { w, fire } = make("w24");
        w.start();
        fs.renameSync(D, moved);
        fs.writeFileSync(path.join(moved, "n.txt"), "N");
        fs.renameSync(moved, D);
        const before = w.txId;
        fire(D);
        expect(w.txId - before).to.equal(1);
        fs.renameSync(D, moved);
        fire(D);
        expect(w.txId - before).to.equal(2);
      });

      it("W25: a populated directory installed by a self-write inside suppress stays quiet afterwards", async () => {
        const D = path.join(R("w25"), "D");
        const E = path.join(D, "E");
        const staging = path.join(OUT("w25"), "staging");
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "x.txt"), "X");
        const { w, fire } = make("w25");
        w.start();
        await w.suppress(async () => {
          fs.renameSync(staging, E);
          fire(E);
          fire(D);
        });
        const before = w.txId;
        fire(D);
        fire(E);
        expect(w.txId - before).to.equal(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // §7 smoke — real fs.watch
  // -------------------------------------------------------------------------
  describe("§7 smoke (real fs.watch)", function () {
    // Allow env-skip for environments where fs.watch is unreliable
    // (must NOT be skipped by default — guard is opt-in via env var)
    let tmpDir: string | undefined;
    let watcher: OptimisticWatcher | undefined;

    afterEach(() => {
      watcher?.stop();
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        tmpDir = undefined;
      }
    });

    it("real fs.watch fires onExternalChange when a file is written", async function () {
      if (process.env.SKIP_FS_WATCH_TEST) this.skip();
      this.timeout(5000);

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-test-"));
      const externalCalls: string[] = [];

      watcher = new OptimisticWatcher({
        watchDirs: [tmpDir],
        expected: new ExpectedChanges(),
        onExternalChange: (p) => externalCalls.push(p),
        // No watcherFactory → uses default fs.watch adapter
      });
      watcher.start();

      // Give the watcher a moment to initialise before writing
      await new Promise(resolve => setTimeout(resolve, 100));

      const testFile = path.join(tmpDir, "test.txt");
      fs.writeFileSync(testFile, "hello");

      // Poll until onExternalChange fires or we time out
      const deadline = Date.now() + 4000;
      while (externalCalls.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(externalCalls.length).to.equal(1);
      // The reported path should end with "test.txt" (using forward slashes)
      expect(externalCalls[0]).to.include("test.txt");
    });

    it("W27: the default factory reports each edit of a single-file watch root at the file's own path", async function () {
      if (process.env.SKIP_FS_WATCH_TEST) this.skip();
      this.timeout(10000);

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-test-"));
      const file = path.join(tmpDir, "c.json");
      fs.writeFileSync(file, "0");
      const reported: string[] = [];

      watcher = new OptimisticWatcher({
        watchDirs: [file],
        expected: new ExpectedChanges(),
        onExternalChange: (p) => reported.push(p),
      });
      watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (const content of ["edit one", "edit number two", "edit three!!"]) {
        const seen = reported.length;
        fs.writeFileSync(file, content);
        const deadline = Date.now() + 2000;
        while (reported.length === seen && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(reported.length, `no report after writing "${content}"`).to.be.greaterThan(seen);
      }

      const expected = toPosixPath(path.resolve(file));
      for (const p of reported) expect(p).to.equal(expected);
    });
  });
});
