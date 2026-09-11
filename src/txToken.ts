/**
 * A wire transaction token: `${projectId}:${n}`.
 *
 * Wire contract with two named consumers — `GenvidTechnologies/c3-domain-manager`
 * and `GenvidTechnologies/construct3-chef` — so the delimiter (`:`) and the
 * canonical number shape below are fixed, not incidental. See
 * `wiki/decisions/0005-tx-token-wire-format.md`.
 */
export type TxToken = string;

/** Canonical decimal shape: `"0"`, or a non-zero digit followed by digits. Rejects leading zeros. */
const TX_N = /^(0|[1-9][0-9]*)$/;

/**
 * True iff `id` is non-empty and contains no ":" and no whitespace — the
 * shape `formatTxToken` requires of the left half of every token it mints.
 */
export function isValidProjectId(id: string): boolean {
  return id.length > 0 && !/[:\s]/.test(id);
}

/**
 * Mint a token.
 *
 * Throws `TypeError` if `projectId` is not a valid project id (see
 * {@link isValidProjectId}), or if `n` is not a non-negative safe integer.
 * This is the deliberate exception to this module's otherwise never-throw
 * contract: the input comes from the server's own construction path, not
 * off the wire, so failing loudly here is correct.
 */
export function formatTxToken(projectId: string, n: number): TxToken {
  if (!isValidProjectId(projectId) || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`invalid tx token components: projectId=${JSON.stringify(projectId)}, n=${n}`);
  }
  return `${projectId}:${n}`;
}

/**
 * Why {@link parseTxToken} rejected a token, in the order the checks run:
 *
 * - `"not-a-string"` — the input isn't a `string` at all.
 * - `"no-separator"` — no `:` found (`indexOf(":") === -1`).
 * - `"invalid-project-id"` — the left half fails {@link isValidProjectId}
 *   (empty, or contains `:` or whitespace).
 * - `"invalid-counter-shape"` — the right half doesn't match the strict
 *   canonical-integer shape (leading zeros, signs, whitespace, exponent
 *   notation, hex, or a non-digit right half are all this reason).
 * - `"counter-out-of-range"` — the right half is shape-valid digits but
 *   exceeds `Number.MAX_SAFE_INTEGER`.
 */
export type TxTokenParseFailure =
  | "not-a-string"
  | "no-separator"
  | "invalid-project-id"
  | "invalid-counter-shape"
  | "counter-out-of-range";

/** Result of {@link parseTxToken}: either the parsed halves, or why parsing failed. */
export type TxTokenParseResult = { ok: true; projectId: string; n: number } | { ok: false; reason: TxTokenParseFailure };

/**
 * Parse a client-supplied token.
 *
 * Returns `{ ok: false, reason }` on any malformed input, including
 * non-string input — never `{ ok: true }` for the same inputs that used to
 * return `null`; the accept set is unchanged, only the rejection is now
 * classified. Never throws — this value comes off the wire. Splits on the
 * *first* `:`, then validates the left half with {@link isValidProjectId}
 * (so the id half can never drift from what `formatTxToken` mints) and the
 * right half against a strict canonical-integer shape: leading zeros
 * (`"03"`), signs, whitespace, exponent notation, and hex are all rejected,
 * and the numeric value must additionally be a safe integer (a shape-valid
 * but overlarge digit string would otherwise coerce lossily). See
 * {@link TxTokenParseFailure} for which rejection reason each malformed
 * shape yields.
 */
export function parseTxToken(token: string): TxTokenParseResult {
  if (typeof token !== "string") return { ok: false, reason: "not-a-string" };
  const sep = token.indexOf(":");
  if (sep === -1) return { ok: false, reason: "no-separator" };
  const projectId = token.slice(0, sep);
  const rest = token.slice(sep + 1);
  if (!isValidProjectId(projectId)) return { ok: false, reason: "invalid-project-id" };
  if (!TX_N.test(rest)) return { ok: false, reason: "invalid-counter-shape" };
  const n = Number(rest);
  if (!Number.isSafeInteger(n)) return { ok: false, reason: "counter-out-of-range" };
  return { ok: true, projectId, n };
}

/**
 * True iff `token` parses and its `projectId` and `n` match the given
 * values. Returns `false` (never `null`/`undefined`) for malformed input,
 * so a consumer's `!== true` and `=== false` guard spellings agree.
 */
export function compareTxToken(token: string, projectId: string, currentN: number): boolean {
  const parsed = parseTxToken(token);
  return parsed.ok && parsed.projectId === projectId && parsed.n === currentN;
}
