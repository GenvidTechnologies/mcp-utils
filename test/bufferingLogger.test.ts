import { expect } from "chai";
import { bufferingLogger } from "../src/bufferingLogger.js";
import type { Logger } from "../src/types.js";

describe("bufferingLogger", () => {
  it("fresh logger text() returns empty string (no lines yet)", () => {
    const { text } = bufferingLogger();
    expect(text()).to.equal("");
  });

  it("joins multiple args with a single space and multiple calls with newline", () => {
    const { log, text } = bufferingLogger();
    log("a", 1);
    log("b");
    expect(text()).to.equal("a 1\nb");
  });

  it("log() with no args pushes an empty string", () => {
    const { log, text } = bufferingLogger();
    log();
    expect(text()).to.equal("");
  });

  it("log('x') followed by log() produces 'x\\n'", () => {
    const { log, text } = bufferingLogger();
    log("x");
    log();
    expect(text()).to.equal("x\n");
  });

  it("accumulates calls in order", () => {
    const { log, text } = bufferingLogger();
    log("first");
    log("second");
    log("third");
    expect(text()).to.equal("first\nsecond\nthird");
  });

  it("type check: .log is assignable to Logger", () => {
    // This is a compile-time check; if tsc/tsx accepts this file, the type is correct.
    const l: Logger = bufferingLogger().log;
    l("type check");
  });
});
