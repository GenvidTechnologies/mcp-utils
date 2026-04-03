import { expect } from "chai";
import { ReadWriteLock } from "../src/rwlock.js";

/** Helper that creates a deferred promise for manual resolution control. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ReadWriteLock", () => {
  it("allows multiple concurrent reads", async () => {
    const lock = new ReadWriteLock();
    const d1 = deferred();
    const d2 = deferred();
    const log: string[] = [];

    const r1 = lock.read(async () => {
      log.push("r1-start");
      await d1.promise;
      log.push("r1-end");
      return 1;
    });
    const r2 = lock.read(async () => {
      log.push("r2-start");
      await d2.promise;
      log.push("r2-end");
      return 2;
    });

    // Both reads should have started concurrently
    await Promise.resolve(); // flush microtasks
    expect(log).to.deep.equal(["r1-start", "r2-start"]);

    d1.resolve();
    d2.resolve();
    const [v1, v2] = await Promise.all([r1, r2]);
    expect(v1).to.equal(1);
    expect(v2).to.equal(2);
  });

  it("blocks writes while reads are active", async () => {
    const lock = new ReadWriteLock();
    const dRead = deferred();
    const log: string[] = [];

    const r = lock.read(async () => {
      log.push("read-start");
      await dRead.promise;
      log.push("read-end");
    });

    const w = lock.write(async () => {
      log.push("write");
    });

    await Promise.resolve();
    expect(log).to.deep.equal(["read-start"]);

    dRead.resolve();
    await Promise.all([r, w]);
    expect(log).to.deep.equal(["read-start", "read-end", "write"]);
  });

  it("blocks reads while a write is active", async () => {
    const lock = new ReadWriteLock();
    const dWrite = deferred();
    const log: string[] = [];

    const w = lock.write(async () => {
      log.push("write-start");
      await dWrite.promise;
      log.push("write-end");
    });

    const r = lock.read(async () => {
      log.push("read");
    });

    await Promise.resolve();
    expect(log).to.deep.equal(["write-start"]);

    dWrite.resolve();
    await Promise.all([w, r]);
    expect(log).to.deep.equal(["write-start", "write-end", "read"]);
  });

  it("serializes multiple writes", async () => {
    const lock = new ReadWriteLock();
    const d1 = deferred();
    const log: string[] = [];

    const w1 = lock.write(async () => {
      log.push("w1-start");
      await d1.promise;
      log.push("w1-end");
    });

    const w2 = lock.write(async () => {
      log.push("w2");
    });

    await Promise.resolve();
    expect(log).to.deep.equal(["w1-start"]);

    d1.resolve();
    await Promise.all([w1, w2]);
    expect(log).to.deep.equal(["w1-start", "w1-end", "w2"]);
  });

  it("is write-preferring: pending write blocks new reads", async () => {
    const lock = new ReadWriteLock();
    const dRead = deferred();
    const dWrite = deferred();
    const log: string[] = [];

    // Start a read to hold the lock
    const r1 = lock.read(async () => {
      log.push("r1-start");
      await dRead.promise;
      log.push("r1-end");
    });

    // Queue a write (blocked by active read)
    const w = lock.write(async () => {
      log.push("write");
      await dWrite.promise;
    });

    // Queue another read — should be blocked behind the pending write
    const r2 = lock.read(async () => {
      log.push("r2");
    });

    await Promise.resolve();
    expect(log).to.deep.equal(["r1-start"]);

    // Release initial read — write should run next (not r2)
    dRead.resolve();
    await r1;
    // Let microtasks settle
    await Promise.resolve();
    await Promise.resolve();
    expect(log).to.deep.equal(["r1-start", "r1-end", "write"]);

    // Release write — r2 should run
    dWrite.resolve();
    await Promise.all([w, r2]);
    expect(log).to.deep.equal(["r1-start", "r1-end", "write", "r2"]);
  });

  it("releases lock if fn throws", async () => {
    const lock = new ReadWriteLock();

    await lock
      .write(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    // Lock should be released — another write should succeed
    let ran = false;
    await lock.write(async () => {
      ran = true;
    });
    expect(ran).to.be.true;
  });

  it("releases read lock if fn throws", async () => {
    const lock = new ReadWriteLock();

    await lock
      .read(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    // Lock should be released — a write should succeed
    let ran = false;
    await lock.write(async () => {
      ran = true;
    });
    expect(ran).to.be.true;
  });
});
