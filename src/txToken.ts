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
 * Parse a client-supplied token.
 *
 * Returns `null` on any malformed input, including non-string input. Never
 * throws — this value comes off the wire. Splits on the *first* `:`, then
 * validates the left half with {@link isValidProjectId} (so the id half can
 * never drift from what `formatTxToken` mints) and the right half against a
 * strict canonical-integer shape: leading zeros (`"03"`), signs, whitespace,
 * exponent notation, and hex are all rejected, and the numeric value must
 * additionally be a safe integer (a shape-valid but overlarge digit string
 * would otherwise coerce lossily).
 */
export function parseTxToken(token: string): { projectId: string; n: number } | null {
  if (typeof token !== "string") return null;
  const sep = token.indexOf(":");
  if (sep === -1) return null;
  const projectId = token.slice(0, sep);
  const rest = token.slice(sep + 1);
  if (!isValidProjectId(projectId) || !TX_N.test(rest)) return null;
  const n = Number(rest);
  if (!Number.isSafeInteger(n)) return null;
  return { projectId, n };
}

/**
 * True iff `token` parses and its `projectId` and `n` match the given
 * values. Returns `false` (never `null`/`undefined`) for malformed input,
 * so a consumer's `!== true` and `=== false` guard spellings agree.
 */
export function compareTxToken(token: string, projectId: string, currentN: number): boolean {
  const parsed = parseTxToken(token);
  return parsed !== null && parsed.projectId === projectId && parsed.n === currentN;
}
