# Capture: a reference-sweep inventory blind to references *from* a moved file

Captured 2026-08-24 during the `#17` branch (`docs/retire-docs-tier`), which
retired `docs/` into `wiki/`. Session-local transcript plus commands
re-runnable against the repo at the commits named below. No public upstream
beyond this repo.

**Immutable.** If any of this needs correcting, add a new capture; never edit
this file.

---

## 1. The inventory as filed

Issue #17 §"The reference sweep — do not run a blanket replace" enumerated
`docs/` occurrences and split them into migratable and must-not-touch:

> 67 occurrences of `docs/` outside `node_modules`/`dist` (excluding the
> `docs:///` URI scheme). **Roughly 40 of them must not be touched** […]
> Genuinely migratable: `CLAUDE.md` (6), `README.md` (5), `wiki/*` (6), the
> moved files' own internal links (10), and `src/walkFiles.ts:51` (1 — a
> docstring ADR citation).

## 2. Re-derivation at `main` @ 7423e48

Command (occurrences, not lines — `grep -c` counts lines and undercounts
multi-hit lines):

```
grep -rIoP '(?<!:)docs/' . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git | wc -l
```

Result: **81**, not 67. Per-file:

```
     17 ./test/exposeDocs.test.ts
     16 ./CONVENTIONS.md
      9 ./CLAUDE.md
      7 ./raw/2026-08-16-verification-traps-excerpts.md
      6 ./README.md
      4 ./wiki/failure-modes-that-report-success.md
      4 ./docs/wiki-schema.md
      4 ./docs/decisions/0003-exposedocs-path-shaped-resource-names.md
      4 ./CHANGELOG.md
      3 ./raw/2026-08-24-isolated-probe-scope-error.md
      2 ./docs/code-review-context.md
      1 ./wiki/log.md
      1 ./wiki/index.md
      1 ./src/walkFiles.ts
      1 ./raw/README.md
      1 ./docs/TOC.md
```

Corrected split: **57 must-not-touch, 24 migratable.** Three categories the
issue classified as migratable must not change:

- `README.md:398`, `:419` — document `exposeDocs`' *default* `docsDir`,
  contradicting the option table two lines below (`` `docsDir` | `"docs"` ``).
- `wiki/failure-modes-that-report-success.md:22,23,25,311` — `sources:`
  permalinks pinned at commit `74c0c0f`, plus the footnote citing them.
- ADR-0003 `:16`, `:19`, `:65` — another repo's flat `docs/` alias and
  `src/mcp/server.ts:52`.

## 3. The category no `docs/` search could return

After `git mv docs/code-review-context.md wiki/process/code-review-context.md`
(commit `123e40b`, `R100`, zero content change), `audit-conventions` reported:

```
- wiki/process/code-review-context.md:24 broken link -> ../CLAUDE.md
- wiki/process/code-review-context.md:26 broken link -> ../README.md
- wiki/process/code-review-context.md:27 broken link -> decisions/
- wiki/process/code-review-context.md:193 broken link -> decisions/0001-walkfiles-returns-only-regular-files.md
- wiki/process/code-review-context.md:197 broken link -> TOC.md
```

**None of these five strings contains the substring `docs/`.** They broke
because the file descended one directory level, not because they referenced
the retired directory. An inventory enumerating references *to* `docs/` cannot
return them at any threshold of diligence — the defect is in what the
enumeration is *of*, not in how carefully it was run.

The inventory was otherwise accurate: all 24 sites it did name were real, and
the 57 must-not-touch classifications held. Its precision on the enumerated
category is what made the missing category invisible.

Caught by `audit-conventions`' `scanBrokenLinks`, which resolves links against
the filesystem and therefore does not care what string they contain.

## 4. Second instance in the same branch: an authored claim

Commit `cc3a580` introduced ADR-0004 with this Consequences bullet:

> Out-of-bundle links improved rather than regressed: the schema previously
> cited `../docs/wiki-schema.md` and `../docs/decisions/0001-*.md` as its
> examples of links escaping the OKF bundle. Both are now inside it.

Measured afterwards, counting markdown links under `wiki/` whose resolved
target falls outside `wiki/`:

| Ref | Out-of-bundle links in `wiki/` |
|---|---|
| `main` | 0 |
| `docs/retire-docs-tier` @ `8c146e8` | 2 |

The count moved 0 → 2 (`wiki/process/code-review-context.md` → `../../CLAUDE.md`
and `../../README.md`, which became bundle-escaping the moment the file moved
*inside* `wiki/`). The claim inverts the measurement.

The supporting sentence was independently **true** — the schema's examples did
move inside the bundle — but those are code-spans in prose, never live links,
so they never counted toward any link figure. A true statement was serving as
evidence for a false one.

Corrected in commit `41e3424`. Lint, typecheck, 206 passing tests and build
were green across every commit in between; no gate reads ADR prose.

## 5. Commands to reproduce

```
git log --oneline main..docs/retire-docs-tier
git show main:wiki/index.md
node <plugin>/skills/audit-conventions/scripts/audit.mjs
```

Out-of-bundle count, run per ref (read the other ref with `git show`, not
`git checkout` — a checkout to compare corrupted the working tree during this
session and needed `git reset --hard` to recover):

```
node -e 'const fs=require("fs"),path=require("path");const p=[];
function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=d+"/"+e.name;
 if(e.isDirectory())w(f);else if(e.name.endsWith(".md"))p.push(f);}}
w("wiki");let n=0;
for(const f of p){const s=fs.readFileSync(f,"utf8"),dir=f.slice(0,f.lastIndexOf("/"));
 for(const m of s.matchAll(/\]\(([^)#][^)]*)\)/g)){const t=m[1];
  if(/^(https?:|mailto:|docs:)/.test(t))continue;
  if(!path.posix.normalize(dir+"/"+t.split("#")[0]).startsWith("wiki/"))n++;}}
console.log(n);'
```
