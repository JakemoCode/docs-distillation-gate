<!-- distilled: 850429f:SCOPE-merge-attribution.md 1312->709->606 (46.2%) pass=2 -->
# Scope: who made a fall at a merge

Status: proposed, revised. It follows PR #8 and replaces PR #9 and the restart rule this scope first proposed.

## Problem

The baseline is the peak of the curve, which is correct only when the branch made each fall. A merge can take the full document from another parent.

Example, a stacked branch:

1. The child branch carries the 300-word draft of `docs/x.md` from its parent pull request.
2. The parent changes the draft to 140 words, and the trunk gets a squash merge of the parent.
3. The child merges the trunk and takes the 140-word version of the trunk.
4. The child adds 60 words. It does not distil them.

Main measures `[160, 0, 60]`: target 80, so the 60 words pass. The parent removed the 160 words, not the child.

## Rejected rules

PR #9 removed all points before a fall at a merge. Review found four errors: shapes 2, 3 and 4 below were blocked, and shape 5 passed on the floor without the stamp check or parking report. Shape 4 failed because the rule compared with the previous commit in `rev-list` order, not with the first parent.

A line rule also fails: "a line that leaves at a merge is a cut of the branch only when the first parent had it and the other parent did not." In the example, the 160 words are exactly such lines. A line does not show which resolver choice removed it.

The first version of this scope restarted the curve at a merge that took a trunk parent's copy. Two review rounds found that every point still came from all of `mergeBase..HEAD` in date order. A side commit dated after the restart brought the old draft back, a side branch's own trunk merge caused a restart, and an ancestry filter added to fix that dropped real drafting done on a side branch that the branch kept.

Measuring only the first-parent chain fails as well. The installed workflow checks out the merge ref, whose first parent is the trunk, so every pull request becomes one point and blocks. A `git pull` that merges a collaborator's commits drops their draft and stamp, and passes on a side branch the branch keeps fold into one step.

## Rule

The curve follows the prose that the document at HEAD holds, back through the commits that produced it.

Walk back from HEAD through the commit graph. At each merge, compare the document at the merge with the document at each parent:

- When the merge's copy is byte-identical to the copy at one or more parents, the merge took the document from them. Follow only those parents.
- When the merge's copy equals no parent's copy, the merge edited the document. Follow every parent.

The document is looked up under every name it has had. A merge that does not hold the document took that absence from a parent that does not hold it, but only when the document existed where that parent and the first parent last met. Otherwise a branch that deletes its own draft at a merge would lose its history and could pass a fenced copy on the floor.

The points of the curve are the branch commits that the walk reaches. A branch commit that the walk does not reach wrote prose that the document no longer holds.

This one rule gives each case its answer without a special case. A merge that takes the trunk's copy follows only the trunk parent, which is outside the branch, so the curve starts again after it. A merge that keeps the first parent's copy, as `-s ours` does, follows no side commit, so a discarded side branch cannot raise the peak. A side branch that the merge takes, a kept side branch, and a pulled collaborator's commits are followed, with their own drafts and passes. On the merge ref that the installed workflow checks out, the merge holds the head's copy, or edits both, so the walk follows the pull request. On the head that EngOS's workflow checks out, the walk starts at the head. Both must give the same curve.

Dates and parent order play no part.

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
| 7 | The trunk made the same change, so the merge equals both parents | `[110, 0]`, the trunk holds the 90 | target |
| 8 | A trunk merge changes a document that the branch did not touch | none | not examined |
| 9 | Two full trunk takes, then 30 new words | `[30]` | floor |
| 10 | An octopus merge with the trunk in any non-first position | as shape 1 | blocked |
| 11 | A stamp names a draft that the walk does not reach | none | the error says the document no longer holds that draft and asks for a new stamp |
| 12 | Shape 1, plus a side commit dated after the trunk take and merged later | `[60]` | blocked |
| 13 | A side branch takes the trunk's copy, and the branch discards that side with `-s ours` after it fences its draft | starts at the draft | parking report, no restart |
| 14 | The trunk deletes the document, the merge takes the deletion, and the branch writes 60 new words | `[60]` | blocked |
| 15 | The branch drafts a document the trunk never had, deletes it at a merge, and adds it again fenced | `[300, 40]` | target, parking report, stamp |
| 16 | Shape 1, but the branch renamed the document before the merge | `[60]` | blocked |
| 17 | After a trunk take, a side branch forked before it drafts 300, distils to 100, and is merged | `[300, 100]` | target |
| 18 | Passes made on a side branch that the merge keeps: 300, 180, 170, 165 | `[300, 180, 170, 165]` | converged |
| 19 | `git pull` merges a collaborator's draft and passes into a local commit | the collaborator's curve | as it was before the pull, stamp kept |
| 20 | The installed workflow's merge ref, against the same branch's head | the head's curve | the head's verdict |
| 21 | Distil 200 to 140, then `-s ours` merge of a side branch at 300 | `[200, 140]` | blocked |
| 22 | A stacked child merges its parent feature branch, which drafted 300 and distilled to 140 | `[300, 140]` | target |

## Limit

A resolver can take most of the trunk version and keep some branch lines. Then the merge is equal to no parent, and the gate follows every parent, so the branch's earlier peak stays. Shapes 2 and 3 need that reading. The README will state this limit.

Git older than 2.31 has no `--diff-merges`, so a rename made by a merge can go unseen. The README already states this.

## Implementation, in a follow-up pull request

- `branchOf` lists the branch range with its parents from one `rev-list --parents`.
- `measureCurve` walks back from HEAD per document, following parents by the rule, and keeps the points of the commits it reaches.
- The curve, the baseline, the parking report and `verifyStamp` use those points.
- Each shape gets a test written first, and each condition of the rule gets a mutation that fails its shape's test. Run `/code-review high`.
