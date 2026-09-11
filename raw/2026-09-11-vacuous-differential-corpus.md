# A differential check whose corpus never exercises the positive case — captured 2026-09-11

Session-local capture from the `#25` (`parseTxToken` failure reason) planning,
implementation and review run. Recorded at the moment the probe was run. There
is no public upstream for the session transcript; the probe itself lived in the
session scratchpad and was discarded per `gvt-dev:build-probe`'s discard-by-default
rule, so this file is the only record of it. Every command quoted below is
re-runnable against branch `feat/txtoken-parse-failure-reason` (seven commits,
`db40763`..`a5b2b4c`); the pre-change implementation it compares against is
`origin/main`'s `src/txToken.ts` at the branch point.

Environment: Windows 11, `@genvidtech/mcp-utils` at `0.9.0` (+7 unreleased),
branch `feat/txtoken-parse-failure-reason`, `gvt-dev` plugin cache `4.23.0`.

---

## 1. The question the probe existed to answer

`#25` changed `parseTxToken`'s return shape from `{ projectId; n } | null` to a
discriminated `{ ok: true; … } | { ok: false; reason }`. The load-bearing claim
of the whole change — asserted in the commit body, the CHANGELOG, README and
ADR-0007 — was that **the accept set did not move**: the same tokens parse as
before, only the shape of a rejection changed.

No test in the repo could establish that. `test/txToken.test.ts` was rewritten in
the same commit that changed the implementation, so the suite was green against
the *new* contract and carried no information about the old one. The question
needed a differential probe against the pre-change code.

## 2. The probe

Built in the session scratchpad. The pre-change implementation was extracted
from git rather than reconstructed by hand:

```bash
git show HEAD:src/txToken.ts > "$SP/txToken-old.mts"
```

Both were then imported by absolute file URL and run over one shared corpus —
36 hand-picked fixed inputs plus 20,000 fuzzed strings (alphabet
`ab:0159 \t-+.eE\nx`, lengths 0-8, from a seeded LCG so the run reproduces):

```ts
const o = oldMod.parseTxToken(input as string);   // pre-change: {…} | null
const n = newMod.parseTxToken(input as string);   // post-change: {ok:…}

const oldAccepts = o !== null;
const newAccepts = n.ok;
if (oldAccepts !== newAccepts) { /* VALIDITY mismatch */ }
if (oldAccepts && n.ok) { /* also compare projectId and n — VALUE mismatch */ }
```

## 3. What it reported

```
inputs compared: 20036 (36 fixed + 20000 fuzz)
of which the OLD impl accepted: 112  (a non-zero accept count is what makes this check non-vacuous)
mismatches: 0

=== the four chef-divergence rows under the NEW impl ===
  "alpha:05"                 {"ok":false,"reason":"invalid-counter-shape"}
  "alpha:5:6"                {"ok":false,"reason":"invalid-counter-shape"}
  "al pha:5"                 {"ok":false,"reason":"invalid-project-id"}
  "alpha:9007199254740993"   {"ok":false,"reason":"counter-out-of-range"}

=== reason reachability ===
  REACHED  not-a-string
  REACHED  no-separator
  REACHED  invalid-project-id
  REACHED  invalid-counter-shape
  REACHED  counter-out-of-range

RESULT: accept set UNCHANGED
```

## 4. The part that matters

**112 of 20,036 is 0.56%.** Ninety-nine point four percent of the corpus was
rejected by *both* implementations, and every one of those inputs contributes a
trivially-matching pair: `false === false`.

So `mismatches: 0` — the headline number, the one that got written into the
commit body and the ADR — is a result that a **parser rejecting every input
whatsoever** would also produce against this corpus. On its own it distinguishes
"the accept set is unchanged" from nothing at all.

The `of which the OLD impl accepted: 112` line is the only thing in the output
that rules that out, and it was printed for exactly that reason. Its parenthetical
is in the probe's own source:

```ts
console.log(`of which the OLD impl accepted: ${accepted}  (a non-zero accept count is what makes this check non-vacuous)`);
```

The fuzz alphabet was deliberately seeded with `:`, digits, and short lengths so
that *some* generated strings would be well-formed tokens. A naive alphabet —
letters only, or lengths 1-20 — would have produced a corpus with **zero**
accepted inputs, a clean `mismatches: 0`, and no signal whatsoever. That version
of the probe would have looked identical in the transcript.

## 5. The near-miss

The fixed-input list was written first and the fuzz added second. Had the probe
shipped with only the 36 fixed inputs, the accept count would have been 5 — small,
but non-zero, and the check would still have been sound. The hazard is not fuzzing;
it is that **corpus size reads as rigor**. `20,036 inputs, 0 mismatches` is a far
more persuasive-looking sentence than `36 inputs, 0 mismatches`, and it is the one
that would have been quoted — while the 20,000 added exactly 107 accepted cases
and 19,893 pairs of matching rejections.

An equivalence claim is carried by the positive cases. The negative ones bound
the claim, but they cannot establish it, and a corpus can be scaled arbitrarily
in the direction that establishes nothing.
