import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Read-only, idempotent tool: reads state without side effects.
 * Safe to call multiple times; never modifies data.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const satisfies ToolAnnotations;

/**
 * Writing, idempotent, non-destructive tool: generates or overwrites output
 * but repeated calls produce the same result and nothing is permanently lost.
 */
export const REGENERATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const satisfies ToolAnnotations;

/**
 * Destructive, non-idempotent write tool: modifies or deletes data in a way
 * that cannot be trivially undone and may differ across repeated calls.
 */
export const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const satisfies ToolAnnotations;

/**
 * Read-only but non-idempotent tool: reads state without modification yet
 * each call may return different results (e.g. consuming a queue or stream).
 */
export const NON_IDEMPOTENT_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
} as const satisfies ToolAnnotations;
