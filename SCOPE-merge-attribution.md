<!-- distilled: ca8217d:SCOPE-merge-attribution.md 818->384 (46.9%) pass=1 -->
# Scope: who made a fall at a merge

Status: implemented. It follows PR #8 and replaces PR #9 and this scope's first rule.

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

This scope first restarted the curve at a merge that took a trunk copy. Points still came from `rev-list` date order, so shapes 12, 13 and 17 failed.

First-parent points also fail. The merge ref's first parent is the trunk, so CI sees one point. Shapes 18 and 19 lose their passes.

## Rule

The curve follows the prose of the document at HEAD back through the commits that made it. Walk back from HEAD. At each merge:

- If the merge's copy equals the copy at some parents, follow only those parents.
- Otherwise the merge edited the document. Follow every parent.

Look up the document under every name it had. An absent copy matches an absent parent only if the document existed where that parent and the first parent met (shape 15).

The points are the branch commits that the walk reaches, in ancestry order. Dates order only commits on parallel lines. The merge ref and the head give the same curve (shape 20).

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
| 7 | The trunk made the same change, so the merge equals both parents | `[110, 0]` | target |
| 8 | A trunk merge changes a document that the branch did not touch | none | not examined |
| 9 | Two full trunk takes, then 30 new words | `[30]` | floor |
| 10 | An octopus merge with the trunk in any non-first position | as shape 1 | blocked |
| 11 | A stamp names a commit the walk does not reach | none | the error says so |
| 12 | Shape 1, plus a later-dated side commit | `[60]` | blocked |
| 13 | A side branch takes the trunk copy; the branch fences its draft and discards the side | from the draft | parking report |
| 14 | The merge takes the trunk's deletion; 60 new words | `[60]` | blocked |
| 15 | A merge deletes a document the trunk never had; it returns fenced | `[300, 40]` | as shape 5 |
| 16 | Shape 1 after a rename | `[60]` | blocked |
| 17 | A side branch forked before a trunk take: 300 to 100, kept | `[300, 100]` | target |
| 18 | Kept side-branch passes 300, 180, 175, 171 | the same | converged |
| 19 | `git pull` of a collaborator's draft and passes | theirs | unchanged, stamp kept |
| 20 | The merge ref against the head | the head's | the head's |
| 21 | Distil 200 to 140, then `-s ours` side at 300 | `[200, 140]` | blocked |
| 22 | A child merges its parent branch: 300 to 140 | `[300, 140]` | target |

## Limit

A resolver can take most of the trunk version and keep some branch lines. Then the merge equals no parent, the walk follows every parent, and the earlier peak stays. Shapes 2 and 3 need that reading. The README will state this limit.
