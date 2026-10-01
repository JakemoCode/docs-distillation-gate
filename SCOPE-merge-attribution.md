# Scope: who made a fall at a merge

Status: proposed. It follows PR #8 and replaces PR #9.

## Problem

The baseline is the peak of the curve, which is correct only when the branch made each fall. A merge can take the full document from another parent.

Example, a stacked branch:

1. The child branch carries the 300-word draft of `docs/x.md` from its parent pull request.
2. The parent changes the draft to 140 words, and the trunk gets a squash merge of the parent.
3. The child merges the trunk and takes the 140-word version of the trunk.
4. The child adds 60 words. It does not distil them.

Main measures `[160, 0, 60]`: target 80, so the 60 words pass. The parent removed the 160 words, not the child.

## Rejected rules

PR #9 removed all points before a fall at a merge. Review found four errors:

shapes 2, 3 and 4 below were blocked, and shape 5 passed on the floor without the stamp check or parking report. Shape 4 failed because the rule compared with the previous commit in `rev-list` order, not with the first parent.

A line rule also fails: "a line that leaves at a merge is a cut of the branch only when the first parent had it and the other parent did not." In the example, the 160 words are exactly such lines. A line does not show which resolver choice removed it.

## Rule

At a merge commit, the gate measures a document from that merge on when both conditions are true:

- The document at the merge is byte-identical to the document at a trunk parent. A trunk parent is a parent other than the first parent that is an ancestor of the merge base.
- The document at the merge is different from the document at the first parent.

The earlier points then measure prose the document does not contain. The latest such merge applies.

A side branch never causes a restart, so it cannot hide a fenced draft from the stamp check (shape 6).

A restart only removes peak candidates. The merge point bills the prose that the document contains at the merge.

## Shapes

Each shape gets a test, written first, that builds the history in a temporary repository.

| # | History | Curve | Verdict |
| --- | --- | --- | --- |
| 1 | The example above | `[60]` | blocked |
| 2 | Distil 200 to 90, then merge a trunk that changed 10 other lines | `[200, 90]` | target |
| 3 | Draft 200, then cut to 90 in the merge commit | `[200, 90]` | target |
| 4 | Distil 200 to 100, then `-s ours` merge of a side branch at 300 | `[200, 100]` | target |
| 5 | Draft 300, then a merge moves 260 into a fence | `[300, 40]` | target, parking report, stamp |
| 6 | Shape 5, but the fence move is on a side branch that the merge takes fully | `[300, 40]` | as shape 5 |
| 7 | The trunk made the same change, so the merge equals both parents | `[200, 90]` | target |
| 8 | A trunk merge changes a document that the branch did not touch | none | not examined |
| 9 | Two full trunk takes, then 30 new words | `[30]` | floor |
| 10 | An octopus merge with the trunk in any non-first position | as shape 1 | blocked |
| 11 | A stamp names a draft before a restart | none | the error names the restart merge and asks for a new stamp |

## Limit

A resolver can take most of the trunk version and keep some branch lines. Then the merge is equal to no parent, and the gate reads it as a branch edit. Shapes 2 and 3 need that reading. The README will state this limit.

## Implementation, in a follow-up pull request

- `branchOf` gets merges, their parents, and the trunk parents from one `rev-list --parents`.
- `measureCurve` compares blobs at each merge with its first parent and its trunk parents, and records the latest restart.
- The curve, the baseline, and the parking report use the points from the restart. `verifyStamp` names the restart.
- Run `/code-review high`. For each condition (identical, trunk parent, first parent, latest), make a mutation that causes its shape test to fail.
