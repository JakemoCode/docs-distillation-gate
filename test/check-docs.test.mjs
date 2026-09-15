import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  formatStamp,
  fencesBalance,
  verifyStamp,
  hiddenWords,
  isGated,
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

const commit = (message, author = 'Ada') => ({ sha: 'a1b2c3d', author, message });

test('parseOverrides reads the file, the reason and the author', () => {
  const commits = [
    commit('docs: cut the protocol page\n\nDoc-distill-override: docs/wire-protocol.md would delete the wire format table'),
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
  assert.deepEqual(parseOverrides([commit('docs: ordinary edit')], GATED), []);
});

test('parseOverrides rejects a trailer naming a file the gate never examines', () => {
  const commits = [commit('Doc-distill-override: notes/vault/note.md too long')];
  const [override] = parseOverrides(commits, GATED);

  assert.equal(override.valid, false);
  assert.match(override.problem, /not a gated file/);
});

test('parseOverrides rejects a trailer with no reason', () => {
  const [override] = parseOverrides([commit('Doc-distill-override: AGENTS.md')], GATED);

  assert.equal(override.valid, false);
  assert.match(override.problem, /no reason/);
});

test('parseOverrides attributes each override to its own commit author', () => {
  const commits = [
    commit('Doc-distill-override: AGENTS.md keeps the rule list', 'Grace'),
    commit('Doc-distill-override: docs/wire-protocol.md keeps the table', 'Ada'),
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

function runCli(repoDir, env = {}) {
  const result = spawnSync(process.execPath, [CLI], {
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
    'Doc-distill-override: notes/vault/a.md too long');

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
