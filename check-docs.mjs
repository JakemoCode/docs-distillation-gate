#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The documentation distillation gate. See README.md.
//
// Thresholds stay hardcoded here, where a reader sees each number next to the
// reason for it. Only the three values that cannot be the same in two
// repositories are read from a file.

// Optional. Absent, the defaults below apply. Malformed, the gate throws:
// a gate that reads a broken config and then examines nothing is worse than
// a gate that stops.
const CONFIG_FILE = '.docs-distill.json';

const DEFAULTS = {
  baseBranch: 'main',
  include: ['docs/**/*.md', '*.md'],
  ignore: [],
};

function loadConfig(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, CONFIG_FILE), 'utf8');
  } catch {
    return DEFAULTS; // no file is the ordinary case
  }
  return { ...DEFAULTS, ...JSON.parse(raw) };
}

const CONFIG = loadConfig(process.cwd());

// Tuning knobs. Every one of these is a number to move, not a component to
// rebuild. Watch them against real curves before changing any.
const TARGET_RATIO = 0.5; // the target: half the baseline
const CONVERGED_CEILING = 0.65; // a curve that cannot reach half may stop here
const WEAK_PASS_RATIO = 0.05; // a pass removing less than this is weak
const WEAK_PASSES_TO_CONVERGE = 2; // two, so one weak pass cannot stop early
const MINIMUM_PASSES = 3; // guards thrashing, not gaming
const SHORT_EDIT_FLOOR = 50; // below this many baseline words the gate is off

// Parking. Every zone excluded from the prose count is somewhere prose can be
// moved instead of cut. This is reported, never blocked: the shape step moves
// real prose into real code examples, so the signal is strong but not certain,
// and a gate that blocks on a guess is a gate people turn off.
const PARKED_SHARE = 0.5; // of the prose removed, how much may reappear hidden
const PARKED_FLOOR = 20; // below this many words the signal is noise

/**
 * Decide whether a curve passes the gate.
 *
 * `counts[0]` is the baseline, `counts.at(-1)` is the current count, and each
 * value between is one recorded distillation pass. A pass is weak when it
 * removed less than WEAK_PASS_RATIO of the count it started from.
 */
export function verdict(counts) {
  const baseline = counts[0];
  const current = counts[counts.length - 1];

  // A typo fix adds a dozen prose words. Asking it to lose half a sentence is
  // how a gate gets turned off.
  if (baseline < SHORT_EDIT_FLOOR) return { pass: true, reason: 'floor' };

  if (current <= baseline * TARGET_RATIO) return { pass: true, reason: 'target' };

  const removals = counts.slice(1).map((count, index) => {
    const from = counts[index];
    // A count of zero has no share to remove. Emptying a document and refilling
    // it is a rewrite, and dividing by zero would read that rewrite as a weak
    // pass: two of them in a row would converge a document that never distilled.
    return from === 0 ? 1 : (from - count) / from;
  });

  const converged =
    removals.length >= MINIMUM_PASSES &&
    removals.slice(-WEAK_PASSES_TO_CONVERGE).every((share) => share < WEAK_PASS_RATIO) &&
    current <= baseline * CONVERGED_CEILING;

  return converged ? { pass: true, reason: 'converged' } : { pass: false, reason: 'blocked' };
}

// Doc-distill-override: docs/wire-protocol.md would delete the wire format table
const OVERRIDE_TRAILER = /^Doc-distill-override:\s*(\S+)\s*(.*)$/;

/**
 * Read every override trailer from the commits of a branch.
 *
 * The trailer must name a gated file and carry a reason. Nothing here can
 * verify that the reason is true, so the control is attribution: each override
 * is reported against the author of the commit that wrote it.
 */
export function parseOverrides(commits, gatedFiles) {
  const overrides = [];

  for (const { sha, author, message } of commits) {
    for (const line of message.split('\n')) {
      const found = OVERRIDE_TRAILER.exec(line.trim());
      if (found === null) continue;

      const file = found[1];
      const reason = found[2].trim();

      let problem = null;
      if (!gatedFiles.has(file)) problem = `${file} is not a gated file`;
      else if (reason === '') problem = 'the override carries no reason';

      overrides.push({ sha, author, file, reason, valid: problem === null, problem });
    }
  }

  return overrides;
}

// <!-- distilled: <rev> 742->421->396 (53.4%) converged pass=4 -->
//
// The leading field is a git revision, not a bare hash. `git show` it and the
// draft comes back under the name it was drafted with, which is the one name a
// rename cannot invalidate.
const STAMP_PATTERN =
  /^<!--\s*distilled:\s*(\S+)\s+([\d>-]+)\s+\(([\d.]+)%\)\s*(converged\s+)?pass=(\d+)\s*-->$/;

/**
 * Write the stamp for a measured curve.
 *
 * The stamp decides nothing. The curve is counted from git, so the verdict
 * holds whether or not the document carries one. Its job is provenance after
 * the squash-merge, which orphans the branch commits and leaves the curve
 * unreconstructable. A stamp nobody writes never does that job, so the gate
 * prints the exact line rather than describing its shape.
 */
export function formatStamp({ rev, counts, converged }) {
  const percent = ((counts[counts.length - 1] / counts[0]) * 100).toFixed(1);
  const marker = converged ? 'converged ' : '';

  return `<!-- distilled: ${rev} ${counts.join('->')} (${percent}%) ${marker}pass=${counts.length - 1} -->`;
}

/**
 * Read the distillation stamp from a document, or null when it carries none.
 *
 * Only the first non-blank line is examined. Matching the pattern anywhere in
 * the file also strikes any example of a stamp written inside a fenced block.
 */
export function readStamp(text) {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (first === undefined) return null;

  const found = STAMP_PATTERN.exec(first.trim());
  if (found === null) return null;

  const [, rev, curve, percent, converged, pass] = found;
  return {
    rev,
    counts: curve.split('->').map(Number),
    percent: Number(percent),
    converged: Boolean(converged),
    pass: Number(pass),
  };
}

/** Tokens carrying a letter, once markdown syntax is stripped. */
const countTokens = (text) =>
  text
    .replace(/[#*_>\-|]+/g, ' ') // markdown syntax, pipes included
    .split(/\s+/)
    .filter((token) => /[A-Za-z]/.test(token)).length;

/**
 * Count words in a document, split into what a reader reads and what is hidden
 * from the count.
 *
 * Every zone excluded from prose is a place prose can be parked instead of cut,
 * so the two are counted together and reported apart.
 */
function countWords(text, chargeable = null) {
  let prose = 0;
  let hidden = 0;
  let fenced = false;
  let lineNumber = 0;

  for (const line of text.split('\n')) {
    lineNumber += 1;

    // Fence state is read from every line, but only the chargeable ones are
    // counted. An edit is billed for what it added and a fence is code
    // wherever it was opened, so the two cannot be the same set of lines.
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (chargeable !== null && !chargeable.has(lineNumber)) continue;

    const trimmed = line.trim();
    if (fenced || trimmed.startsWith('<!--')) {
      hidden += countTokens(trimmed);
      continue;
    }

    const inlineCode = trimmed.match(/`[^`]*`/g) ?? [];
    hidden += inlineCode.reduce((sum, span) => sum + countTokens(span.slice(1, -1)), 0);
    prose += countTokens(trimmed.replace(/`[^`]*`/g, ' '));
  }

  return { prose, hidden };
}

/**
 * Count the prose words in a markdown document.
 *
 * Prose is what a reader reads. Fenced blocks, inline code and markdown
 * syntax are not prose, and a token must carry a letter to count.
 */
export function proseWords(text) {
  return countWords(text).prose;
}

/**
 * Count the words a document keeps out of its prose count.
 *
 * Prose that falls while this rises was parked, not removed.
 */
export function hiddenWords(text) {
  return countWords(text).hidden;
}

/**
 * True when every fenced block in a document is closed.
 *
 * An unbalanced fence inverts the counter for every line after it, so one
 * stray fence makes the rest of a document free. It is also malformed
 * markdown, so refusing to measure it recalibrates nothing.
 */
export function fencesBalance(text) {
  const fences = text.split('\n').filter((line) => line.trimStart().startsWith('```'));
  return fences.length % 2 === 0;
}

const BASE_BRANCH = CONFIG.baseBranch;

// Git's default rename threshold is 50% similarity, which is this gate's own
// pass mark: a document renamed in the commit that distils it falls under the
// default by construction, so the better the distillation the more certainly
// its history is lost. A low threshold cannot smuggle prose past the gate,
// because pairing and measurement read the same similarity data. Whatever git
// treats as carried over is exactly what the diff reports as unchanged.
const RENAME_THRESHOLD = '-M5%';

function git(repoDir, ...args) {
  // stderr is captured, never inherited. Probing for a blob that is not there
  // is a normal question to ask git, and its answer must not reach the caller's
  // stderr, where it would be indistinguishable from a crash.
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The default is one megabyte. A tree listing or a long diff passes it, and
    // the overflow surfaces as a thrown error that `blobAt` cannot tell from
    // "the file is not there", so the document would drop out of the curve.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The lines a unified diff adds, as line numbers in the new file.
 *
 * Numbers rather than text, because the text of an added line does not say
 * whether it landed inside a fenced block. Read at zero context, the hunk
 * header `@@ -l,s +start,count @@` describes exactly the added run.
 *
 * Every hunk counts. The caller limits the diff to one document's names with a
 * pathspec, so there is nothing else in it to pick out. When git fails to pair
 * a rename even at 5% similarity the document arrives as two halves: the
 * deleted one is `@@ -1,M +0,0 @@` and charges nothing, and the added one is
 * `@@ -0,0 +1,N @@` and charges the whole file. That is the right bill. A
 * document sharing under 5% with what it replaced is a new draft wearing an
 * old name.
 *
 * Reading `+++ b/<path>` to scope by name would be the fragile way to reach
 * the same answer: git quotes that path when it holds a character it considers
 * special, the match would miss, and an empty set counts zero words and passes
 * the gate in silence.
 */
function addedLineNumbers(diff) {
  const added = new Set();

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;

    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = 0; i < count; i += 1) added.add(start + i);
  }

  return added;
}

/** True when `path` exists in the tree of `rev`. */
function existsAt(repoDir, rev, path) {
  try {
    git(repoDir, 'cat-file', '-e', `${rev}:${path}`);
    return true;
  } catch {
    return false;
  }
}

/** The contents of `path` at `rev`, or null when it is not there. */
function blobAt(repoDir, rev, path) {
  try {
    return git(repoDir, 'show', `${rev}:${path}`);
  } catch {
    return null;
  }
}

/**
 * The name this document carried at each branch commit, newest first, and the
 * name it carried before the branch began.
 *
 * `git log -- <path>` filters on one name, so every commit before a rename
 * disappears and an already distilled document reads as a fresh draft.
 * `--follow` does not rescue it: against a revision range it degrades to the
 * same path filter and returns the same single commit.
 *
 * The walk must run past the oldest branch commit. A rename made by that commit
 * changes the name the document has on the trunk, and that trunk name is what
 * decides whether the branch wrote the document or inherited it.
 */
function nameHistory(repoDir, path, commits) {
  let name = path;

  const history = commits.map((sha) => {
    const at = { sha, name };
    const status = git(repoDir, 'show', RENAME_THRESHOLD, '--name-status', '--format=', sha);

    for (const line of status.split('\n')) {
      const renamed = /^R\d*\t(.+)\t(.+)$/.exec(line);
      if (renamed !== null && renamed[2] === name) name = renamed[1];
    }

    return at;
  });

  return { history, beforeBranch: name };
}

/**
 * The merge base with the trunk, whether or not the trunk is checked out.
 *
 * The remote name comes first. A local trunk branch goes stale the moment
 * another pull request merges, and measuring against it puts commits that are
 * already on the trunk inside the range: the pre-push hook then blocks the push
 * over a document the branch never touched, and the check in Actions, which has
 * only the remote name, disagrees.
 */
export function mergeBaseOf(repoDir) {
  for (const base of [`origin/${BASE_BRANCH}`, BASE_BRANCH]) {
    try {
      return git(repoDir, 'merge-base', base, 'HEAD').trim();
    } catch {
      // try the next name
    }
  }
  throw new Error(`cannot find ${BASE_BRANCH} or origin/${BASE_BRANCH} to measure against`);
}

/** The branch commits, newest first, and the merge base they are measured from. */
export function branchOf(repoDir) {
  const mergeBase = mergeBaseOf(repoDir);
  const revList = git(repoDir, 'rev-list', `${mergeBase}..HEAD`).trim();

  return { mergeBase, commits: revList === '' ? [] : revList.split('\n') };
}

/**
 * Measure this document at every commit of the branch, oldest first.
 *
 * The curve is counted from git rather than read from the stamp, so
 * convergence is proved instead of trusted.
 *
 * `branch` is the same for every document, so a caller measuring several passes
 * it in rather than making the gate walk the revision list once per file.
 */
export function measureCurve(repoDir, path, branch = branchOf(repoDir)) {
  const { mergeBase, commits: newestFirst } = branch;

  const { history, beforeBranch } = nameHistory(repoDir, path, newestFirst);
  const names = [...new Set([...history.map((entry) => entry.name), beforeBranch])];

  // A document already on main is billed for what the branch added to it. A
  // distilled body would otherwise dilute the measurement: add five lines to a
  // stamped twenty-line document and a full-file pass can remove 4%, leave the
  // new content untouched, converge, and pass. The name tested is the one the
  // document has on the trunk, so renaming it does not turn an edit into a
  // draft and bill the branch for prose it inherited.
  const kind = existsAt(repoDir, mergeBase, beforeBranch) ? 'edit' : 'new';

  const points = [];
  for (const { sha, name } of [...history].reverse()) {
    // Both kinds read the whole document. A draft is billed for all of it and
    // an edit only for the lines it added, but the text those lines are read
    // in is the same either way. Counting an edit from the diff slice alone
    // loses the fences around it, which both bills code as prose and hands
    // back prose as free, and leaves `fencesBalance` below describing a slice
    // rather than the document it is supposed to guard.
    const text = blobAt(repoDir, sha, name);
    if (text === null) continue; // the document did not exist yet

    const chargeable =
      kind === 'new'
        ? null
        : addedLineNumbers(
            git(repoDir, 'diff', RENAME_THRESHOLD, '--unified=0', mergeBase, sha, '--', ...names),
          );

    const { prose, hidden } = countWords(text, chargeable);
    points.push({ sha, name, count: prose, hidden, text });
  }

  return { kind, points, mergeBase };
}

/** The index of the first highest point: the draft, after STE has raised it. */
function peakOf(points) {
  let peak = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].count > points[peak].count) peak = i;
  }
  return peak;
}

/**
 * The curve the gate judges: the peak, then every later count.
 *
 * Consecutive equal counts collapse. Writing the stamp is itself a commit that
 * touches the file, and a commit that changed no prose is not a distillation
 * pass; without this every stamp would be stale the moment it was written.
 */
export function curveOf(points) {
  const counts = points.slice(peakOf(points)).map((point) => point.count);
  return counts.filter((count, i) => i === 0 || count !== counts[i - 1]);
}

/**
 * Decide what a document is measured against.
 *
 * Git determines the baseline. Stamp presence does not.
 *
 * The baseline is the peak of the curve, not its first point. Converting to
 * STE raises the count before anything lowers it, and a draft written over
 * several commits starts small: taking the first commit that touched the file
 * would demand a finished document smaller than its own opening paragraph.
 */
export function resolveBaseline(repoDir, path, branch = branchOf(repoDir)) {
  const { kind, points } = measureCurve(repoDir, path, branch);
  return { kind, ...baselineOf(repoDir, path, points) };
}

/** The peak of a measured curve, named by the revision and name it was drafted under. */
function baselineOf(repoDir, path, points) {
  if (points.length === 0) return { baseline: 0, rev: `:${path}` };

  const peak = points[peakOf(points)];
  const short = git(repoDir, 'rev-parse', '--short', peak.sha).trim();

  return { baseline: peak.count, rev: `${short}:${peak.name}` };
}

/**
 * Prove a document's stamp against git.
 *
 * The marking side records a baseline. This is the checking side: it resolves
 * the revision the stamp names and counts the document there, so the baseline
 * is verified rather than asserted.
 *
 * This has to happen at pull-request time. A squash-merge orphans the draft
 * commit, so the claim outlives the evidence for it, and a stamp nobody proved
 * while the branch existed can never be proved afterwards.
 */
export function verifyStamp(repoDir, path) {
  const stamp = readStamp(blobAt(repoDir, 'HEAD', path) ?? '');
  if (stamp === null) return { ok: false, problem: `${path} carries no stamp` };

  // The field is a command, not a label: git show it and the draft comes back,
  // under the name it was drafted with. That is the one name a rename cannot
  // invalidate.
  try {
    git(repoDir, 'show', stamp.rev);
  } catch {
    return { ok: false, problem: `${stamp.rev} does not resolve` };
  }

  const { points } = measureCurve(repoDir, path);
  const draftSha = stamp.rev.split(':')[0];
  const drafted = points.find((point) => point.sha.startsWith(draftSha));
  if (drafted === undefined) {
    return { ok: false, problem: `${stamp.rev} is not a commit of this branch` };
  }

  if (drafted.count !== stamp.counts[0]) {
    return {
      ok: false,
      problem: `${path} claims a baseline of ${stamp.counts[0]} prose words, but git counts ${drafted.count} at ${stamp.rev}`,
    };
  }

  const measured = curveOf(points);
  if (measured.join('->') !== stamp.counts.join('->')) {
    return {
      ok: false,
      problem: `${path} records the curve ${stamp.counts.join('->')}, but git measures ${measured.join('->')}`,
    };
  }

  return { ok: true, problem: null };
}

// An allowlist. A denylist includes everything by default, and one wrong
// pattern sends a whole vault of generated text through the gate.
//
// `include` defaults to the documents in docs/ and the ones at the repository
// root. `ignore` defaults to nothing. Name in it the documents that grow by
// design: a changelog, a status register, an append-only log. Example:
//
//   { "ignore": ["docs/changelog.md", "notes/**"] }

function globToRegExp(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?') // any number of directories, including none
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*'); // a lone star stops at a slash

  return new RegExp(`^${body}$`);
}

const INCLUDE_PATTERNS = CONFIG.include.map(globToRegExp);
const IGNORE_PATTERNS = CONFIG.ignore.map(globToRegExp);

export function isGated(path) {
  if (IGNORE_PATTERNS.some((pattern) => pattern.test(path))) return false;
  return INCLUDE_PATTERNS.some((pattern) => pattern.test(path));
}

/** The gated documents this branch added, changed or renamed. */
function changedGatedFiles(repoDir, mergeBase) {
  const status = git(repoDir, 'diff', RENAME_THRESHOLD, '--name-status', mergeBase, 'HEAD');
  const paths = [];

  for (const line of status.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 2) continue;
    if (fields[0].startsWith('D')) continue;

    const destination = fields[fields.length - 1]; // a rename carries source then destination
    if (isGated(destination)) paths.push(destination);
  }

  return [...new Set(paths)].sort();
}

/** Every gated document on the branch, for validating an override's target. */
function gatedFilesAtHead(repoDir) {
  return new Set(git(repoDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(isGated));
}

function commitsOf(repoDir, mergeBase) {
  const RECORD = '\u001e';
  const FIELD = '\u0000';
  const raw = git(repoDir, 'log', '--format=%h%x00%an%x00%B%x1e', `${mergeBase}..HEAD`);

  return raw
    .split(RECORD)
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, author, message] = record.replace(/^\n/, '').split(FIELD);
      return { sha, author, message };
    });
}

const PIPELINE = `Then, in this order:

  1. Convert to ASD-STE100 Simplified Technical English. Grammar only.
  2. Change the shape to a procedure, a table, or a list, if the content
     permits. You do not choose the shape. Step 1 reveals it.
  3. Repeat: remove fluff, then count again. Fluff is restated context,
     duplicate sections, summaries of preceding text, and arguments another
     document already makes.

Run STE before you reshape. Prose rhythm conceals an empty sentence and flat
STE does not, so the right shape appears only after conversion. Do not remove
the words STE adds. They set a floor under the ratio, and that floor is one
reason convergence exists.

Commit one distillation pass at a time. The gate counts each commit from git.`;

function reportBlock({ path, rev, baseline, current }) {
  const label = `baseline (${rev}):`;
  const pad = (text) => text.padEnd(label.length);

  return [
    `${path} is not distilled.`,
    `  ${label} ${baseline} prose words`,
    `  ${pad('current:')} ${current} prose words`,
    `  ${pad('required:')} <= ${Math.floor(baseline * TARGET_RATIO)} prose words, or a converged curve`,
  ].join('\n');
}

function main() {
  const repoDir = process.cwd();
  const branch = branchOf(repoDir);
  const mergeBase = branch.mergeBase;
  const changed = changedGatedFiles(repoDir, mergeBase);

  const overrides = parseOverrides(commitsOf(repoDir, mergeBase), gatedFilesAtHead(repoDir));
  const overridden = new Set(overrides.filter((o) => o.valid).map((o) => o.file));

  const blocks = [];
  const unproved = [];
  const unbalanced = [];
  const out0 = [];

  for (const path of changed) {
    const { points } = measureCurve(repoDir, path, branch);
    if (points.length === 0) continue;

    const last = points[points.length - 1];
    const peak = points[peakOf(points)];

    // An unclosed fence inverts the counter for every line after it, so the
    // measurement below would be meaningless. Refuse rather than report.
    if (!fencesBalance(last.text)) {
      unbalanced.push(path);
      continue;
    }

    const removed = peak.count - last.count;
    const parked = last.hidden - peak.hidden;
    if (removed > 0 && parked >= PARKED_FLOOR && parked >= removed * PARKED_SHARE) {
      out0.push(
        `${path}: ${removed} prose words left the count and ${parked} appeared in fenced blocks, inline code or comments.`,
        '  Distillation removes words. It does not move them.',
      );
    }

    const curve = curveOf(points);
    const current = last.count;
    const { pass, reason } = verdict(curve);

    const stamp = readStamp(blobAt(repoDir, 'HEAD', path) ?? '');
    const stampMatches = stamp !== null && stamp.counts[stamp.counts.length - 1] === current;

    if (pass) {
      // A document exempted by the floor was never distilled, so there is no
      // curve to record. Asking it for a stamp asks for provenance of an event
      // that did not happen.
      if (reason !== 'floor') {
        const { ok, problem } = verifyStamp(repoDir, path);
        if (!ok) {
          unproved.push({
            path,
            problem,
            absent: stamp === null,
            line: formatStamp({
              rev: baselineOf(repoDir, path, points).rev,
              counts: curve,
              converged: reason === 'converged',
            }),
          });
        }
      }
      continue;
    }

    blocks.push({
      path,
      rev: baselineOf(repoDir, path, points).rev,
      baseline: curve[0],
      current,
      stamped: stamp !== null,
    });
  }

  const out = [...out0];
  let failed = false;

  for (const path of unbalanced) {
    out.push(
      `${path} has an unclosed fenced block, so its prose cannot be counted.`,
      '  Close the fence. One stray ``` makes every line after it free.',
    );
    // An override clears a document the gate measured and judged. This one was
    // never measured, so there is no verdict to overrule, and saying so beats
    // both of the alternatives: reporting it as cleared when the push still
    // fails, or counting it among the overrides that ran ahead of any block
    // and telling the author they skipped a distillation they never reached.
    if (overridden.has(path)) {
      out.push('  An override cannot clear an unclosed fence. Close it and push again.');
    }
    failed = true;
  }

  for (const override of overrides.filter((o) => !o.valid)) {
    out.push(`Override in ${override.sha} by ${override.author} is not usable: ${override.problem}.`);
    failed = true;
  }

  const blockedNow = new Set(blocks.map((block) => block.path));

  for (const block of blocks) {
    if (overridden.has(block.path)) continue;
    out.push(reportBlock(block));
    if (block.stamped) {
      out.push(`  Its stamp is stale. The document changed after the stamp was written.`);
    }
    failed = true;
  }

  if (failed) out.push('', PIPELINE);

  // A stamp is the only part of this that outlives the branch. The squash-merge
  // orphans the commits the curve was measured from, so a claim not proved here
  // can never be proved. An unproved stamp is not provenance, so it blocks.
  for (const { path, problem, absent, line } of unproved) {
    out.push(
      absent
        ? `${path} is distilled but carries no stamp. Make this its first line:`
        : `${problem}. Replace its first line with:`,
      `  ${line}`,
    );
    failed = true;
  }

  // An override used after a real block is expected, and reported in one quiet
  // line. One used before any block means distillation was skipped outright.
  // That count is what separates "the gate is calibrated wrong" from "the gate
  // is unwanted", so it goes on the check rather than into a log.
  for (const override of overrides.filter((o) => o.valid && blockedNow.has(o.file))) {
    out.push(`Override: ${override.file}, cleared by ${override.author} (${override.sha}).`);
  }

  // A refused document is not a skipped distillation. It was never measured,
  // so its override answered a refusal rather than running ahead of a verdict,
  // and the line above has already told the author what to do about it.
  const refused = new Set(unbalanced);
  const loud = overrides.filter((o) => o.valid && !blockedNow.has(o.file) && !refused.has(o.file));
  if (loud.length > 0) {
    out.push(
      `${loud.length} override(s) used with no block behind them. Distillation was skipped:`,
      ...loud.map((o) => `  ${o.file} by ${o.author} (${o.sha}): ${o.reason}`),
    );
    if (process.env.GITHUB_ACTIONS === 'true') {
      out.push(`::warning::${loud.length} doc-distill override(s) used without a block`);
    }
  }

  if (out.length > 0) process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
