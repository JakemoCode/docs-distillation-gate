# docs-distillation-gate

## What it does

Agents love prose. Prose rots brains. This forces agents to rewrite or
altogether remove prose, until a document is half its size or cutting stops
paying off.

Every commit of a draft is a data point: the gate counts its prose words. When
you push, it reads those counts as a curve, and a document passes one of two
ways:

- **It hit the target.** It's at half its longest draft or less.
- **It converged.** It has had at least 3 passes, the last 2 each cut less than
  5%, and it stopped at 65% or less of its longest draft.

Otherwise the push fails, and the gate tells you how many words you still need
to cut. Documents under 50 prose words are exempt.

It runs as a pre-push hook, then again in CI.

## How to use it

### Install

It's one file with no dependencies, so you copy it in. Only Husky, for the
hook, gets installed.

1. Copy `check-docs.mjs` to `scripts/check-docs.mjs`.
2. Add these scripts to `package.json` and run `npm install -D husky`:

```json
{
  "scripts": {
    "docs:check": "node scripts/check-docs.mjs",
    "prepare": "husky || true"
  }
}
```

3. Copy `install/docs.yml` to `.github/workflows/docs.yml`, then mark the
   `distillation-gate` check required in branch protection. Until then it
   reports but doesn't block.
4. Copy `install/pre-push` to `.husky/pre-push` and run `npm install` at the
   repo root. A workspace install won't write the hook.
5. Optional: copy `test/check-docs.test.mjs` to
   `scripts/test/check-docs.test.mjs` and run
   `node --test scripts/test/*.test.mjs`. It imports `../check-docs.mjs`, so it
   has to sit one folder below the gate.

### Run it

```sh
npm run docs:check
```

Exit code 1 means something is blocked, and the output shows each one's peak,
current count, and target.

Add `--summary` to list every document it measured and the count it took.
It always prints something, so silence means the gate never ran. CI uses it
so a gate that checked nothing can't pass for one that found nothing.

### When it blocks you

Cut in passes, one commit each. The gate prints this method whenever it
blocks:

1. Rewrite in ASD-STE100 Simplified Technical English. Grammar only.
2. Turn it into a procedure, a table, or a list if the content allows. Step 1
   shows you which.
3. Cut the fluff and count again. Repeat. Fluff is restated context, duplicate
   sections, summaries of what you just said, and arguments another doc already
   makes.

Do the grammar first. Flowing prose hides empty sentences, and flat technical
English doesn't.

### The stamp

When a document passes, the gate prints a line to paste at the top of it:

```
<!-- distilled: 28654dce:AGENTS.md 351->172 (49.0%) pass=1 -->
```

A squash merge throws away the branch commits, and the curve goes with them.
The stamp keeps it. While the branch still exists, the gate checks the stamp
against git and blocks if they disagree. `git show` on the first field brings
back the original draft, even after a rename.

### Overriding a block

Add a trailer to a commit message naming the file and the reason:

```
Doc-distill-override: docs/wire-protocol.md would delete the wire format table
```

Nothing can check the reason, so the gate reports who wrote it. An override on
a real block gets one quiet line. An override where nothing was blocked means
someone skipped distilling, and that one gets an Actions warning.

The trailer also clears an unclosed code fence your branch inherited. One your
branch opened, you have to close.

### Configuration

Thresholds are constants at the top of `check-docs.mjs`, each with its reason.
Three settings live in an optional `.docs-distill.json` at the repo root:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `main` | The trunk to compare against. Uses `origin/<name>` when it exists |
| `include` | `["docs/**/*.md", "*.md"]` | Which files get checked. An allowlist, because one bad denylist pattern can pull a folder of generated text through |
| `ignore` | `[]` | Files meant to grow, like a changelog or an append-only log |

```json
{
  "baseBranch": "trunk",
  "ignore": ["docs/changelog.md", "notes/**"]
}
```

A broken config throws instead of silently checking nothing.

## Why I built it

A repo I work in had a 50% compression target for docs, several agents writing
docs, and nothing enforcing it. Ask a model to be concise and you get a document
that sounds concise. Measure it and you get one that is.

## How it works

The gate walks every commit on the branch and counts the prose words in each
gated document. Code blocks, inline code, HTML comments, and markdown syntax
don't count. A word needs a letter, so a table of numbers is free, but words in
table cells aren't.

The baseline is the longest draft, not the first, because step 1 adds words.

A document that already exists on the trunk is only billed for the lines your
branch added. Otherwise you could add five lines to a long doc and pass by
trimming 4% of text you didn't write.

### Choices that might surprise you

| Choice | Why |
| --- | --- |
| Table text counts | Otherwise wrapping text in a table beats cutting it |
| Renames match at 5% similarity | Git's default is 50%, this gate's pass mark, so a doc renamed while being halved would lose its history |
| An unclosed code fence blocks | One stray fence flips the counter and every line after it goes free |
| Prose moved into code is reported, not blocked | Step 2 moves prose into examples on purpose. People turn off gates that block on a guess |
| The CI workflow has no paths filter | A required check with one never runs on a PR without doc changes, and GitHub waits forever |

### What it can't do

It can't catch padding. It measures whether you edited, not whether the result
is good. A document that shipped at its first length was never edited, and
that's all this makes visible.

CI can't tell if the hook is missing, since both run the same script on the
same commits.

The 65% ceiling came from a small sample, so treat early curves as
calibration.

## Where it came from

I pulled it out of a private game repo, where it has checked every doc since
August 2026.

MIT licensed. 82 tests, `node --test`, no dependencies.
