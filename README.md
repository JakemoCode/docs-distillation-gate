# docs-distillation-gate

A pre-push and CI check that measures how far a document fell between its draft
and its final commit, and blocks the ones that never fell.

Most documentation standards are a sentence in a contributing guide asking for
brevity, and nothing reads them. This one is a number taken from git history. A
document a branch drafts has to reach half the prose words of its own first
draft, or show a curve that stopped falling. The counting is done from the
commits themselves, so a claim of compression is proved rather than trusted.

I wrote it because a repository I work in had a stated 50 per cent compression
target, several agents writing documents into it, and no enforcement. Asking a
model to be concise produces a document that sounds concise. Measuring it
produces one that is.

## How the measurement works

The gate walks every commit on the branch and counts the prose words of each
gated document at each point. That series is the curve.

The baseline is the highest point, not the first. The method below converts to
Simplified Technical English before it cuts anything, and that conversion adds
words: taking the first commit as the baseline would bill the writer for the
grammar pass.

A document passes on any of three grounds.

| Ground | Test |
| --- | --- |
| Target | The current count is at or below half the baseline |
| Converged | Three or more recorded passes, the last two each removing under 5 per cent, and the current count at or below 65 per cent of the baseline |
| Floor | The baseline is under 50 prose words |

Prose is what a reader reads. Fenced blocks, inline code, HTML comments and
markdown syntax are not prose. A token has to carry a letter to count, so a
table of numbers is free and the words in its cells are not.

A document that already exists on the trunk is billed only for the lines the
branch added to it. Otherwise a five line addition to a long distilled document
could pass by trimming 4 per cent of the body it inherited.

## The method the gate enforces

The gate prints this whenever it blocks, because a check that says no without
saying what to do gets switched off.

1. Convert to ASD-STE100 Simplified Technical English. Grammar only.
2. Change the shape to a procedure, a table, or a list, if the content permits.
   You do not choose the shape. Step 1 reveals it.
3. Repeat: remove fluff, then count again. Fluff is restated context, duplicate
   sections, summaries of preceding text, and arguments another document
   already makes.

Run the grammar conversion before reshaping. Prose rhythm hides an empty
sentence and flat Simplified Technical English does not, so the right shape
only appears after conversion. Commit one pass at a time, because each commit
is one point on the curve.

## The stamp

A distilled document carries its curve on its first line.

```
<!-- distilled: 28654dce:AGENTS.md 351->172 (49.0%) pass=1 -->
```

The stamp decides nothing. The curve is counted from git either way. Its job is
provenance after the merge: a squash orphans the branch commits, and once they
are gone the curve can never be reconstructed. So the check proves the stamp
while the branch still exists. It resolves the revision named in the stamp,
counts the document there, and compares both the baseline and the whole curve
against what git measures. A stamp that disagrees blocks.

The leading field is a revision, not a bare hash. Run `git show` on it and the
draft comes back under the name it was drafted with, which is the one name a
later rename cannot invalidate.

When a document passes without a stamp, the gate prints the exact line to paste.
Nobody writes a stamp described in prose.

## Overrides

A commit trailer clears a block. It also clears a refusal to measure, but only
where the branch inherited the unclosed fence. One the branch opened has to be
closed.

```
Doc-distill-override: docs/wire-protocol.md would delete the wire format table
```

The trailer has to name a gated file and carry a reason. Nothing can verify
that the reason is true, so the control is attribution: the check reports each
override against the author of the commit that wrote it.

An override used after a real block is expected and gets one quiet line. An
override used where nothing was blocked means distillation was skipped outright,
and that one is reported loudly, with an Actions warning annotation. The count
of the second kind is what separates a gate calibrated wrong from a gate nobody
wants.

## Install

The gate is one file with no dependencies. Copying it in is the intended
route. The hook needs husky, which is the only thing here that is installed
rather than copied.

1. Copy `check-docs.mjs` to `scripts/check-docs.mjs`.
2. Add the scripts to `package.json`, and `npm install -D husky`:

```json
{
  "scripts": {
    "docs:check": "node scripts/check-docs.mjs",
    "prepare": "husky || true"
  }
}
```

3. Copy `install/docs.yml` to `.github/workflows/docs.yml`. Mark the
   `distillation-gate` check required in branch protection. Until then it
   reports without blocking.
4. Copy `install/pre-push` to `.husky/pre-push` and run `npm install` at the
   repository root. A workspace install does not write the hook.
5. Copy `test/check-docs.test.mjs` to `scripts/test/check-docs.test.mjs` if you want the suite, and run it with `node --test scripts/test/*.test.mjs`. Its import is `../check-docs.mjs`, so it has to sit one level below the gate. It needs no dependencies, and your `.docs-distill.json` does not affect it.

Run it by hand at any time:

```sh
npm run docs:check
```

Exit code 1 means at least one document blocked. The output names each one, its
baseline, its current count, and the count it has to reach.

## Configuration

Thresholds are constants at the top of `check-docs.mjs`, next to the reason for
each one. Three values differ between repositories, so those come from an
optional `.docs-distill.json` at the repository root.

| Key | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `main` | The trunk the merge base is taken from. `origin/<name>` is preferred when it exists |
| `include` | `["docs/**/*.md", "*.md"]` | An allowlist. A denylist includes everything by default, and one wrong pattern sends a whole vault of generated text through the gate |
| `ignore` | `[]` | Documents that grow by design: a changelog, a status register, an append-only log |

```json
{
  "baseBranch": "trunk",
  "ignore": ["docs/changelog.md", "notes/**"]
}
```

A malformed config throws. A gate that reads a broken config and then examines
nothing is worse than a gate that stops.

## Thresholds

| Constant | Value | What it does |
| --- | --- | --- |
| `TARGET_RATIO` | 0.5 | The pass mark, as a share of the baseline |
| `CONVERGED_CEILING` | 0.65 | The highest a converged curve may stop |
| `WEAK_PASS_RATIO` | 0.05 | Under this share removed, a pass is weak |
| `WEAK_PASSES_TO_CONVERGE` | 2 | Weak passes in a row before a curve converges |
| `MINIMUM_PASSES` | 3 | Guards thrashing |
| `SHORT_EDIT_FLOOR` | 50 | Baseline prose words below which the gate is off |
| `PARKED_SHARE` | 0.5 | Share of removed prose reappearing in code before it is reported |
| `PARKED_FLOOR` | 20 | Words below which parked prose is noise |

## Design choices worth knowing

| Choice | Why |
| --- | --- |
| Table contents count, markdown syntax does not | Otherwise drawing a table around text is cheaper than cutting it |
| Renames pair at 5 per cent similarity | Git's 50 per cent default is this gate's own pass mark, so a document renamed in the commit that distils it loses its history by construction |
| An unclosed fence blocks | One stray fence inverts the counter and makes every line after it free |
| Prose moved into code examples is reported, never blocked | Step 2 moves real prose into real examples, so the signal is strong but not certain, and a gate that blocks on a guess is a gate people turn off |
| The workflow has no paths filter | A required check that filters on paths never reports on a pull request that changes no document, and GitHub waits on it forever |

## Seeing what it measured

`--summary` names every document measured and the count taken from it, and
always writes a line. Silence under it means the gate never ran.

## What it cannot do

It cannot detect padding, and it measures process rather than quality. A writer
who drafts twice the length they intended passes it easily. The claim is
narrower than a quality bar: a document that shipped at its first length was
never edited, and this is what makes that visible.

CI cannot detect a missing hook, because both callers run the same script over
the same commits. A red run in Actions proves only that the block got past the
hook.

The 65 per cent ceiling was set from a small sample. Treat early curves in a new
repository as calibration data rather than as a verdict on the writer.

## Provenance

Extracted from a private game repository where it has gated every document since
August 2026. The three commits behind it are `feat: gate docs on measured
distillation`, `feat: print the stamp and catch parked prose`, and `feat: prove
the stamp against git`.

Changes made for release: the repository specific ignore list became the
optional config file, and the fixtures lost their private names. The measurement
is unchanged.

MIT licensed. 70 tests, `node --test`, no dependencies.
