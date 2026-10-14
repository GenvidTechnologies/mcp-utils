# A mutation graded MISSED against a correct test — captured 2026-10-14

Capture from the `#29` (ObservedState directory round trip) mutation run, recorded
the same day. The public record is the "Mutation evidence" comment on
https://github.com/GenvidTechnologies/mcp-utils/issues/29
(https://github.com/GenvidTechnologies/mcp-utils/issues/29#issuecomment-6175690417),
readable with `gh issue view 29 --comments`. The facts below were verified against
that comment by the maintainer of this run. The mutation harness itself was a
session-scratchpad script that was never committed, so the comment and this file
are its only durable record; the mutations are re-runnable by hand against
826b943 from the descriptions the comment gives.

Environment: Windows 11, Node 24.11.1, branch
`fix/observedstate-directory-round-trip` at HEAD `826b943`, full mocha suite per
mutation: 357 tests (2 skipped). One mutation at a time against the committed
`src/observedState.ts`, each anchor asserted to match exactly once, byte-exact
restore and `git diff --quiet` after every run.

---

## 1. The code under mutation

The fix re-checks a directory's whole subtree when its ctime moves.
`recordChildren` walks the subtree, and `dropUnfound` drops recorded files the
walk did not find, descending **every** level below the directory.

## 2. The mutation that was graded MISSED

M4 cut only the walk to direct children
(`walkFiles(...).filter(f => path.dirname(f) === dirPath)`). The test pledged to
catch it, O58 ("a round trip of an ancestor with an edit two levels down reports
the ancestor changed"), stayed **green**. The harness graded M4 `MISSED`.

| Mutation | Predicted | Failed | Verdict |
|---|---|---|---|
| M4 re-check walk limited to direct children | O58 | O28 O46 W7 W8 W19 W24 O52 O53, not O58 | MISSED |
| M4b walk and stale drop limited to direct children | O58 | O58 O46 W7 W8 W19 W24 O52 O53 | caught |

## 3. Why O58 stayed green

With only the walk cut, the grandchild `P/D/a.txt` is absent from the found set.
`dropUnfound` then drops it as a live file, and `isChanged(P)` still returns
true. Depth is enforced twice, in the walk and in the drop, so cutting one site
leaves the other producing the same observable result. Cutting both (M4b) makes
O58 fail, as pledged.

## 4. What the "extra" failures were

The walk-only defect was caught all along, by five other tests sharing the same
helper (O28, O46, W7, W8, W19, which also serves the never-seen-directory scan).
They appear in M4's failure list as tests beyond the prediction.

## 5. The verdict was a false red

The harness reported a test gap against a correct test. The comment records it as
"M4 prediction was wrong, not the test." Acting on the verdict would have meant
strengthening O58, which needed nothing.
