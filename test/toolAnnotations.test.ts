import { expect } from "chai";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  READ_ONLY,
  REGENERATE,
  MUTATE,
  NON_IDEMPOTENT_READ,
} from "../src/toolAnnotations.js";

describe("toolAnnotations", () => {
  describe("READ_ONLY", () => {
    it("deep-equals the expected literal object", () => {
      expect(READ_ONLY).to.deep.equal({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    });
  });

  describe("REGENERATE", () => {
    it("deep-equals the expected literal object", () => {
      expect(REGENERATE).to.deep.equal({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    });
  });

  describe("MUTATE", () => {
    it("deep-equals the expected literal object", () => {
      expect(MUTATE).to.deep.equal({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    });
  });

  describe("NON_IDEMPOTENT_READ", () => {
    it("deep-equals the expected literal object", () => {
      expect(NON_IDEMPOTENT_READ).to.deep.equal({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      });
    });
  });

  describe("type compatibility", () => {
    it("all presets are assignable to ToolAnnotations (compile-time check)", () => {
      // These assignments are compile-time type checks; if they compile, the test passes at runtime.
      const _a: ToolAnnotations = READ_ONLY;
      const _b: ToolAnnotations = REGENERATE;
      const _c: ToolAnnotations = MUTATE;
      const _d: ToolAnnotations = NON_IDEMPOTENT_READ;
      // Use variables to avoid "assigned but never read" linting errors
      void [_a, _b, _c, _d];
    });
  });

  describe("literal-type narrowing (as const preservation)", () => {
    it("READ_ONLY.readOnlyHint is literally true", () => {
      const x: true = READ_ONLY.readOnlyHint;
      expect(x).to.be.true;
    });

    it("MUTATE.readOnlyHint is literally false", () => {
      const y: false = MUTATE.readOnlyHint;
      expect(y).to.be.false;
    });

    it("NON_IDEMPOTENT_READ.idempotentHint is literally false", () => {
      const z: false = NON_IDEMPOTENT_READ.idempotentHint;
      expect(z).to.be.false;
    });

    it("REGENERATE.idempotentHint is literally true", () => {
      const w: true = REGENERATE.idempotentHint;
      expect(w).to.be.true;
    });
  });
});
