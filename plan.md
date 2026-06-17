# Plan: `resolveRootFolder` — generic project-root resolution (issue #7)

Add a generic, project-agnostic `resolveRootFolder` utility that resolves a
project root via the usual precedence chain (`explicit > env > discovery > cwd`),
so bundled MCP servers don't each hand-roll it. Sibling to `loadProjectConfig` /
`resolveWithin`. Consumers: `construct3-chef#94`, `c3-domain-manager#16`.

**Branch:** `feat/resolve-root-folder`

## Decisions (from full-proposal shortcut checkpoint)

- **Return shape:** `{ path, source } | CallToolResult`. Success carries the
  resolved absolute `path` plus `source: "explicit" | "env" | "discovery" |
  "cwd"`, so consumers can log how the root was found and warn on the silent
  cwd fallback (`source: "cwd"` ⇔ no marker found anywhere). Error case mirrors
  `loadProjectConfig` (`CallToolResult` via `mcpError`, narrowed by `isMcpError`).
- **Containment:** explicit/env overrides are trusted — resolved to absolute
  (relative values against `cwd`) but never containment-restricted. A relative
  `../sibling-project` override is allowed. Only auto-discovery stays naturally
  within `cwd`.
- **No ADR:** Phase 2 (designer) was skipped via the full-proposal shortcut and
  the change is purely additive — ADR threshold not met.

## API

```ts
export interface ResolveRootFolderOpts {
  explicit?: string;     // wins if set & non-empty (e.g. CLI --project-dir)
  envVar?: string;       // name of env var to honor next
  marker: string;        // filename/dirname identifying a root, e.g. "project.c3proj"
  cwd?: string;          // default process.cwd()
  searchDepth?: number;  // how deep to search for marker, default 1
}

export interface ResolvedRoot {
  path: string;                                        // absolute
  source: "explicit" | "env" | "discovery" | "cwd";
}

export function resolveRootFolder(
  opts: ResolveRootFolderOpts,
  env?: NodeJS.ProcessEnv,   // test seam, default process.env
  readdir?: ReaddirSync,     // test seam, default fs.readdirSync (matches walkFiles)
): ResolvedRoot | CallToolResult;   // never throws; narrow error with isMcpError
```

## Resolution algorithm (precedence: explicit > env > discovery > cwd)

1. `cwd = opts.cwd ?? process.cwd()`. Relative `explicit`/`env` values →
   `path.resolve(cwd, value)`; absolute → as-is. No containment check on these.
2. **explicit** — `opts.explicit?.trim()` truthy → `{ path, source: "explicit" }`.
3. **env** — `opts.envVar` set and `env[opts.envVar]?.trim()` truthy →
   `{ path, source: "env" }`.
4. **discovery**:
   - `cwd` contains `marker` (level 0) → `{ path: cwd, source: "discovery" }`.
   - Else search levels `1..searchDepth` for directories containing `marker`:
     - exactly 1 → `{ path: match, source: "discovery" }`
     - ≥2 → `mcpError("resolveRootFolder: ambiguous root — N directories contain
       <marker>")` with the matches as extra lines.
     - 0 → fall through.
5. **cwd fallback** — `{ path: cwd, source: "cwd" }`.

## Edge cases / conventions

- **Never-throws** (joins the `loadProjectConfig` family): all `readdir` I/O
  wrapped — `ENOENT` (dir absent) → no match; any other I/O error → `mcpError`.
- Empty/whitespace `marker` → `mcpError("resolveRootFolder: marker is required")`.
- Marker matched by name (works for a file like `project.c3proj` or a dir like `.git`).
- **Sync**, single injectable `readdir` seam — mirrors `walkFiles`.

## Test criteria (TDD)

explicit (abs + rel) · env (set/empty/unset) · precedence ordering ·
cwd-has-marker · single discovery at depth 1 and deeper · ambiguous ≥2 →
mcpError · nothing-found → `source:"cwd"` · empty marker → mcpError ·
non-ENOENT I/O error → mcpError · `..`-escaping explicit allowed.

## Tasks (one commit each)

1. **ts-implementer** — TDD: `test/resolveRootFolder.test.ts` +
   `src/resolveRootFolder.ts`, export from `src/index.ts`. → validator → commit.
2. **tech-writer** — add the utility to `README.md` (Filesystem & path group)
   and the `CLAUDE.md` utilities list. → validator → commit.
3. **code-reviewer** at end.
