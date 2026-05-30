# Plan: Publish `@genvid/mcp-utils` to npmjs.com

Convert this package from a privately-consumed monorepo utility into a public npm
package published via the shared `genvid-public-ci` GitHub Actions recipe.

**Branch:** `publishing` (even with `origin/main`).

## Decisions (locked)

- **Package name:** rename `genvid-mcp-utils` → `@genvid/mcp-utils` (scoped, matches
  the `genvid-public-ci` runbook convention).
- **Version:** stays `0.2.0`. Under the *new scoped name* `0.2.0` is unused, so the
  first OIDC-provenanced publish is a clean `0.2.0`.
- **Scope:** wire up CI **and** cut the first release.

## ⚠️ Blocking premise correction

The task stated "bootstrap package already exists and trusted publishing is set" —
that is true only for the **unscoped** `genvid-mcp-utils`. Choosing the scoped name
`@genvid/mcp-utils` (which does not exist on npm) means a **fresh one-time npm
bootstrap + trusted-publisher registration is required before the release can
publish.** That is manual npm-side work (release phase, step 2).

## Key facts established

- Repo `genvid-holdings/genvid-mcp-utils` is **public** (required for provenance).
- No lockfile is committed today (`pnpm-lock.yaml` tracked; no `package-lock.json`).
  The gate's `npm ci` and `cache: npm` both require a committed `package-lock.json`.
- `dist/` is gitignored; `publish.yml` and `node-gate.yml` both run `npm run build`
  before publish/dry-run, so `dist/` exists at publish time. `prepack: "npm run
  build"` is added per the runbook to protect local `npm publish`/`npm pack`.
- Shared recipe `genvid-public-ci`: `templates/ci.yml` + `templates/publish.yml` are
  drop-in, zero-edit; both call `node-gate.yml@main`. `publish.yml` triggers on
  `v*.*.*` tags, enforces a tag↔`package.json` version guard, publishes via OIDC with
  `--provenance --access public`.
- `package.json` scripts are already runner-agnostic (mocha/tsc/eslint, no `pnpm`).

## Implementation tasks (each = one commit)

- **Prep** — commit `plan.md`.
- **Task 1 — `package.json` publishing metadata**
  - `name` → `@genvid/mcp-utils`
  - Add `publishConfig.access: "public"` (required — scoped packages default private)
  - Add `repository: { type: "git", url: "https://github.com/genvid-holdings/genvid-mcp-utils.git" }`
  - Add `prepack: "npm run build"`
  - Add top-level `description` (+ optional `homepage`/`bugs`/`keywords`)
  - Keep `version: 0.2.0`, `files`, dual-entry exports.
- **Task 2 — pnpm → npm:** `git rm pnpm-lock.yaml`; `npm install` → commit
  `package-lock.json`; confirm `npm run lint/typecheck/test/build` pass.
- **Task 3 — `.genvid-agent.json`:** `commands.*` `pnpm run …` → `npm run …`;
  `project.name` → `@genvid/mcp-utils`.
- **Task 4 — GitHub Actions:** add `.github/workflows/ci.yml` +
  `.github/workflows/publish.yml` verbatim from `genvid-public-ci/templates/`.
- **Task 5 — remove CircleCI:** `git rm -r .circleci/`.
- **Task 6 — docs:** `CLAUDE.md` (pnpm→npm, CircleCI→GitHub Actions, name refs);
  `README.md` (public install + scoped import example, drop "private package").
- **Task 7 — validation:** `npm run lint && typecheck && test && build` + `npm
  publish --dry-run` (confirm tarball has `dist/`, `LICENSE`, `README.md`).

## Release phase (after merge to `main`)

1. Merge migration PR → `main` (CI gate runs).
2. **🔴 MANUAL, npm-side, blocking:** bootstrap `@genvid/mcp-utils` per the runbook —
   granular token → placeholder publish (`0.2.0-bootstrap.0`) → register Trusted
   Publisher on npmjs.com (org `genvid-holdings`, repo `genvid-mcp-utils`, workflow
   `publish.yml`, env blank) → revoke token.
3. Tag `v0.2.0` and push → `publish.yml` runs gate + publishes with provenance.
4. Verify the provenance badge on npmjs.com.

## Risks

- **Blocking dependency:** release step 2 must complete before tagging or publish fails.
- Orphaned unscoped `genvid-mcp-utils@{0.0.1,0.2.0}` remain on npm — optionally
  `npm deprecate` them later (not in scope).
- `prepack` is redundant with the workflow's explicit build but included for
  local-publish safety.
