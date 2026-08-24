# Wiki Log

Record of every `ingest` run: what changed, why, and which `raw/` source
drove it, grouped under `## YYYY-MM-DD` date headings (ISO 8601) with the
**newest date group first**. Entries are prose bullets, e.g. `* **Update**:
…`, `* **Creation**: …`, `* **Deprecation**: …` — the leading bold word is a
convention, not a requirement.

**Add newest first, never edit or remove a prior entry.** "Newest first"
means a new entry (and, if today isn't already the top group, a new
`## YYYY-MM-DD` heading) is *prepended* above everything else — the
insertion point moves from the bottom to the top, but prepending never
touches a prior entry's text, so the append-only guarantee holds exactly as
before. If a past entry itself needs correcting, add a new entry that says
so; never edit or remove the old one in place. See `docs/wiki-schema.md` for
the full maintenance schema.

## 2026-08-24

* **Update**: failure-modes-that-report-success.md — added a seventh
  instance (a probe that ran correctly against an entry point the system
  never uses: the MCP SDK normalises a resource URI through `new URL()`
  before matching it against a resource template, so an isolated
  `UriTemplate.match()` probe measured a case no caller can produce). It is
  the first instance on the page where the check *did* run and reported
  truthfully, which is why the closing rule gained a second question.
  Driven by `raw/2026-08-24-isolated-probe-scope-error.md`.

## 2026-08-16

* **Update**: failure-modes-that-report-success.md — added a sixth instance
  (a subagent self-report whose countable claims were wrong while its
  structural claims were correct), driven by
  `raw/2026-08-16-subagent-self-report-discrepancy.md`.
* **Creation**: failure-modes-that-report-success.md, driven by
  `raw/2026-08-16-verification-traps-excerpts.md`.
