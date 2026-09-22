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

It runs twice: as a pre-push hook on your machine, and again in CI.

## How to use it

### Install

It's one file with no dependencies. You copy it into your repo. Husky, for the
hook, is the only thing you actually install.

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

3. Copy `install/docs.yml` to `.github/workflows/docs.yml`. Then mark the
   `distillation-gate` check as required in branch protection. Until you do,
   it reports but doesn't block.
4. Copy `install/pre-push` to `.husky/pre-push` and run `npm install` at the
   repo root. A workspace install won't write the hook.
5. Optional: copy `test/check-docs.test.mjs` to
   `scripts/test/check-docs.test.mjs` and run it with
   `node --test scripts/test/*.test.mjs`. It imports `../check-docs.mjs`, so it
   has to sit one folder below the gate. Your `.docs-distill.json` doesn't
   affect it.

### Run it

```sh
npm run docs:check
```

Exit code 1 means at least one document is blocked. For each one, the output
shows where it started, where it is now, and the number it needs to reach.

Add `--summary` to see what it actually looked at. It lists every document it
measured with the word count it took, and it always prints at least one line.
If you get nothing at all, the gate never ran. The CI workflow in `install/`
uses it for that reason: without it, a gate that checked nothing and a gate
that found nothing both come back green and silent.

### When it blocks you

Cut the document in passes and commit after each one. Every commit adds a point
to the curve the gate reads. The gate prints this method every time it blocks:

1. Rewrite it in ASD-STE100 Simplified Technical English. Only fix the grammar
   at this step.
2. If the content allows it, turn it into a procedure, a table, or a list. Don't
   choose the shape yourself. Step 1 shows you what it is.
3. Cut the fluff and count again. Repeat. Fluff means restated context,
   duplicate sections, summaries of what you just said, and arguments another
   doc already makes.

Do the grammar pass first. Flowing prose hides empty sentences, and flat
technical English doesn't, so the right shape only shows up after you convert.

### The stamp

When a document passes, the gate prints a line to paste at the top of it:

```
<!-- distilled: 28654dce:AGENTS.md 351->172 (49.0%) pass=1 -->
```

That line is the document's history: the draft it started from, the word count
at each pass, and how far it fell. You need it because a squash merge throws the
branch commits away, and after that nobody can rebuild the curve. While the
branch still exists, the gate checks the stamp against git. If the numbers
disagree, it blocks.

The first field is a revision plus the file's name at that point. `git show` on
it brings back the original draft even if the file got renamed later.

### Overriding a block

Put a trailer in a commit message. It has to name a gated file and give a
reason:

```
Doc-distill-override: docs/wire-protocol.md would delete the wire format table
```

The gate can't check whether your reason is true, so it records who wrote it
instead. An override on a real block gets one quiet line in the output. An
override where nothing was blocked means someone skipped distilling entirely.
That one gets a loud Actions warning, and the number of those tells you whether
the gate is set wrong or people just don't want it.

The trailer also clears a refusal to measure, if the branch inherited an
unclosed code fence. If your branch opened the fence, you have to close it.

### Configuration

Most settings are constants at the top of `check-docs.mjs`, each with a comment
saying why. Three change from repo to repo, so they live in an optional
`.docs-distill.json` at the repo root:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `main` | The trunk to compare against. Uses `origin/<name>` when it exists |
| `include` | `["docs/**/*.md", "*.md"]` | Which files get checked. It's an allowlist because one bad pattern in a denylist can pull a whole folder of generated text through the gate |
| `ignore` | `[]` | Files that are supposed to grow: a changelog, a status register, an append-only log |

```json
{
  "baseBranch": "trunk",
  "ignore": ["docs/changelog.md", "notes/**"]
}
```

A broken config file throws an error. A gate that silently checks nothing is
worse than one that stops.

## Why I built it

A repo I work in had a 50% compression target for docs, several AI agents
writing docs into it, and nothing enforcing the target. Asking a model to be
concise gets you a document that sounds concise. Measuring it gets you one
that is.

Most doc standards are a line in a contributing guide asking people to keep it
short, and nobody reads that line. This one is a number pulled from git
history, so nobody has to take your word that you cut anything.

## How it works

### Counting

The gate walks every commit on the branch and counts the prose words in each
gated document at each commit. That list of counts is the curve.

Only prose counts. Code blocks, inline code, HTML comments, and markdown syntax
don't. A word has to contain a letter, so a table of numbers is free, but the
words in a table's cells still count.

The starting point is the longest draft, not the first one. Step 1 of the
method adds words when it rewrites the grammar, and measuring from the first
commit would punish you for that.

If a document already exists on the trunk, the gate only counts the lines your
branch added. Otherwise you could add five lines to a long doc and pass by
trimming 4% of text you didn't write.

### Passing

A document passes if any of these is true:

| Rule | Test |
| --- | --- |
| Target | It's at 50% or less of its longest draft |
| Converged | At least 3 passes, the last 2 each cut less than 5%, and it's at 65% or less of its longest draft |
| Floor | The longest draft was under 50 prose words |

### Thresholds

| Constant | Value | What it does |
| --- | --- | --- |
| `TARGET_RATIO` | 0.5 | The pass mark, as a share of the longest draft |
| `CONVERGED_CEILING` | 0.65 | The highest a converged curve can stop and still pass |
| `WEAK_PASS_RATIO` | 0.05 | A pass that cuts less than this is weak |
| `WEAK_PASSES_TO_CONVERGE` | 2 | Weak passes in a row before a curve counts as converged |
| `MINIMUM_PASSES` | 3 | Passes needed before a curve can count as converged |
| `SHORT_EDIT_FLOOR` | 50 | Below this many prose words, the gate doesn't apply |
| `PARKED_SHARE` | 0.5 | How much cut prose has to reappear in code before it's reported |
| `PARKED_FLOOR` | 20 | Below this many words, parked prose is ignored |

### Choices that might surprise you

| Choice | Why |
| --- | --- |
| Table text counts, markdown syntax doesn't | Otherwise wrapping text in a table would be cheaper than cutting it |
| Renames are detected at 5% similarity | Git's default is 50%, which is also this gate's pass mark. A doc renamed in the same commit that cuts it in half would lose its history every time |
| An unclosed code fence blocks | One stray fence flips the counter, and every line after it stops counting |
| Prose moved into code examples is reported, never blocked | Step 2 legitimately moves prose into examples, so it's a strong signal but not proof. People turn off gates that block on a guess |
| The CI workflow has no paths filter | A required check with a paths filter never runs on a PR that doesn't touch docs, and GitHub waits for it forever |

### What it can't do

It can't catch padding. It measures whether you edited, not whether the result
is good. Someone who writes a draft twice as long as they meant to will pass
easily. The actual claim is smaller: a document that shipped at its first
length was never edited, and this makes that visible.

CI can't tell if someone skipped installing the hook, because both run the same
script on the same commits. A red run in Actions only proves something got past
the hook.

The 65% ceiling came from a small sample. In a new repo, treat the first few
curves as calibration, not as a verdict on whoever wrote them.

## Where it came from

I pulled it out of a private game repo, where it has checked every doc since
August 2026. The three commits behind it are `feat: gate docs on measured
distillation`, `feat: print the stamp and catch parked prose`, and `feat: prove
the stamp against git`.

For this release, the repo-specific ignore list became the optional config file
and the test fixtures lost their private names. The measurement is the same.

MIT licensed. 82 tests, run with `node --test`, no dependencies.
