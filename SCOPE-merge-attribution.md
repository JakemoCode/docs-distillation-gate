# Scope: who made a fall at a merge

Status: proposed, for review before any implementation. It follows PR #8, which fixed what each commit is billed against, and it replaces PR #9, whose rule review showed to be wrong.

## The problem

The gate reads a document's curve across every commit on the branch, takes the highest point as the baseline, and asks whether the branch brought the count down to half of it or converged. That works when every fall in the curve is something the branch did to its own prose. A merge breaks that assumption, because a merge commit can change a document without the branch author writing anything: it can take another branch's version of the document wholesale.

The case that found this is a stacked branch. The child branch is cut from its parent pull request and carries the parent's 300-word draft of `docs/x.md`. The parent is then distilled to 140 words on its own branch and squash-merged, so the trunk holds the distilled document under a commit the child never had. The child merges the trunk and takes the trunk's 140-word version wholesale, then adds 60 words of its own that it never distils.

The gate measures `[160, 0, 60]` for that history today, on main after PR #8 as well as before it. The 160 are the draft's lines that are not in the trunk's squash. They leave the document at the merge. The peak is 160, so the target is 80, and the child's 60 undistilled words pass on target. The child never cut anything. The parent's pull request did the distilling, and its own run of the gate judged it there.

## Why PR #9's rule was wrong

PR #9 treated any fall at a merge commit as a version taken from elsewhere and threw away every point before the merge. Review reproduced four histories where that is wrong:

1. A branch that distilled 200 words to 90 and passed, then cleanly merged a trunk that had edited ten other lines of the same document, was blocked. On main before PR #8 the trunk's rewritten lines made the merge read as a fall.
2. A branch that drafted 200 words and cut them to 90 while resolving a conflict in the merge commit was blocked. That cut was the branch's own work.
3. A branch that merged a side branch with `-s ours` was blocked, because the rule compared the merge with the previous commit in `rev-list` order rather than with the merge's first parent, and the side branch's last commit held more words.
4. A merge commit that moved 260 words of an undistilled draft into a fenced block dropped the peak under the 50-word floor. The document then passed on the floor, which skips the stamp check and silences the parking report. That loosened the gate.

## Why the line-level rule is also wrong

The first version of this design, relayed in the decision that asked for this scope, said: a line removed at a merge is the branch's own cut only when the first parent had it and the other parent did not. In the stacked-squash history, the 160 lines that leave at the merge are exactly the lines the first parent had and the trunk did not. That rule would count them as the branch's cut, and the child would still pass. At the level of single lines, a resolver who takes the trunk's version and a resolver who cuts their own prose look the same.

## The rule

The signal that is not ambiguous is the whole document. When a merge leaves a document byte-identical to the trunk's version of it, and different from the version on the merge's first parent, the branch took the trunk's document wholesale. Whatever the branch had written into that document before the merge is no longer in it. The earlier points describe prose the branch no longer holds, so they cannot set a baseline for prose the branch writes afterwards.

In that case, and only that case, the gate measures the document from the merge on. The merge commit's own point is measured as usual, against the current merge base, and later points follow it.

"The trunk's version" means the document at a parent of the merge, other than the first parent, that the trunk contains: a parent that is an ancestor of the merge base the gate measures against. A merge that takes a side branch's version wholesale is measured as an ordinary commit. That keeps the rule from being a way to launder a draft: an author who builds a side branch holding the draft moved into a fence, then merges it wholesale, gets today's verdict, with the stamp check and the parking report.

The comparison is against the first parent, not against the previous point in `rev-list` order. That is the error behind PR #9's third failure.

Restarting the curve can only remove candidates for the peak, and the prose present at the merge is still billed at the merge's own point. It cannot hide a word the document still holds.

## Shapes and the verdict each must give

Every shape below gets a test that builds the history in a throwaway repository. The new behavior's test is written first and fails on main.

| # | History | Expected curve | Expected verdict |
| --- | --- | --- | --- |
| 1 | Stacked child: carries a 300-word parent draft, merges a trunk holding the parent's 140-word squash by taking it wholesale, adds 60 words | `[60]` | blocked |
| 2 | Branch distils 200 to 90, trunk edits ten other lines of the same document, clean merge | `[200, 90]` | passes on target |
| 3 | Branch drafts 200 words, merges the trunk with `--no-commit`, cuts the document to 90 in the merge commit | `[200, 90]` | passes on target |
| 4 | Branch distils 200 to 100, then merges a side branch with `-s ours` whose own commit held 300 | `[200, 100]` | passes on target |
| 5 | Branch drafts 300 words, a merge commit moves 260 of them into a fenced block | `[300, 40]` | passes on target, parking report printed, stamp required |
| 6 | As 5, but the fence move is made on a side branch and merged wholesale | `[300, 40]` | as 5: a side branch never restarts the curve |
| 7 | Branch distils 200 to 90 and the trunk has independently made the identical change, so the merge equals both parents | `[200, 90]` | passes on target: no restart when the first parent already matches |
| 8 | Branch merges a trunk that changed a document the branch never touched | not examined | the document has no branch prose |
| 9 | Two trunk merges, each taking the trunk's version wholesale, the second followed by 30 new words | `[30]` | passes on the floor: the latest restart wins |
| 10 | An octopus merge where one non-first parent is the trunk and the document equals that parent's | as 1 | the trunk parent qualifies whichever position it holds |
| 11 | A stamp written before a restart names a draft commit the restarted curve no longer holds | n/a | the gate says the curve restarted at the merge, names it, and asks for a new stamp, instead of calling the draft "not a commit of this branch" |

## What it does not handle

A resolver who takes most of the trunk's version but keeps a few of the branch's own lines leaves a document equal to neither parent. The gate reads that merge as the branch's own edit, so a fall there counts as distillation. Nothing in git separates that resolver's intent from a deliberate cut, and the shapes above that must keep passing (2 and 3) depend on reading a mixed merge as the branch's edit. The README will name this limit.

## Implementation, in the follow-up pull request

- `branchOf` learns which commits are merges and their parents, from one `rev-list --parents` over the branch range, and which of those parents the trunk contains.
- `measureCurve` compares the document's blob at each merge with the blob at its first parent and at each trunk parent, by name, and records the latest restart.
- The curve, the baseline and the parking report read the points from that restart on. `verifyStamp` reports a stamp that names a commit before the restart in its own words.
- `/code-review high` on the implementation, and a mutation of each condition in the rule (wholesale, trunk parent, first parent, latest restart) that fails its shape's test.
