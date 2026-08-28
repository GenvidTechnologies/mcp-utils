# A claim whose subject is absent from the source — captured 2026-08-28

Session-local capture from the `#19` (`txToken`) planning and implementation
run. Verbatim command output and file excerpts, recorded at the moment they
were produced. No public upstream for the session transcript; the `semver`
probe below is re-runnable against the `semver` package resolved in this
repo's `node_modules/`, and the git commit quoted is pinned by its SHA.

Environment: node v24.11.1, Windows 11, `@genvidtech/mcp-utils` at `0.8.0`,
branch `feat/tx-token-codec`.

---

## 1. What the dispatch asked for

A `gvt-dev:tech-writer` subagent was dispatched to write the `CHANGELOG.md`
`[Unreleased]` entry for the new `txToken` codec. The dispatch brief carried
this instruction, which supplied the claim in question:

> **The version choice is a minor bump.** New exports; nothing removed or
> renamed. Both waiting consumers currently pin `^0.8.0`.

The brief separated verified from inherited facts and placed the consumer-pin
claim in neither bucket explicitly — it was stated flatly, inherited in turn
from issue #19's own *Context* section:

> - Current `latest` is **0.8.0**; both consumers are on `^0.8.0` today.

## 2. What the subagent returned

The subagent verified every claim it could against `src/txToken.ts` and
`test/txToken.test.ts`, and enumerated them. It then flagged, unprompted and
correctly, the two claims it could not check:

> ### Not independently verifiable from this repo (carried from the brief as given, not re-verified)
>
> - The specific issue numbers `c3-domain-manager#77` / `construct3-chef#95` —
>   the source comment names the consumer repos but not issue numbers, and
>   those repos aren't checked out here. I omitted the specific issue numbers
>   from both `CLAUDE.md` and the CHANGELOG entry rather than transcribe
>   unverified numbers as settled fact […]
> - "Both waiting consumers currently pin `^0.8.0`" — stated in the
>   CHANGELOG's version-choice rationale as given in the brief; I have no way
>   to inspect those external repos' `package.json` from this checkout, so
>   this is carried forward from the brief, not independently confirmed.

## 3. The text it wrote

Staged, uncommitted, in `CHANGELOG.md`:

```
  **Shipping as a minor bump, not a patch.** These are new exports; nothing existing
  was removed or renamed. Both named consumers currently pin `^0.8.0`, so this lands
  within their existing range — see `CLAUDE.md`'s version-choice convention.
```

The operative half is the clause **"so this lands within their existing
range"**. That is not the inherited claim; it is a *consequence* the subagent
derived from it. The inherited claim ("consumers pin `^0.8.0`") was flagged.
The derived consequence was not.

## 4. The probe that contradicted it

Run in this repo against the resolved `semver` package:

```
$ node -e '
const semver=require("semver");
for (const r of ["^0.8.0","^0.7.0"]) for (const v of ["0.8.1","0.9.0","1.0.0"])
  console.log(r.padEnd(8),"includes",v.padEnd(7),"->",semver.satisfies(v,r));
'
^0.8.0   includes 0.8.1   -> true
^0.8.0   includes 0.9.0   -> false
^0.8.0   includes 1.0.0   -> false
^0.7.0   includes 0.8.1   -> false
^0.7.0   includes 0.9.0   -> false
^0.7.0   includes 1.0.0   -> false
```

`^0.8.0` resolves as `>=0.8.0 <0.9.0`. Below a major of 1, npm's caret permits
patch updates only. The codec ships as `0.9.0`, so it falls **outside** every
consumer range the entry named. The written claim was the exact inverse of the
truth.

## 5. The precedent already in the repo

`git log` on `main`, commit `7423e48` (`chore(release): bump version to
0.8.0`), body verbatim:

```
Consumers currently pin ^0.7.0, which excludes 0.8.0, so adoption downstream
is deliberate work rather than a transparent pickup. That is the intended
outcome here, not an oversight.
```

The correct rule was therefore already established in this repo, one release
earlier, by the same reasoning — and recorded only in a **commit body**, which
no reader of `CLAUDE.md`, `CHANGELOG.md`, or the wiki encounters.

## 6. What every automated gate reported

At the moment the wrong text was staged:

```
$ npm run lint && npm run typecheck && npm run test && npm run build
  (lint: clean)
  (typecheck: clean)
  250 passing (894ms)
  1 pending
  (build: clean)
```

All green. No gate in this repo reads prose.

## 7. The correction as committed

Committed in `b2705be`:

```
  **Shipping as a minor bump, not a patch.** These are new exports; nothing existing
  was removed or renamed. Note that `^0.8.0` — the range both named consumers pin
  today — **excludes** 0.9.0: below 1.0.0 a caret permits patch updates only. So
  picking this up downstream is deliberate work rather than a transparent bump,
  exactly as 0.8.0 was for consumers pinning `^0.7.0`.
```

Two further inversions were found in the same entry during the same read and
corrected in the same commit, both also invisible to every gate:

- `formatTxToken` was described as throwing "on an invalid `projectId` or a
  non-negative-safe-integer `n`" — as written, it says the function throws
  when `n` **is** valid. Corrected to "or on an `n` that is not a non-negative
  safe integer".
- The bound was described as "the value is capped at `Number.MAX_SAFE_INTEGER`
  rather than silently coerced". The implementation does not cap; it
  **rejects**. Corrected accordingly.
