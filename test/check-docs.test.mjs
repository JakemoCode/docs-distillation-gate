import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gate reads .docs-distill.json from the working directory when it loads.
// Load it from an empty directory, or a repository that vendors this suite
// alongside its own config fails tests that assume the defaults.
const home = process.cwd();
const emptyDir = mkdtempSync(join(tmpdir(), 'docs-distill-cwd-'));
process.chdir(emptyDir);
const {
  curveOf,
  formatStamp,
  fencesBalance,
  verifyStamp,
  hiddenWords,
  isGated,
  measureCurve,
  parseOverrides,
  proseWords,
  readStamp,
  resolveBaseline,
  verdict,
} = await import('../check-docs.mjs');
process.chdir(home);
rmSync(emptyDir, { recursive: true, force: true });

/** Build a document from lines, so fences can be written literally. */
const doc = (...lines) => lines.join('\n') + '\n';

test('proseWords counts words in a plain paragraph', () => {
  assert.equal(proseWords('Hello world.\n'), 2);
});

test('proseWords ignores fenced blocks and their fence lines', () => {
  const text = doc(
    'Alpha beta.',
    '',
    '```js',
    'const gamma = delta;',
    '```',
    '',
    'Epsilon.',
  );
  // Alpha, beta. Epsilon. The block, its language tag and both fences are code.
  assert.equal(proseWords(text), 3);
});

// V2 discarded every line starting with a pipe, which discards the cells too.
// The same twenty words then cost 20 in a paragraph and 0 in a cell, so drawing
// a table around text was cheaper than cutting it.
test('proseWords charges a word in a cell the same as a word in a paragraph', () => {
  const words = 'alpha bravo charlie delta echo';

  assert.equal(proseWords(doc(words)), 5);
  assert.equal(
    proseWords(doc('| Head |', '|---|', `| ${words} |`)),
    6, // the five words, plus Head. The divider row costs nothing.
  );
});

test('proseWords separates cells written without spaces around the pipes', () => {
  assert.equal(proseWords(doc('|Head|Meaning|')), 2);
});

test('proseWords ignores inline code', () => {
  assert.equal(proseWords(doc('Run `npm test` now.')), 2);
});

test('proseWords charges nothing for a divider row', () => {
  const withDivider = doc('| Head |', '|---|', '| Body |');
  const withoutDivider = doc('| Head |', '| Body |');

  assert.equal(proseWords(withDivider), proseWords(withoutDivider));
});

// The compliance record must not count against the document that carries it,
// or writing the stamp would itself push a passing document back over the line.
test('proseWords charges nothing for the stamp', () => {
  const stamp = '<!-- distilled: a1b2c3d:docs/x.md 742->421 (56.7%) converged pass=2 -->';
  const stamped = doc(stamp, '', 'Hello world.');

  assert.equal(proseWords(stamped), proseWords(doc('Hello world.')));
});

const STAMP =
  '<!-- distilled: a1b2c3d:docs/wire-protocol.md 742->421->402->396 (53.4%) converged pass=4 -->';

test('readStamp parses every field of a stamp', () => {
  assert.deepEqual(readStamp(doc(STAMP, '', 'Body.')), {
    rev: 'a1b2c3d:docs/wire-protocol.md',
    counts: [742, 421, 402, 396],
    percent: 53.4,
    converged: true,
    pass: 4,
  });
});

test('readStamp reports an unstamped document as null', () => {
  assert.equal(readStamp(doc('Body only.')), null);
});

// The brief's own example of a stamp sits inside a fenced block. A naive
// /^<!-- distilled:/ match anywhere in the file strikes it and credits the
// document with a stamp it does not carry.
test('readStamp ignores a stamp that is not the first non-blank line', () => {
  const text = doc('Body first.', '', '```', STAMP, '```');

  assert.equal(readStamp(text), null);
});

test('readStamp skips leading blank lines', () => {
  assert.equal(readStamp(doc('', '   ', STAMP, '', 'Body.'))?.pass, 4);
});

test('readStamp reads a curve that has not converged', () => {
  const text = doc('<!-- distilled: ff01ab2:docs/x.md 100->48 (48.0%) pass=1 -->');
  const stamp = readStamp(text);

  assert.equal(stamp.converged, false);
  assert.deepEqual(stamp.counts, [100, 48]);
});

// verdict takes the whole curve: counts[0] is the baseline, counts.at(-1) the
// current count, and everything between is one recorded distillation pass.

test('verdict passes a document cut to half the baseline', () => {
  assert.deepEqual(verdict([100, 50]), { pass: true, reason: 'target' });
});

test('verdict blocks a document that is one word over half', () => {
  assert.equal(verdict([100, 51]).pass, false);
});

test('verdict passes a curve that converged at or under the ceiling', () => {
  // Removals: 30%, then 4.3%, then 3.0%. Three passes. Ends at 65%.
  assert.deepEqual(verdict([100, 70, 67, 65]), { pass: true, reason: 'converged' });
});

test('verdict blocks a curve that converged above the ceiling', () => {
  // Same shape, but it stalls at 72%. A human clears this with the trailer.
  assert.equal(verdict([100, 75, 73, 72]).pass, false);
});

test('verdict requires at least three passes', () => {
  // Ends under the ceiling and the last pass is weak, but only two have run.
  assert.equal(verdict([100, 64, 63]).pass, false);
});

test('verdict needs two weak passes, not one', () => {
  // Three passes, ends at the ceiling, last pass removes 1.5%. But the pass
  // before it removed 26.7%, so the curve has not flattened.
  assert.equal(verdict([100, 90, 66, 65]).pass, false);
});

// Emptying a document and refilling it divides by zero. Read as a share
// removed, that step is negative infinity, which is under any weak-pass
// threshold, so the wipe plus one small commit converged a document that had
// distilled nothing and left it 5 words under the ceiling.
test('verdict does not converge a document that was emptied and refilled', () => {
  assert.equal(verdict([300, 0, 190, 195]).pass, false);
});

test('verdict exempts an edit under the short-edit floor', () => {
  // A one-line typo fix adds a dozen prose words. A gate that tells it to lose
  // half a sentence is a gate people turn off.
  assert.deepEqual(verdict([12, 12]), { pass: true, reason: 'floor' });
});

test('verdict still gates an edit at the floor boundary', () => {
  assert.equal(verdict([50, 50]).pass, false);
});

// parseOverrides takes the commits of the branch and the set of gated files.
// It cannot verify a reason, so the control is attribution: a named person
// makes a falsifiable claim.

const GATED = new Set(['docs/wire-protocol.md', 'AGENTS.md']);

// Each commit carries the values of its override trailers, as overrideCommits reads them.
const commit = (values, author = 'Ada') => ({ sha: 'a1b2c3d', author, values });

test('parseOverrides reads the file, the reason and the author', () => {
  const commits = [
    commit(['docs/wire-protocol.md would delete the wire format table']),
  ];

  assert.deepEqual(parseOverrides(commits, GATED), [
    {
      sha: 'a1b2c3d',
      author: 'Ada',
      file: 'docs/wire-protocol.md',
      reason: 'would delete the wire format table',
      valid: true,
      problem: null,
    },
  ]);
});

test('parseOverrides finds nothing in commits that carry no trailer', () => {
  assert.deepEqual(parseOverrides([commit([])], GATED), []);
});

test('parseOverrides rejects a trailer naming a file the gate never examines', () => {
  const commits = [commit(['notes/vault/note.md too long'])];
  const [override] = parseOverrides(commits, GATED);

  assert.equal(override.valid, false);
  assert.match(override.problem, /not a gated file/);
});

test('parseOverrides rejects a trailer with no reason', () => {
  const [override] = parseOverrides([commit(['AGENTS.md'])], GATED);

  assert.equal(override.valid, false);
  assert.match(override.problem, /no reason/);
});

test('parseOverrides attributes each override to its own commit author', () => {
  const commits = [
    commit(['AGENTS.md keeps the rule list'], 'Grace'),
    commit(['docs/wire-protocol.md keeps the table'], 'Ada'),
  ];

  assert.deepEqual(
    parseOverrides(commits, GATED).map((o) => o.author),
    ['Grace', 'Ada'],
  );
});

// Seam C runs against real git. A canned-stdout double would only replay what
// the author believes git does, and both v2 rename defects were exactly that
// belief being wrong.

/** N distinct prose words on one line. */
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'tester@example.com');
  git('config', 'user.name', 'Tester');

  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text.endsWith('\n') ? text : `${text}\n`);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', '--short', 'HEAD');
  };

  return { dir, git, write, commit };
}

// An edit is billed from its added lines, and a diff slice does not carry the
// fences that surround it. Lines added inside a block that already exists on
// the trunk arrive with no opening fence above them, so the counter reads them
// as prose and a two-line change to a shell block asks the document to halve
// eight words it never wrote.
test('resolveBaseline does not bill code added inside an existing fenced block', async (t) => {
  const r = repo(t);
  r.write('docs/x.md', doc('Intro.', '```sh', 'old-cmd', '```', 'Outro.'));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', doc('Intro.', '```sh', 'old-cmd', 'new-cmd --flag two', '```', 'Outro.'));
  r.commit('docs: extend the block');

  const result = resolveBaseline(r.dir, 'docs/x.md');

  assert.equal(result.kind, 'edit');
  assert.equal(result.baseline, 0, 'a line inside a fence is code wherever the fence was opened');
});

test('resolveBaseline bills only the added lines of a file that is already on main', async (t) => {
  const r = repo(t);
  r.write('docs/x.md', words(100));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', `${words(100)}\n${words(40)}`);
  r.commit('docs: extend the page');

  const result = resolveBaseline(r.dir, 'docs/x.md');

  assert.equal(result.kind, 'edit');
  assert.equal(result.baseline, 40); // the 100 words already on main are not billed
});

/** N distinct prose words, one per line, so git can pair at line granularity. */
const lines = (n, prefix = 'word') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');

test('resolveBaseline follows a document through a rename that distils it', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/draft.md', lines(201));
  const draft = r.commit('docs: draft the page');

  // The rename and the distillation are one commit. 60 of the 201 lines
  // survive, so the pair is ~30% similar: under git's 50% default, by
  // construction, because the better the distillation the less it resembles
  // what it replaced.
  r.git('rm', '-q', 'docs/draft.md');
  r.write('docs/final.md', `${lines(60)}\n${lines(21, 'new')}`);
  r.commit('docs: distil and rename the page');

  const result = resolveBaseline(r.dir, 'docs/final.md');

  assert.equal(result.baseline, 201, 'the draft is still the baseline after the rename');
  assert.match(result.rev, /:docs\/draft\.md$/, 'the rev names the file it was drafted as');
});

test('resolveBaseline takes the peak of a draft written over several commits', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/y.md', lines(40)); // an opening paragraph
  r.commit('docs: start the page');
  r.write('docs/y.md', lines(300)); // the bulk of the draft arrives later
  r.commit('docs: finish the draft');

  // Taking the first commit that touched the file would set the baseline at 40
  // and demand a finished document of 20 words: smaller than its own opening
  // paragraph, and unsatisfiable.
  assert.equal(resolveBaseline(r.dir, 'docs/y.md').baseline, 300);
});

test('resolveBaseline survives STE raising the count before anything lowers it', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/z.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/z.md', lines(115)); // conversion to STE adds words
  r.commit('docs: convert to STE');
  r.write('docs/z.md', lines(55));
  r.commit('docs: remove fluff');

  const result = resolveBaseline(r.dir, 'docs/z.md');

  assert.equal(result.baseline, 115, 'the peak, not the first point');
  assert.equal(verdict([result.baseline, 55]).pass, true);
});

test('resolveBaseline does not read an unrelated addition as an edit of a deletion', async (t) => {
  const r = repo(t);
  r.write('docs/a.md', lines(100, 'alpha'));
  r.commit('docs: add a');

  r.git('checkout', '-q', '-b', 'feat');
  r.git('rm', '-q', 'docs/a.md');
  r.write('docs/b.md', lines(100, 'zulu'));
  r.commit('docs: replace a with an unrelated b');

  const result = resolveBaseline(r.dir, 'docs/b.md');

  assert.equal(result.kind, 'new', 'b is its own document, not an edit of a');
  assert.equal(result.baseline, 100);
});

// The rename walk stopped one commit short of the trunk, so a document renamed
// by the branch read as drafted by the branch and was billed for the whole
// file. Adding a line to a 200 word page then demanded a 100 word page.
test('resolveBaseline still bills only the added lines when the branch renames the file', async (t) => {
  const r = repo(t);
  r.write('docs/a.md', lines(200));
  r.commit('docs: add a');

  r.git('checkout', '-q', '-b', 'feat');
  r.git('mv', 'docs/a.md', 'docs/b.md');
  r.write('docs/b.md', `${lines(200)}\n${lines(10, 'new')}`);
  r.commit('docs: rename a to b and add a note');

  const result = resolveBaseline(r.dir, 'docs/b.md');

  assert.equal(result.kind, 'edit', 'the branch inherited this document, it did not draft it');
  assert.equal(result.baseline, 10, 'the 200 words already on main are not billed');
});

// `git show` prints no diff for a merge commit by default, so a rename made
// while resolving a trunk merge was invisible to the name walk. The document
// then had no history under its old name, read as drafted by the branch, and
// was billed for every word it had inherited: the better the document the
// larger the bill, since the branch is charged for prose it only renamed.
test('resolveBaseline follows a rename made by a merge commit', async (t) => {
  const r = repo(t);
  r.write('docs/a.md', lines(200));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');

  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');

  // The rename rides in on the merge, which is what hides it from `git show`.
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  r.git('mv', 'docs/a.md', 'docs/b.md');
  r.commit('chore: merge main and rename the page');

  const result = resolveBaseline(r.dir, 'docs/b.md');

  assert.equal(result.kind, 'edit', 'the page was inherited, not drafted here');
  assert.equal(result.baseline, 0, 'a rename alone adds no prose');
});

// The other direction, and the common one: a teammate renames a document on
// the trunk and the branch picks it up with a pull. A first-parent diff of the
// merge reports that rename too, so a walk that treats every rename it sees as
// the branch's own rewinds the name to one the trunk no longer has, finds
// nothing under it at the merge base, and bills the branch for a document it
// inherited. Halve a file you did not write, because someone else moved it.
test('resolveBaseline does not read a rename the trunk made as the branch renaming', async (t) => {
  const r = repo(t);
  r.write('docs/a.md', lines(200));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');

  r.git('checkout', '-q', 'main');
  r.git('mv', 'docs/a.md', 'docs/c.md');
  r.commit('docs: rename the page on the trunk');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'main');
  r.write('docs/c.md', `${lines(200)}\n${words(4)}`);
  r.commit('docs: add a line to the renamed page');

  const result = resolveBaseline(r.dir, 'docs/c.md');

  assert.equal(result.kind, 'edit', 'the trunk renamed it, so the branch inherited it');
  assert.equal(result.baseline, 4, 'only the four words this branch added');
});

// A branch that pulls the trunk in moves the merge base forward. A commit made
// before the pull still holds the trunk's old text, so measured against the
// new base it reads the trunk's later rewrite, undone, as prose it added: the
// branch is told to halve a paragraph someone else wrote, at a commit that
// never touched the file. The gate bills a line only when it is new against
// both the current base and the trunk commit it was built on.
test('resolveBaseline bills a branch that merged the trunk only for its own prose', async (t) => {
  const r = repo(t);
  r.write('AGENTS.md', `# Doc\n\n${words(120)}`);
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');

  r.git('checkout', '-q', 'main');
  r.write('AGENTS.md', `# Doc\n\n${words(120).replaceAll('word', 'term')}`);
  r.commit('docs: rewrite the paragraph on the trunk');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'main');
  r.write('AGENTS.md', `# Doc\n\n${words(120).replaceAll('word', 'term')}\n\n${words(12)}`);
  r.commit('docs: add a line');

  const result = resolveBaseline(r.dir, 'AGENTS.md');

  assert.equal(result.kind, 'edit');
  assert.equal(result.baseline, 12, 'only the twelve words this branch added');
  assert.deepEqual(curveOf(measureCurve(r.dir, 'AGENTS.md').points), [12]);
});

// A stacked branch: its parent pull request drafted the page and was squash
// merged, so the trunk holds the page under a commit the branch never had. The
// branch pulls the trunk in and adds 60 words. Billed against its old base the
// draft commit costs 300, the merge drops it to 0, and the fall reads as a
// distillation the branch never did.
test('resolveBaseline does not read a squash-merged parent as distilled', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', words(300));
  r.commit('docs: draft the page');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', words(300));
  r.commit('docs: draft the page (squashed)');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'main');
  r.write('docs/x.md', `${words(300)}\n${words(60).replaceAll('word', 'more')}`);
  r.commit('docs: extend the page');

  assert.deepEqual(curveOf(measureCurve(r.dir, 'docs/x.md').points), [60]);
});

// Each setting hides the hunk headers from a parser of plain headers: escape
// codes around them, a driver or textconv that prints something else, or an
// attribute that makes git call the file binary. An edit then bills nothing.
for (const [setting, apply] of [
  ['forced colour', (r) => r.git('config', 'color.diff', 'always')],
  ['an external diff driver', (r) => r.git('config', 'diff.external', 'true')],
  ['a textconv', (r) => {
    r.git('config', 'diff.blank.textconv', 'true');
    r.write('.gitattributes', '*.md diff=blank');
  }],
  ['a -diff attribute', (r) => r.write('.gitattributes', '*.md -diff')],
]) {
  test(`resolveBaseline bills an edit under ${setting}`, async (t) => {
    const r = repo(t);
    apply(r);
    r.write('docs/x.md', words(100));
    r.commit('docs: add the page');

    r.git('checkout', '-q', '-b', 'feat');
    r.write('docs/x.md', `${words(100)}\n${words(40)}`);
    r.commit('docs: extend the page');

    assert.equal(resolveBaseline(r.dir, 'docs/x.md').baseline, 40);
  });
}

// Inter-hunk context fuses two nearby hunks into one, and the fused range
// covers the unchanged trunk lines between them.
test('resolveBaseline bills only changed lines under inter-hunk context', async (t) => {
  const r = repo(t);
  r.git('config', 'diff.interHunkContext', '3');
  r.write('docs/x.md', lines(20));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(20).replace('word9\n', 'mine9\n').replace('word12\n', 'mine12\n'));
  r.commit('docs: change two lines');

  assert.equal(resolveBaseline(r.dir, 'docs/x.md').baseline, 2);
});

// A subtree import merges in history that shares no commit with the trunk.
test('resolveBaseline measures a branch that merged an unrelated history', async (t) => {
  const r = repo(t);
  r.write('docs/x.md', words(100));
  r.commit('docs: add the page');

  r.git('checkout', '-q', '--orphan', 'vendored');
  r.git('rm', '-q', '-r', '--cached', '.');
  r.git('clean', '-q', '-fd');
  r.write('lib/readme.txt', 'vendored');
  r.commit('chore: another project');

  r.git('checkout', '-q', '-b', 'feat', 'main');
  r.git('merge', '-q', '--no-edit', '--allow-unrelated-histories', 'vendored');
  r.write('docs/x.md', `${words(100)}\n${words(40).replaceAll('word', 'more')}`);
  r.commit('docs: extend the page');

  assert.equal(resolveBaseline(r.dir, 'docs/x.md').baseline, 40);
});

test('resolveBaseline reports a file drafted on the branch as new', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(80));
  r.commit('docs: add a page');

  assert.deepEqual(
    { kind: resolveBaseline(r.dir, 'docs/new.md').kind, baseline: resolveBaseline(r.dir, 'docs/new.md').baseline },
    { kind: 'new', baseline: 80 },
  );
});

// Seam F: the command line. Two rules from the brief govern every case here.
// GITHUB_ACTIONS is pinned, never inherited, or a suite that reads it passes on
// a laptop and fails inside Actions. And every assertion reads stderr: an
// uncaught exception also exits 1, so a harness that checks only the exit code
// cannot tell a crashed script from a clean block, and keeps passing over the
// wreckage.

const CLI = fileURLToPath(new URL('../check-docs.mjs', import.meta.url));

function runCli(repoDir, env = {}, args = []) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', ...env },
  });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Assert the run was a clean verdict rather than a crash. */
const assertNoCrash = (run) => assert.equal(run.stderr, '', `unexpected stderr:\n${run.stderr}`);

test('a distilled document is not finished until it carries its stamp', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/new.md', lines(40));
  r.commit('docs: distil');

  // Distilled to 40% and blocked anyway: the record does not exist yet.
  const before = runCli(r.dir);
  assertNoCrash(before);
  assert.equal(before.code, 1, 'a missing stamp is not a pass');

  // Writing the stamp changes no prose, so the curve it records stays true and
  // the line the gate printed is still the right one. The loop closes in one
  // step, which is the whole reason a no-op commit is not a pass.
  const line = before.stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  r.write('docs/new.md', `${line}\n${lines(40)}`);
  r.commit('docs: stamp it');

  const after = runCli(r.dir);
  assertNoCrash(after);
  assert.equal(after.code, 0, after.stdout);
  assert.equal(after.stdout, '');
});

test('the gate blocks an undistilled document and prints its state', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(100));
  r.commit('docs: draft and stop');

  const run = runCli(r.dir);

  assertNoCrash(run); // a clean block, not an exception that also exits 1
  assert.equal(run.code, 1);
  assert.match(run.stdout, /docs\/new\.md is not distilled\./);
  assert.match(run.stdout, /baseline .*: 100 prose words/);
  assert.match(run.stdout, /current: *100 prose words/);
  assert.match(run.stdout, /required: *<= 50 prose words, or a converged curve/);
});

test('the failure output carries the distillation pipeline', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(100));
  r.commit('docs: draft and stop');

  const { stdout } = runCli(r.dir);

  // The pipeline lives in the tool's failure output, not in AGENTS.md.
  assert.match(stdout, /Simplified Technical English/);
  assert.match(stdout, /procedure, a table, or a list/);
  assert.match(stdout, /remove fluff/);
});

/** A branch with one gated document drafted and left undistilled. */
function branchWithBlock(t) {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');
  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(100));
  r.commit('docs: draft and stop');
  return r;
}

/** A branch with one gated document drafted and properly distilled. */
function branchThatPasses(t) {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');
  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/ok.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/ok.md', lines(40));
  r.commit('docs: distil');
  return r;
}

test('the gate never examines a document outside the allowlist', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('notes/vault/a-long-note.md', lines(400));
  r.commit('notes: add a note');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
});

// A mistyped flag is the same failure as a missing one, and worse for being
// invisible: --summery reads as no flag at all, the gate goes quiet, and the
// check stays green having reported nothing. A workflow file carries the flag
// for years without anyone reading it again, so the typo has to be caught the
// one time a person is watching, which is the run right after they write it.
test('an unknown argument is refused rather than ignored', async (t) => {
  const r = branchWithBlock(t);

  const run = runCli(r.dir, {}, ['--summery']);

  assert.notEqual(run.code, 0, 'a flag the gate does not know must not look like success');
  assert.match(run.stderr, /--summery/);
});

// Silence is the gate's success signal and also what every failure this tool
// has had looks like from outside: a measurement read off the wrong text, a
// guard that skipped the file, an entry point that never ran. All three exited
// 0 saying nothing, which is the same thing a clean branch does. --summary is
// the one mode that always writes a line, so empty output under it means the
// script did not run rather than that it found nothing.
test('--summary reports even when no gated document changed', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('src/app.js', 'const x = 1;');
  r.commit('feat: code only, no documents');

  const quiet = runCli(r.dir);
  const summary = runCli(r.dir, {}, ['--summary']);

  assertNoCrash(quiet);
  assertNoCrash(summary);
  assert.equal(quiet.stdout, '', 'the hook stays quiet, which is why --summary exists');
  assert.equal(summary.code, 0);
  assert.match(summary.stdout, /docs-distill examined no gated documents/);
});

// The count is the diagnostic. A document whose chargeable prose reads 0 beside
// a diff that plainly added prose is the shape of every mis-measurement here,
// and it is only visible if the number is printed somewhere.
test('--summary names each document it examined and what it counted', async (t) => {
  const r = branchWithBlock(t);

  const run = runCli(r.dir, {}, ['--summary']);

  assertNoCrash(run);
  assert.match(run.stdout, /docs-distill examined 1 gated document\./);
  assert.match(run.stdout, /docs\/new\.md \(new\): 100 -> 100 prose words/);
  // The verdict is unchanged. A reporting flag that also alters the outcome
  // would be a second code path to keep honest.
  assert.equal(run.code, 1);
  assert.match(run.stdout, /docs\/new\.md is not distilled\./);
});

// A required check must not carry a paths filter: a filtered check never
// reports on a pull request that changes no documents, and GitHub waits on it
// forever. It runs on every pull request and exits early instead.
test('the gate exits early and quietly when no gated document changed', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('services/thing.js', 'const x = 1;');
  r.commit('feat: unrelated code');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
});

// The pre-push hook and the check in Actions must measure the same commits.
// Actions has only `origin/main`; a laptop has both, and the local one goes
// stale the moment another pull request merges. Preferring the local name put
// commits that were already on the trunk inside the range, and the hook blocked
// the push over a document the branch had never touched.
test('the gate measures against the remote trunk, not a stale local branch', async (t) => {
  const origin = repo(t);
  origin.write('README.md', 'Root.');
  origin.commit('chore: init');
  origin.git('config', 'receive.denyCurrentBranch', 'ignore');

  const dir = mkdtempSync(join(tmpdir(), 'doc-gate-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', origin.dir, dir], { encoding: 'utf8' });

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('config', 'user.email', 'tester@example.com');
  git('config', 'user.name', 'Tester');

  // Another pull request merges an undistilled page into the trunk.
  origin.write('docs/theirs.md', lines(300));
  origin.commit('docs: their page');

  // We fetch, but never update the local trunk branch, and cut from the remote.
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'feat', 'origin/main');
  writeFileSync(join(dir, 'note.md'), `${lines(10)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: a short note');

  const run = runCli(dir);

  assertNoCrash(run);
  assert.doesNotMatch(run.stdout, /docs\/theirs\.md/, 'their document is not ours to distil');
  assert.equal(run.code, 0);
});

// Overrides are read from the trailer block git parses, unfolded (issue #13).
test('a folded override trailer clears a block', async (t) => {
  const r = branchWithBlock(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: keep the table\n\nDoc-distill-override:\n  docs/new.md would delete the wire format table');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /Override: docs\/new\.md, cleared by Tester/);
});

test('an override line in the body, outside the trailer block, is not an override', async (t) => {
  const r = branchWithBlock(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: note how to skip\n\nDoc-distill-override: docs/new.md is the line the README shows.\n\nThe gate reads trailers, not prose.');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stdout, /Override: docs\/new\.md/);
});

test('an override trailer with no value is reported as naming no file', async (t) => {
  const r = branchThatPasses(t);
  r.git('commit', '-q', '--allow-empty', '-m', 'docs: waive it\n\nDoc-distill-override:');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /the override names no file/);
});

test('an override after a real block clears it, and is reported in one quiet line', async (t) => {
  const r = branchWithBlock(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: keep the table\n\nDoc-distill-override: docs/new.md would delete the wire format table');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Override: docs\/new\.md, cleared by Tester/);
  assert.doesNotMatch(run.stdout, /is not distilled/);
});

// The guard at the foot of the file compares its own module URL against
// argv[1]. Node resolves a symlink before it records the module URL and the
// shell does not, so the two disagree whenever the script is reached through
// one and `main()` never runs. `package.json` declares a bin, so `npx
// docs-distill` is exactly that path, and the failure is silent: a gate that
// examined nothing and a gate that found nothing both exit 0.
test('the gate runs when it is reached through a symlink', async (t) => {
  const r = branchWithBlock(t);

  const linkDir = mkdtempSync(join(tmpdir(), 'doc-gate-bin-'));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));
  const link = join(linkDir, 'docs-distill');
  symlinkSync(CLI, link);

  const direct = runCli(r.dir);
  const viaLink = spawnSync(process.execPath, [link], {
    cwd: r.dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });

  assertNoCrash(direct); // the control arm proves nothing if it exits 1 by crashing
  assert.equal(direct.code, 1, 'the fixture blocks when the gate is run directly');
  assert.equal(viaLink.stderr, '');
  assert.equal(viaLink.status, 1, `reached through a symlink the gate printed: ${viaLink.stdout}`);
  assert.match(viaLink.stdout, /docs\/new\.md is not distilled\./);
});

test('an override with no block behind it is reported loudly', async (t) => {
  const r = branchThatPasses(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: skip it\n\nDoc-distill-override: docs/ok.md I did not feel like it');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.match(run.stdout, /1 override\(s\) used with no block behind them/);
  assert.match(run.stdout, /docs\/ok\.md by Tester/);
});

// If the tool reads GITHUB_ACTIONS to decide what to print, a suite that
// inherits the real environment passes on a laptop and fails inside Actions.
test('the loud count is annotated on the check only inside Actions', async (t) => {
  const r = branchThatPasses(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: skip it\n\nDoc-distill-override: docs/ok.md I did not feel like it');

  const onLaptop = runCli(r.dir, { GITHUB_ACTIONS: '' });
  const inActions = runCli(r.dir, { GITHUB_ACTIONS: 'true' });

  assertNoCrash(onLaptop);
  assertNoCrash(inActions);
  assert.doesNotMatch(onLaptop.stdout, /::warning::/);
  assert.match(inActions.stdout, /::warning::1 doc-distill override\(s\) used without a block/);
});

test('an override naming a file the gate never examines fails the check', async (t) => {
  const r = branchThatPasses(t);
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: waive it\n\nDoc-distill-override: notes/vault/a.md too long');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /is not usable: notes\/vault\/a\.md is not a gated file/);
});

test('a passing document with a stamp that no longer matches is reported stale', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/s.md', lines(100));
  r.commit('docs: draft');
  // The curve really ends at 40, but the stamp claims it ended at 45.
  r.write('docs/s.md', `<!-- distilled: aaaaaaa:docs/s.md 100->45 (45.0%) pass=1 -->\n${lines(40)}`);
  r.commit('docs: distil and stamp');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1, 'a stamp that disagrees with git is not provenance');
  assert.match(run.stdout, /docs\/s\.md/);
});

// An allowlist, not a denylist. A denylist includes everything by default, and
// one wrong pattern sends a whole vault of generated text through the gate.
test('isGated selects the documents the gate examines', () => {
  const decisions = [
    'docs/architecture.md',
    'docs/adr/0001-a-decision.md',
    'README.md',
    'AGENTS.md',
    'docs/api.openapi.yaml',
    'services/gateway/README.md',
  ].map((path) => [path, isGated(path)]);

  assert.deepEqual(decisions, [
    ['docs/architecture.md', true],
    ['docs/adr/0001-a-decision.md', true], // nested under docs/
    ['README.md', true],
    ['AGENTS.md', true],
    ['docs/api.openapi.yaml', false], // not markdown
    ['services/gateway/README.md', false], // *.md is the repository root only
  ]);
});

test('a document the config ignores is not examined', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/changelog.md', lines(100));
  r.commit('docs: a document that grows by design');

  const blocked = runCli(r.dir);
  assertNoCrash(blocked);
  assert.equal(blocked.code, 1);

  r.write('.docs-distill.json', JSON.stringify({ ignore: ['docs/changelog.md'] }));
  r.commit('chore: name the changelog in the config');

  const after = runCli(r.dir);
  assertNoCrash(after);
  assert.equal(after.code, 0, after.stdout);
});

test('the config names the trunk, for a repository whose trunk is not main', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');
  r.git('branch', '-m', 'trunk');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', lines(100));
  r.commit('docs: draft');

  // Nothing to measure against: the gate stops rather than passing everything.
  const unconfigured = runCli(r.dir);
  assert.match(unconfigured.stderr, /cannot find main/);

  r.write('.docs-distill.json', JSON.stringify({ baseBranch: 'trunk' }));
  r.commit('chore: name the trunk');

  const configured = runCli(r.dir);
  assertNoCrash(configured);
  assert.equal(configured.code, 1);
  assert.match(configured.stdout, /docs\/new\.md is not distilled/);
});

test('the gate passes a curve that converged, for a document that cannot reach half', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  for (const count of [100, 70, 67, 65]) {
    r.write('docs/dense.md', lines(count));
    r.commit(`docs: pass to ${count}`);
  }

  const before = runCli(r.dir);
  assertNoCrash(before);
  assert.equal(before.code, 1, 'converged, but the record is missing');

  const line = before.stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  assert.match(line, /100->70->67->65 \(65\.0%\) converged pass=3/);

  r.write('docs/dense.md', `${line}\n${lines(65)}`);
  r.commit('docs: stamp it');

  const after = runCli(r.dir);
  assertNoCrash(after);
  assert.equal(after.code, 0, after.stdout);
});

// Writing the stamp is itself a commit that touches the file. If it registered
// as a pass it would manufacture the third pass convergence requires, turning a
// block into a pass, and every stamp would be stale the moment it was written.
test('a commit that changed no prose is not a distillation pass', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/dense.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/dense.md', lines(66));
  r.commit('docs: remove fluff');

  // Touches the file, changes no prose: the stamp is stripped before counting.
  r.write('docs/dense.md', `<!-- distilled: aaaaaaa:docs/dense.md 100->66 (66.0%) pass=1 -->\n${lines(66)}`);
  r.commit('docs: write the stamp');

  r.write('docs/dense.md', `<!-- distilled: aaaaaaa:docs/dense.md 100->66 (66.0%) pass=1 -->\n${lines(65)}`);
  r.commit('docs: one more word');

  // Counted 100, 66, 66, 65 the stamp commit supplies a third pass and the
  // curve converges. Collapsed to 100, 66, 65 it is two passes, and blocks.
  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1, 'a no-op commit must not buy the third pass');
});

// The stamp decides nothing: the curve is measured from git. Its whole job is
// provenance after the squash-merge, when the branch commits are gone and the
// curve can no longer be reconstructed. So a stamp that is never written is a
// stamp that never does its job.

test('formatStamp writes a stamp that readStamp can read back', () => {
  const line = formatStamp({ rev: 'a1b2c3d:docs/x.md', counts: [742, 421, 402, 396], converged: true });

  assert.deepEqual(readStamp(`${line}\n\nBody.\n`), {
    rev: 'a1b2c3d:docs/x.md',
    counts: [742, 421, 402, 396],
    percent: 53.4,
    converged: true,
    pass: 3,
  });
});

test('formatStamp counts passes from the curve, not from a caller', () => {
  const line = formatStamp({ rev: 'ff01ab2:docs/y.md', counts: [100, 48], converged: false });

  assert.equal(readStamp(`${line}\n`).pass, 1);
  assert.equal(readStamp(`${line}\n`).converged, false);
});

test('a passing document that carries no stamp is told which stamp to write', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/x.md', lines(40));
  r.commit('docs: distil');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1, 'an absent stamp blocks: the record is the deliverable');
  assert.match(run.stdout, /docs\/x\.md is distilled but carries no stamp/);
  assert.match(run.stdout, /<!-- distilled: \w+:docs\/x\.md 100->40 \(40\.0%\) pass=1 -->/);
});

test('the stamp the gate prints is one readStamp accepts', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/x.md', lines(40));
  r.commit('docs: distil');

  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:'));

  assert.ok(printed, 'the gate printed a stamp');
  assert.notEqual(readStamp(`${printed.trim()}\n`), null, 'and it parses');
});

// Cheat codes. Every zone proseWords ignores is somewhere prose can be parked
// instead of cut: a fenced block, inline code, an HTML comment. hiddenWords
// counts what is parked there, so a fall in prose can be checked against a rise
// in hiding.

test('hiddenWords counts nothing in a document that is all prose', () => {
  assert.equal(hiddenWords(doc('alpha bravo charlie delta echo')), 0);
});

test('hiddenWords counts words parked in a fenced block', () => {
  const text = doc('alpha bravo', '', '```', 'charlie delta echo', '```');

  assert.equal(proseWords(text), 2);
  assert.equal(hiddenWords(text), 3);
});

test('hiddenWords counts words parked in inline code', () => {
  assert.equal(hiddenWords(doc('alpha `bravo charlie delta`')), 3);
});

test('hiddenWords counts words parked in an HTML comment', () => {
  assert.equal(hiddenWords(doc('alpha', '<!-- bravo charlie delta -->')), 3);
});

// An unbalanced fence makes every following line count as zero prose, so a
// single stray ``` makes the rest of a document free. It is also malformed
// markdown, so refusing to measure it costs nothing and recalibrates nothing.
test('fencesBalance rejects an odd number of fence lines', () => {
  assert.equal(fencesBalance(doc('alpha', '```', 'bravo')), false);
  assert.equal(fencesBalance(doc('alpha', '```', 'bravo', '```')), true);
  assert.equal(fencesBalance(doc('alpha bravo')), true);
});

test('the gate reports prose that was parked in a fenced block, not removed', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(100));
  r.commit('docs: draft');
  // Prose count falls 100 -> 40, which clears the target. The 60 words did not
  // go anywhere: they are sitting in a fence.
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(60, 'hid')}\n\`\`\``);
  r.commit('docs: "distil"');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.match(run.stdout, /docs\/x\.md: 60 prose words left the count/);
  assert.match(run.stdout, /60 appeared in fenced blocks, inline code or comments/);
});

test('an honest distillation is not reported as parking', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/x.md', lines(40)); // the 60 words are gone, not moved
  r.commit('docs: distil');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.doesNotMatch(run.stdout, /left the count/);
});

// An edit that retags a block's opener leaves the closer as an unchanged
// context line, so the added lines carry one fence where the document carries
// two. Measured from the slice, the document read as unclosed and was refused,
// and no override clears that refusal, so the branch could not be pushed.
test('the gate measures a balanced document whose diff slice is not', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.write('docs/runbook.md', doc('Intro line here.', '```', 'old-cmd --flag', '```', 'Outro.'));
  r.commit('docs: add the runbook');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/runbook.md', doc('Intro line here.', '```sh', 'new-cmd --flag', '```', 'Outro.'));
  r.commit('docs: tag the block as shell');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.doesNotMatch(run.stdout, /unclosed fenced block/, 'the document closes every fence');
  assert.equal(run.code, 0, run.stdout);
  assert.equal(run.stdout, '');
});

// The refusal below is load-bearing beyond malformed markdown, and a fix that
// moves it onto the document blob opens a bypass. An edit that retags a fenced
// block's opener leaves the closer as context, so the added lines carry one
// fence: the counter reads that slice, treats every later line as hidden, and
// prose appended past the closer costs nothing. The document itself balances,
// so only a check reading the slice catches it.
test('prose added after a lopsided slice is not free', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.write(
    'docs/runbook.md',
    doc('Intro line here.', '```sh', 'old-cmd --flag', '```', 'Outro line here.'),
  );
  r.commit('docs: add the runbook');

  r.git('checkout', '-q', '-b', 'feat');
  r.write(
    'docs/runbook.md',
    doc('Intro line here.', '```bash', 'old-cmd --flag', '```', 'Outro line here.', lines(200)),
  );
  r.commit('docs: retag the block and append prose');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.notEqual(run.stdout, '', '200 added prose words cannot pass the gate in silence');
  // Blocked for the right reason. Refusing to measure would also be non-empty
  // output, and would mean the count is still being read off the slice.
  assert.doesNotMatch(run.stdout, /unclosed fenced block/);
  assert.match(run.stdout, /docs\/runbook\.md is not distilled\./);
  assert.match(run.stdout, /current: *200 prose words/);
});

test('a document whose fences do not balance is refused, not measured', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  // One stray fence makes every line after it count as zero prose.
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}`);
  r.commit('docs: add a page with a stray fence');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /docs\/x\.md has an unclosed fenced block/);
});

// The test above drafts the document, so its added lines are the whole file
// and no slice can disagree with it. An edit can: the stray fence sits on the
// trunk and the branch adds none, so a check reading the slice sees balanced
// text and measures a count the stray fence has already voided.
test('an edit to a document whose fences do not balance is refused too', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}`);
  r.commit('docs: add a page with a stray fence');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}\n${lines(20, 'added')}`);
  r.commit('docs: add to the page');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /docs\/x\.md has an unclosed fenced block/);
});

// Balance is read from the whole document, so the stray fence above stands in
// front of everyone who edits that file and not only whoever wrote it. The
// refusal keeps the path out of `blocks`, so an override naming it used to
// fall in with the overrides that ran ahead of any block: the author was told
// they had skipped a distillation the gate never performed, Actions raised a
// warning, and the push failed anyway. --no-verify was the only way on, which
// switches off every other check in the gate too.
test('an override clears a refusal to measure, as it clears any other block', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}`);
  r.commit('docs: add a page with a stray fence');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}\n${lines(20, 'added')}`);
  r.commit('docs: add to the page');
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: note the fence\n\nDoc-distill-override: docs/x.md the fence predates this branch');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /Override: docs\/x\.md, cleared by Tester/);
  // Cleared means cleared. A refusal printed beside an exit code of zero reads
  // as a gate that could not make up its mind.
  assert.doesNotMatch(run.stdout, /unclosed fenced block/);
  assert.doesNotMatch(run.stdout, /Distillation was skipped/);
  assert.doesNotMatch(run.stdout, /with no block behind/);
});

// The escape hatch is for a fence the branch inherited. Opened to every
// refusal it becomes the cheapest bypass in the gate: one stray ``` in a new
// draft and the document is never measured at all, so the trailer buys 300
// uncounted words rather than the few the gate would have argued about.
test('an override does not clear a fence the branch introduced', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/new.md', `${lines(40)}\n\n\`\`\`\n${lines(300, 'free')}`);
  r.commit('docs: draft a page with a stray fence');
  r.git('commit', '-q', '--allow-empty', '-m',
    'docs: keep the fence\n\nDoc-distill-override: docs/new.md the fence is deliberate');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1, run.stdout);
  assert.match(run.stdout, /docs\/new\.md has an unclosed fenced block/);
  assert.doesNotMatch(run.stdout, /cleared by/);
});

test('a small amount of parking is noise, not a finding', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(60));
  r.commit('docs: draft');
  // Removes 20 prose words and adds a 12-word code example. That clears the
  // share test, so only the floor keeps it quiet.
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(12, 'ex')}\n\`\`\``);
  r.commit('docs: distil and add an example');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.doesNotMatch(run.stdout, /left the count/);
});

test('a real cut that also adds a code example is not reported as parking', async (t) => {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(140));
  r.commit('docs: draft');
  // Cuts 100 prose words and adds a 25-word example. Well over the floor, well
  // under the share: this is what an honest shape change looks like, and it is
  // the false positive the share threshold exists to prevent.
  r.write('docs/x.md', `${lines(40)}\n\n\`\`\`\n${lines(25, 'ex')}\n\`\`\``);
  r.commit('docs: distil and show an example');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.doesNotMatch(run.stdout, /left the count/);
});

test('an edit under the floor is not asked for a stamp', async (t) => {
  const r = repo(t);
  r.write('docs/x.md', lines(400));
  r.commit('docs: a page already on main');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', `${lines(400)}\n${lines(12, 'note')}`);
  r.commit('docs: fix a typo');

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 0);
  // Nothing was distilled, so there is no curve to record. A stamp reading
  // "12 (100.0%) pass=0" is provenance for an event that did not happen.
  assert.doesNotMatch(run.stdout, /carries no stamp/);
});

// The checking side. A stamp is a claim that outlives its evidence: the
// squash-merge orphans the draft commit, so the claim can only be proved while
// the branch still exists. Proving it at pull-request time is what makes the
// record on main worth anything afterwards.

/** A branch that drafts 100 prose words and distils them to 40. */
function distilledBranch(t) {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');
  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', lines(100));
  r.commit('docs: draft');
  r.write('docs/x.md', lines(40));
  r.commit('docs: distil');
  return r;
}

/** Put `line` at the top of docs/x.md and commit it. */
const stampWith = (r, line) => {
  r.write('docs/x.md', `${line}\n${lines(40)}`);
  r.commit('docs: stamp it');
};

test('verifyStamp accepts a stamp that agrees with git', async (t) => {
  const r = distilledBranch(t);
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  stampWith(r, printed);

  assert.deepEqual(verifyStamp(r.dir, 'docs/x.md'), { ok: true, problem: null });
});

test('verifyStamp refuses a baseline the draft commit does not support', async (t) => {
  const r = distilledBranch(t);
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();

  // Same revision, invented baseline. git show resolves it and counts 100.
  stampWith(r, printed.replace('100->40', '742->40'));
  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');

  assert.equal(ok, false);
  assert.match(problem, /claims a baseline of 742.*git counts 100/);
});

test('verifyStamp refuses a revision that does not resolve', async (t) => {
  const r = distilledBranch(t);
  stampWith(r, '<!-- distilled: deadbee:docs/x.md 100->40 (40.0%) pass=1 -->');
  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');

  assert.equal(ok, false);
  assert.match(problem, /does not resolve/);
});

test('the gate blocks a distilled document whose stamp disagrees with git', async (t) => {
  const r = distilledBranch(t);
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  stampWith(r, printed.replace('100->40', '742->40'));

  const run = runCli(r.dir);

  assertNoCrash(run);
  assert.equal(run.code, 1, 'an unverified claim is not provenance');
  assert.match(run.stdout, /claims a baseline of 742/);
});

test('verifyStamp refuses a curve git did not measure', async (t) => {
  const r = distilledBranch(t);
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();

  // Correct baseline and correct final count, but it invents a middle pass that
  // never happened. Without the curve check this is indistinguishable from the
  // real thing, and a fabricated convergence would ride in on it.
  stampWith(r, printed.replace('100->40', '100->70->40'));
  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');

  assert.equal(ok, false);
  assert.match(problem, /records the curve 100->70->40, but git measures 100->40/);
});

// A long-lived branch takes trunk into itself, by the "Update branch" button or
// by hand. Commits imported that way must not be measured as branch work, or a
// document is billed for prose somebody else wrote.
test('a trunk merge does not add the trunk\'s prose to the curve', async (t) => {
  const origin = mkdtempSync(join(tmpdir(), 'doc-gate-origin-'));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  const r = repo(t);
  const body = (n, prefix) => ['TOP', lines(n, prefix), 'BOTTOM'].join('\n');
  r.write('docs/x.md', body(60, 'filler'));
  r.commit('docs: a page on the trunk');
  r.git('remote', 'add', 'origin', origin);
  r.git('push', '-q', '-u', 'origin', 'main');

  r.git('checkout', '-q', '-b', 'feat');
  r.write('docs/x.md', ['TOP', lines(200, 'mine'), lines(60, 'filler'), 'BOTTOM'].join('\n'));
  r.commit('docs: draft');
  r.write('docs/x.md', ['TOP', lines(80, 'mine'), lines(60, 'filler'), 'BOTTOM'].join('\n'));
  r.commit('docs: distil');

  const alone = resolveBaseline(r.dir, 'docs/x.md');

  // Somebody lands 300 words in the same document on the trunk.
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', ['TOP', lines(60, 'filler'), 'BOTTOM', lines(300, 'theirs')].join('\n'));
  r.commit('docs: their section');
  r.git('push', '-q', 'origin', 'main');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'origin/main');

  const merged = resolveBaseline(r.dir, 'docs/x.md');

  assert.equal(alone.baseline, 200, 'the branch is billed for its own 200 words');
  assert.deepEqual(merged, alone, 'and for exactly the same words after the merge');
});

// The lineage walk: SCOPE-merge-attribution.md. The curve follows the prose of
// the document at HEAD back through the commits that made it. At a merge it
// follows only the parents whose copy the merge took, or every parent when the
// merge edited the document. Each test below is a row of the scope's table.

/** A repo with a root commit on main and `feat` checked out from it. */
function shapeRepo(t) {
  const r = repo(t);
  r.write('README.md', 'Root.');
  r.commit('chore: init');
  r.git('checkout', '-q', '-b', 'feat');
  return r;
}

const curveAt = (r, path) => curveOf(measureCurve(r.dir, path).points);

/** Commit with a committer date far in the future, so rev-list sorts it last. */
function commitLate(r, message) {
  r.git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: r.dir,
    env: { ...process.env, GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z' },
  });
}

/**
 * Shape 1's history: the child carries its parent's 300-word draft, the trunk
 * holds the parent's 140-word squash, and the child takes the trunk's copy.
 */
function stackedChild(t) {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: the parent draft');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(140, 'draft'));
  r.commit('docs: the parent, distilled and squashed');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '-X', 'theirs', 'main');
  return r;
}

/** The 300-word draft of shapes 5, 6 and 15 with 260 of its words in a fence. */
const fenced = () => `${lines(40, 'draft')}\n\`\`\`\n${lines(260, 'parked')}\n\`\`\``;

/** Assert the gate reports parked words and asks for a stamp. */
function assertParkedAndUnstamped(r) {
  const run = runCli(r.dir);
  assertNoCrash(run);
  assert.match(run.stdout, /appeared in fenced blocks/);
  assert.match(run.stdout, /carries no stamp/);
}

test('shape 1: a child that takes the trunk squash of its parent is measured on its own words', async (t) => {
  const r = stackedChild(t);
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(60, 'child')}`);
  r.commit('docs: the child adds 60 words');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [60]);
  assert.equal(verdict(curve).pass, false);
});

test('shape 2: a distilled branch keeps its curve through a trunk edit to the same document', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(100, 'trunk'));
  r.commit('docs: the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(200, 'draft')}`);
  r.commit('docs: draft');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(90, 'draft')}`);
  r.commit('docs: distil');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(100, 'trunk').replace(/^trunk([0-9])$/gm, 'edited$1'));
  r.commit('docs: the trunk edits ten lines');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [200, 90]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

test('shape 3: a cut made while resolving the merge is the branch distilling', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/y.md', lines(200, 'draft'));
  r.commit('docs: draft');
  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  r.write('docs/y.md', lines(90, 'draft'));
  r.commit('merge main, cutting the draft');

  const curve = curveAt(r, 'docs/y.md');
  assert.deepEqual(curve, [200, 90]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

/** Shapes 4 and 21: a draft of 200, one pass to `kept`, then an -s ours merge of a side branch at 300. */
function discardedSide(t, kept) {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(200, 'draft'));
  const draft = r.commit('docs: draft');
  r.write('docs/x.md', lines(kept, 'draft'));
  r.commit('docs: a pass');

  r.git('checkout', '-q', '-b', 'side', draft);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: the side branch grows it');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '-s', 'ours', 'side');
  return r;
}

test('shape 4: an -s ours merge of a side branch does not raise the peak', async (t) => {
  const curve = curveAt(discardedSide(t, 100), 'docs/x.md');
  assert.deepEqual(curve, [200, 100]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

test('shape 5: a merge that moves a draft into a fence is the branch editing', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', `${lines(40, 'draft')}\n${lines(260, 'parked')}`);
  r.commit('docs: draft');
  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  r.write('docs/x.md', fenced());
  r.commit('merge main, fencing the draft');

  assert.deepEqual(curveAt(r, 'docs/x.md'), [300, 40]);
  assertParkedAndUnstamped(r);
});

test('shape 6: a side branch taken wholesale carries its own history', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', `${lines(40, 'draft')}\n${lines(260, 'parked')}`);
  r.commit('docs: draft');
  r.git('checkout', '-q', '-b', 'side');
  r.write('docs/x.md', fenced());
  r.commit('docs: fence the draft on a side branch');
  r.git('checkout', '-q', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'side');

  assert.deepEqual(curveAt(r, 'docs/x.md'), [300, 40]);
  assertParkedAndUnstamped(r);
});

test('shape 7: a merge equal to both parents follows both', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(100, 'trunk'));
  r.commit('docs: the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(200, 'draft')}`);
  r.commit('docs: draft');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(90, 'draft')}`);
  r.commit('docs: distil');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(90, 'draft')}`);
  r.commit('docs: the trunk makes the same change');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'main');

  // The trunk now holds the branch's 90 lines; the 110 it never took still set the peak.
  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [110, 0]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

test('shape 8: a document only the trunk changed is not examined', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(200, 'trunk'));
  r.commit('docs: the trunk writes a page');
  r.git('checkout', '-q', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');
  r.git('merge', '-q', '--no-edit', 'main');

  const run = runCli(r.dir, {}, ['--summary']);
  assertNoCrash(run);
  assert.match(run.stdout, /examined no gated documents/);
  assert.equal(run.code, 0);
});

test('shape 9: the latest of two wholesale trunk takes decides', async (t) => {
  const r = stackedChild(t);
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(200, 'child')}`);
  r.commit('docs: the child drafts more');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(120, 'draft'));
  r.commit('docs: the trunk distils the page again');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', '-X', 'theirs', 'main');
  r.write('docs/x.md', lines(120, 'draft'));
  r.commit('merge main, taking its page');
  r.write('docs/x.md', `${lines(120, 'draft')}\n${words(30)}`);
  r.commit('docs: the child adds 30 words');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [30]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'floor' });
});

for (const [position, order] of [['third', ['side', 'main']], ['second', ['main', 'side']]]) {
  test(`shape 10: an octopus merge follows its trunk parent in the ${position} position`, async (t) => {
    const r = stackedChild(t);
    r.git('reset', '-q', '--hard', 'HEAD^1');
    r.git('checkout', '-q', '-b', 'side');
    r.write('side.txt', 'side work');
    r.commit('chore: side work');
    r.git('checkout', '-q', 'feat');
    const tree = r.git('rev-parse', 'main^{tree}');
    const octopus = r.git('commit-tree', tree, '-p', 'HEAD', '-p', order[0], '-p', order[1], '-m', 'octopus');
    r.git('reset', '-q', '--hard', octopus);
    r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(60, 'child')}`);
    r.commit('docs: the child adds 60 words');

    const curve = curveAt(r, 'docs/x.md');
    assert.deepEqual(curve, [60]);
    assert.equal(verdict(curve).pass, false);
  });
}

test('shape 11: a stamp naming a commit the walk does not reach is refused', async (t) => {
  const r = stackedChild(t);
  const draft = r.git('rev-parse', '--short', 'HEAD^1');
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(200, 'child')}`);
  r.commit('docs: the child drafts 200 words');
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(90, 'child')}`);
  r.commit('docs: the child distils them');
  r.write('docs/x.md', `<!-- distilled: ${draft}:docs/x.md 160->90 (56.3%) pass=1 -->\n${lines(140, 'draft')}\n${lines(90, 'child')}`);
  r.commit('docs: a stamp naming the old draft');

  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');
  assert.equal(ok, false);
  assert.match(problem, /no longer holds/);
});

test('shape 12: a later-dated side commit does not bring the old draft back', async (t) => {
  const r = stackedChild(t);
  const draft = r.git('rev-parse', 'HEAD^1');
  r.git('checkout', '-q', '-b', 'side', draft);
  r.write('side.txt', 'side work');
  commitLate(r, 'chore: side work, dated last');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'side');
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(60, 'child')}`);
  r.commit('docs: the child adds 60 words');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [60]);
  assert.equal(verdict(curve).pass, false);
});

test('shape 13: a trunk take on a side branch the branch discarded changes nothing', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(20, 'trunk'));
  r.commit('docs: the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('docs/x.md', `${lines(20, 'trunk')}\n${lines(15, 'draft')}\n${lines(260, 'parked')}`);
  const draft = r.commit('docs: draft');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(20, 'edited'));
  r.commit('docs: the trunk rewrites the page');

  r.git('checkout', '-q', '-b', 'side', draft);
  r.git('merge', '-q', '--no-commit', '--no-ff', '-X', 'theirs', 'main');
  r.write('docs/x.md', lines(20, 'edited'));
  r.commit('merge main, taking its page');

  r.git('checkout', '-q', 'feat');
  r.write('docs/x.md', `${lines(20, 'trunk')}\n${lines(15, 'draft')}\n\`\`\`\n${lines(260, 'parked')}\n\`\`\``);
  r.commit('docs: fence the draft');
  r.git('merge', '-q', '--no-edit', '-s', 'ours', 'side');

  assert.equal(curveAt(r, 'docs/x.md')[0], 275);
  const run = runCli(r.dir);
  assertNoCrash(run);
  assert.match(run.stdout, /appeared in fenced blocks/);
});

test('shape 14: a merge that takes the trunk deleting the document', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: the page lands on the trunk');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');

  r.git('checkout', '-q', 'main');
  r.git('rm', '-q', 'docs/x.md');
  r.commit('docs: the trunk deletes the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('docs/x.md', lines(60, 'fresh'));
  r.commit('docs: a fresh page');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [60]);
  assert.equal(verdict(curve).pass, false);
});

test('shape 15: a merge deleting a document the trunk never had keeps its history', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', `${lines(40, 'draft')}\n${lines(260, 'parked')}`);
  r.commit('docs: draft');
  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  r.git('rm', '-q', 'docs/x.md');
  r.commit('merge main, dropping the draft');
  r.write('docs/x.md', fenced());
  r.commit('docs: the draft again, fenced');

  assert.deepEqual(curveAt(r, 'docs/x.md'), [300, 40]);
  assertParkedAndUnstamped(r);
});

test('shape 16: the walk finds the trunk copy under the name the trunk holds', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: the parent draft');
  r.git('mv', 'docs/x.md', 'docs/y.md');
  r.commit('docs: rename the page');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(140, 'draft'));
  r.commit('docs: the parent, distilled and squashed');

  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', '-X', 'theirs', 'main');
  r.git('rm', '-q', '--cached', 'docs/x.md');
  rmSync(join(r.dir, 'docs/x.md'));
  r.write('docs/y.md', lines(140, 'draft'));
  r.commit('merge main, taking its page under the new name');
  r.write('docs/y.md', `${lines(140, 'draft')}\n${lines(60, 'child')}`);
  r.commit('docs: the child adds 60 words');

  assert.deepEqual(curveAt(r, 'docs/y.md'), [60]);
});

test('shape 17: a kept side branch forked before a trunk take keeps its drafting', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(100, 'trunk'));
  r.commit('docs: the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  r.write('notes.txt', 'branch work');
  const fork = r.commit('chore: branch work');

  r.git('checkout', '-q', 'main');
  r.write('docs/x.md', lines(100, 'edited'));
  r.commit('docs: the trunk rewrites the page');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');

  r.git('checkout', '-q', '-b', 'side', fork);
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(300, 'draft')}`);
  r.commit('docs: draft on a side branch');
  r.write('docs/x.md', `${lines(100, 'trunk')}\n${lines(100, 'draft')}`);
  r.commit('docs: distil it');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-commit', '--no-ff', '-X', 'theirs', 'side');
  r.write('docs/x.md', `${lines(100, 'edited')}\n${lines(100, 'draft')}`);
  r.commit('merge the side branch');

  // The merge edited the page, so both lines count; the order between them falls to commit dates.
  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual([curve[0], curve.at(-1)], [300, 100]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

/** A 300-word draft and three passes that converge: 180, 175, 171. */
function convergedOn(r, branch) {
  r.git('checkout', '-q', '-b', branch);
  for (const count of [180, 175, 171]) {
    r.write('docs/x.md', lines(count, 'draft'));
    r.commit(`docs: a pass to ${count}`);
  }
}

test('shape 18: passes made on a kept side branch keep their convergence', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  convergedOn(r, 'side');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'side');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [300, 180, 175, 171]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'converged' });
});

test("shape 19: a pull of a collaborator's draft and passes keeps their curve and stamp", async (t) => {
  const r = shapeRepo(t);
  r.write('notes.txt', 'shared start');
  r.commit('chore: shared start');
  r.git('checkout', '-q', '-b', 'ada');
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  for (const count of [180, 175, 171]) {
    r.write('docs/x.md', lines(count, 'draft'));
    r.commit(`docs: a pass to ${count}`);
  }
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  r.write('docs/x.md', `${printed}\n${lines(171, 'draft')}`);
  r.commit('docs: stamp it');

  r.git('checkout', '-q', 'feat');
  r.write('local.txt', 'local work');
  r.commit('chore: local work');
  r.git('merge', '-q', '--no-edit', 'ada');

  assert.deepEqual(curveAt(r, 'docs/x.md'), [300, 180, 175, 171]);
  assert.deepEqual(verifyStamp(r.dir, 'docs/x.md'), { ok: true, problem: null });
});

test('shape 20: the merge ref measures the same curve as the head', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.write('docs/x.md', lines(140, 'draft'));
  r.commit('docs: distil');
  const atHead = curveAt(r, 'docs/x.md');

  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');
  r.git('checkout', '-q', '--detach', 'main');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'feat');

  assert.deepEqual(atHead, [300, 140]);
  assert.deepEqual(curveAt(r, 'docs/x.md'), atHead);
});

test('shape 21: a weak pass stays blocked behind an -s ours side branch', async (t) => {
  const curve = curveAt(discardedSide(t, 140), 'docs/x.md');
  assert.deepEqual(curve, [200, 140]);
  assert.equal(verdict(curve).pass, false);
});

test('shape 22: a child that merges its parent branch carries its distillation', async (t) => {
  const r = shapeRepo(t);
  r.git('checkout', '-q', '-b', 'parent');
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: the parent draft');
  r.write('docs/x.md', lines(140, 'draft'));
  r.commit('docs: the parent distils it');
  r.git('checkout', '-q', 'feat');
  r.write('notes.txt', 'child work');
  r.commit('chore: child work');
  r.git('merge', '-q', '--no-edit', 'parent');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [300, 140]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'target' });
});

/** Commit with a fixed date, so rev-list's date order is the test's to choose. */
function commitOn(r, message, day) {
  r.git('add', '-A');
  const date = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd: r.dir,
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
}

test('the verdict does not depend on which side of a merge is its first parent', async (t) => {
  const verdicts = [];
  for (const [ours, theirs] of [['passes', 'typo'], ['typo', 'passes']]) {
    const r = shapeRepo(t);
    r.write('docs/x.md', lines(300, 'draft'));
    commitOn(r, 'docs: draft', 1);
    r.git('checkout', '-q', '-b', 'passes');
    for (const [count, day] of [[180, 3], [175, 4], [171, 5]]) {
      r.write('docs/x.md', lines(count, 'draft'));
      commitOn(r, `docs: a pass to ${count}`, day);
    }
    r.git('checkout', '-q', '-b', 'typo', 'feat');
    r.write('docs/x.md', `extra1\nextra2\n${lines(300, 'draft')}`);
    commitOn(r, 'docs: a typo fix', 2);
    r.git('checkout', '-q', ours);
    r.git('merge', '-q', '--no-edit', '--no-ff', theirs);
    verdicts.push(verdict(curveAt(r, 'docs/x.md')));
  }
  assert.deepEqual(verdicts[0], verdicts[1]);
});

test('passes on a side branch count across a rename on the line that keeps them', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  convergedOn(r, 'side');
  r.git('checkout', '-q', 'feat');
  r.git('mv', 'docs/x.md', 'docs/y.md');
  r.commit('docs: rename the page');
  r.git('merge', '-q', '--no-edit', 'side');

  const curve = curveAt(r, 'docs/y.md');
  assert.deepEqual(curve, [300, 180, 175, 171]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'converged' });
});

test("an override on the branch's own line survives a pull that takes the collaborator's copy", async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  const draft = r.commit('docs: draft');
  r.write('docs/x.md', lines(191, 'draft'));
  r.commit('docs: a pass');
  r.git('commit', '-q', '--allow-empty', '-m', 'docs: waive it', '-m', 'Doc-distill-override: docs/x.md the table cannot shrink');

  r.git('checkout', '-q', '-b', 'collaborator', draft);
  r.write('docs/x.md', lines(190, 'draft'));
  r.commit("docs: a collaborator's pass");
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '-X', 'theirs', 'collaborator');

  const run = runCli(r.dir);
  assertNoCrash(run);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /cleared by/);
});

test("a merge that keeps the branch's own absence does not follow a side branch's draft", async (t) => {
  const r = shapeRepo(t);
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');
  r.git('checkout', '-q', '-b', 'side', 'main');
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: a draft on a side branch');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '-s', 'ours', 'side');
  r.write('docs/x.md', lines(60, 'fresh'));
  r.commit('docs: a fresh page');

  const curve = curveAt(r, 'docs/x.md');
  assert.deepEqual(curve, [60]);
  assert.equal(verdict(curve).pass, false);
});

test('passes on a side branch count across a rename made on that side branch', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.git('checkout', '-q', '-b', 'side');
  r.git('mv', 'docs/x.md', 'docs/y.md');
  r.commit('docs: rename the page');
  for (const count of [180, 175, 171]) {
    r.write('docs/y.md', lines(count, 'draft'));
    r.commit(`docs: a pass to ${count}`);
  }
  r.git('checkout', '-q', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');
  r.git('merge', '-q', '--no-edit', 'side');

  const curve = curveAt(r, 'docs/y.md');
  assert.deepEqual(curve, [300, 180, 175, 171]);
  assert.deepEqual(verdict(curve), { pass: true, reason: 'converged' });
});

test('a document with a non-ASCII name is found at every revision', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/café.md', lines(300, 'draft'));
  r.commit('docs: draft');
  convergedOn(r, 'side');
  for (const count of [180, 175, 171]) {
    r.write('docs/café.md', lines(count, 'draft'));
    r.commit(`docs: a pass to ${count} under the accented name`);
  }
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'side');

  const curve = curveAt(r, 'docs/café.md');
  assert.deepEqual(curve, [300, 180, 175, 171]);
});

test("an override on the branch's own line also counts on the merge ref", async (t) => {
  const r = stackedChild(t);
  r.git('reset', '-q', '--hard', 'HEAD^1');
  r.git('commit', '-q', '--allow-empty', '-m', 'docs: waive it', '-m', 'Doc-distill-override: docs/x.md the table cannot shrink');
  r.git('merge', '-q', '--no-edit', '-X', 'theirs', 'main');
  r.write('docs/x.md', `${lines(140, 'draft')}\n${lines(60, 'child')}`);
  r.commit('docs: the child adds 60 words');
  const atHead = runCli(r.dir);

  r.git('checkout', '-q', 'main');
  r.write('other.txt', 'trunk moved on');
  r.commit('chore: trunk work');
  r.git('checkout', '-q', '--detach', 'main');
  r.git('merge', '-q', '--no-edit', '--no-ff', 'feat');
  const atMergeRef = runCli(r.dir);

  assert.equal(atHead.code, 0, atHead.stdout);
  assert.equal(atMergeRef.code, atHead.code, atMergeRef.stdout);
});

test('a stamp drafted under a name a side branch gave the document resolves', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(100, 'draft'));
  r.commit('docs: a start');
  r.git('checkout', '-q', '-b', 'side');
  r.git('mv', 'docs/x.md', 'docs/y.md');
  r.write('docs/y.md', lines(300, 'draft'));
  r.commit('docs: rename and draft');
  r.write('docs/y.md', lines(140, 'draft'));
  r.commit('docs: distil');
  r.git('checkout', '-q', 'feat');
  r.write('notes.txt', 'branch work');
  r.commit('chore: branch work');
  r.git('merge', '-q', '--no-edit', 'side');

  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:'));
  assert.match(printed, /:docs\/y\.md /);
  r.write('docs/y.md', `${printed.trim()}\n${lines(140, 'draft')}`);
  r.commit('docs: stamp it');
  assert.deepEqual(verifyStamp(r.dir, 'docs/y.md'), { ok: true, problem: null });
});

test('the gate examines a document with a non-ASCII name', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/café.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.write('docs/café.md', lines(290, 'draft'));
  r.commit('docs: a weak pass');

  const run = runCli(r.dir, {}, ['--summary']);
  assertNoCrash(run);
  assert.match(run.stdout, /docs\/café\.md \(new\): 300 -> 290/);
  assert.equal(run.code, 1);
});

test('the gate examines a document whose name looks like pathspec magic', async (t) => {
  const r = shapeRepo(t);
  r.write(':x.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.write(':x.md', lines(290, 'draft'));
  r.commit('docs: a weak pass');

  const run = runCli(r.dir, {}, ['--summary']);
  assertNoCrash(run);
  assert.match(run.stdout, /:x\.md \(new\): 300 -> 290/);
  assert.equal(run.code, 1);
});

test("a stamp naming another file's draft is refused by name", async (t) => {
  const r = shapeRepo(t);
  r.write('docs/x.md', lines(100, 'draft'));
  r.write('docs/other.md', lines(100, 'draft'));
  const draft = r.git('rev-parse', '--short', r.commit('docs: two drafts'));
  r.write('docs/x.md', lines(40, 'draft'));
  r.commit('docs: distil');
  r.write('docs/x.md', `<!-- distilled: ${draft}:docs/other.md 100->40 (40.0%) pass=1 -->\n${lines(40, 'draft')}`);
  r.commit('docs: a stamp naming the other draft');

  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');
  assert.equal(ok, false);
  assert.match(problem, /names a file other than docs\/x\.md/);
});

// git quotes a path holding a double quote, a backslash, a tab, or a newline even
// under core.quotePath=false, so a line-split listing never matches the name.
test('the gate examines a document whose name holds a quote and a space', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/say "hi".md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.write('docs/say "hi".md', lines(290, 'draft'));
  r.commit('docs: a weak pass');

  const run = runCli(r.dir, {}, ['--summary']);
  assertNoCrash(run);
  assert.match(run.stdout, /docs\/say "hi"\.md \(new\): 300 -> 290/);
  assert.equal(run.code, 1);
});

test('a branch rename away from a quoted name keeps the document an edit', async (t) => {
  const r = repo(t);
  r.write('docs/say "hi".md', lines(50, 'trunk'));
  r.commit('chore: init');
  r.git('checkout', '-q', '-b', 'feat');
  r.git('mv', 'docs/say "hi".md', 'docs/x.md');
  r.write('docs/x.md', `${lines(50, 'trunk')}\n${lines(20, 'branch')}`);
  r.commit('docs: rename and add');

  const { kind, points } = measureCurve(r.dir, 'docs/x.md');
  assert.deepEqual([kind, points.map((point) => point.count)], ['edit', [20]]);
});

// git reads `<rev>:<path>` at the first colon, so the stamp must too.
test('the stamp the gate prints for a name with a colon proves itself', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/a:b.md', lines(100, 'draft'));
  r.commit('docs: draft');
  r.write('docs/a:b.md', lines(40, 'draft'));
  r.commit('docs: distil');
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  r.write('docs/a:b.md', `${printed}\n${lines(40, 'draft')}`);
  r.commit('docs: stamp it');

  assert.deepEqual(verifyStamp(r.dir, 'docs/a:b.md'), { ok: true, problem: null });
  assert.equal(runCli(r.dir).code, 0);
});

test('an override names a gated document whose name holds a space', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/a b.md', lines(300, 'draft'));
  r.commit('docs: draft');
  r.write('docs/a b.md', lines(290, 'draft'));
  r.commit('docs: a weak pass\n\nDoc-distill-override: docs/a b.md the table cannot shrink');

  const run = runCli(r.dir);
  assert.equal(run.code, 0, run.stdout);
});

// A stamp is text in a pull request. Its revision must never reach git as an option.
test('a stamp whose revision looks like an option is refused before git reads it', async (t) => {
  const r = distilledBranch(t);
  stampWith(r, '<!-- distilled: --output=written-by-stamp 100->40 (40.0%) pass=1 -->');

  const { ok, problem } = verifyStamp(r.dir, 'docs/x.md');
  assert.deepEqual([ok, problem], [false, '--output=written-by-stamp is not <commit>:<path>']);
  assert.equal(existsSync(join(r.dir, 'written-by-stamp')), false);
});

// `git show :docs/x.md` reads the index, and an empty prefix matches every commit.
test('a stamp with no commit part is refused', async (t) => {
  const r = distilledBranch(t);
  stampWith(r, '<!-- distilled: :docs/x.md 100->40 (40.0%) pass=1 -->');

  assert.deepEqual(verifyStamp(r.dir, 'docs/x.md'), { ok: false, problem: ':docs/x.md is not <commit>:<path>' });
});

// A SHA-256 id runs to 64 characters, so git, not a length, decides.
test('a stamp naming a 64-character commit reaches git', async (t) => {
  const r = distilledBranch(t);
  stampWith(r, `<!-- distilled: ${'a'.repeat(64)}:docs/x.md 100->40 (40.0%) pass=1 -->`);

  assert.deepEqual(verifyStamp(r.dir, 'docs/x.md'), { ok: false, problem: `${'a'.repeat(64)}:docs/x.md does not resolve` });
});

test('a stamp whose commit is written in capitals proves itself', async (t) => {
  const r = distilledBranch(t);
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  // The full id, so the capitals are certain to change it: a short one can be all digits.
  const capitals = printed.replace(/distilled: ([0-9a-f]+):/, (_, sha) => `distilled: ${r.git('rev-parse', sha).toUpperCase()}:`);
  assert.match(capitals, /distilled: [0-9A-F]*[A-F][0-9A-F]*:/);
  stampWith(r, capitals);

  assert.deepEqual(verifyStamp(r.dir, 'docs/x.md'), { ok: true, problem: null });
});

test('an override takes the longest gated name its text starts with', () => {
  const gated = new Set(['docs/a', 'docs/a b.md']);
  const commits = [
    { sha: 'abc', author: 'Ada', values: ['docs/a b.md the table cannot shrink'] },
    { sha: 'def', author: 'Ada', values: ['docs/a b.md'] },
  ];
  assert.deepEqual(
    parseOverrides(commits, gated).map(({ file, reason, problem }) => [file, reason, problem]),
    [
      ['docs/a b.md', 'the table cannot shrink', null],
      ['docs/a b.md', '', 'the override carries no reason'],
    ],
  );
});

test('the stamp the gate prints for a name with a space proves itself', async (t) => {
  const r = shapeRepo(t);
  r.write('docs/a b.md', lines(100, 'draft'));
  r.commit('docs: draft');
  r.write('docs/a b.md', lines(40, 'draft'));
  r.commit('docs: distil');
  const printed = runCli(r.dir).stdout.split('\n').find((l) => l.includes('<!-- distilled:')).trim();
  r.write('docs/a b.md', `${printed}\n${lines(40, 'draft')}`);
  r.commit('docs: stamp it');

  assert.deepEqual(verifyStamp(r.dir, 'docs/a b.md'), { ok: true, problem: null });
  assert.equal(runCli(r.dir).code, 0);
});
