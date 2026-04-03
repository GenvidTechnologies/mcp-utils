import { expect } from "chai";
import { ExpectedChanges } from "../src/expectedChanges.js";

describe("ExpectedChanges", () => {
  it("consumes a registered path", () => {
    const ec = new ExpectedChanges();
    ec.add("eventSheets/foo.json");
    expect(ec.consume("eventSheets/foo.json")).to.be.true;
    expect(ec.size).to.equal(0);
  });

  it("returns false for unregistered paths", () => {
    const ec = new ExpectedChanges();
    expect(ec.consume("eventSheets/bar.json")).to.be.false;
  });

  it("normalizes backslashes to forward slashes", () => {
    const ec = new ExpectedChanges();
    ec.add("eventSheets\\sub\\foo.json");
    expect(ec.consume("eventSheets/sub/foo.json")).to.be.true;
  });

  it("normalizes backslashes in consume path", () => {
    const ec = new ExpectedChanges();
    ec.add("eventSheets/sub/foo.json");
    expect(ec.consume("eventSheets\\sub\\foo.json")).to.be.true;
  });

  it("remove() cleans up a registered path", () => {
    const ec = new ExpectedChanges();
    ec.add("scripts/main.ts");
    ec.remove("scripts/main.ts");
    expect(ec.consume("scripts/main.ts")).to.be.false;
    expect(ec.size).to.equal(0);
  });

  it("expires entries after TTL", () => {
    const ec = new ExpectedChanges(50); // 50ms TTL
    ec.add("eventSheets/foo.json");
    // Manually backdate the entry by reaching into the internals
    const entries = (ec as any).entries as Map<string, number>;
    entries.set("eventSheets/foo.json", Date.now() - 100);
    expect(ec.consume("eventSheets/foo.json")).to.be.false;
  });

  it("purgeExpired removes stale entries", () => {
    const ec = new ExpectedChanges(50);
    ec.add("a.json");
    ec.add("b.json");
    const entries = (ec as any).entries as Map<string, number>;
    entries.set("a.json", Date.now() - 100); // expired
    ec.purgeExpired();
    expect(ec.size).to.equal(1);
    // b.json should still be consumable
    expect(ec.consume("b.json")).to.be.true;
  });

  it("handles concurrent adds for different paths", () => {
    const ec = new ExpectedChanges();
    ec.add("eventSheets/a.json");
    ec.add("eventSheets/b.json");
    ec.add("layouts/c.json");
    expect(ec.size).to.equal(3);
    expect(ec.consume("eventSheets/a.json")).to.be.true;
    expect(ec.consume("eventSheets/b.json")).to.be.true;
    expect(ec.consume("layouts/c.json")).to.be.true;
    expect(ec.size).to.equal(0);
  });

  it("consume only works once per add", () => {
    const ec = new ExpectedChanges();
    ec.add("eventSheets/foo.json");
    expect(ec.consume("eventSheets/foo.json")).to.be.true;
    expect(ec.consume("eventSheets/foo.json")).to.be.false;
  });
});
