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
  });
});
