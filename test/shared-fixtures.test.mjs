import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The counting contract shared with distill-prose, whose Python counter is a
// port of this one. fixtures/counting is copied from that repo, and both
// counters must pass it. Change a count here and it changes there too.
//
// This suite is the repo's own contract, not part of what an install copies.

const home = process.cwd();
const emptyDir = mkdtempSync(join(tmpdir(), 'docs-distill-cwd-'));
process.chdir(emptyDir);
const { proseWords, hiddenWords, fencesBalance, verdict } = await import('../check-docs.mjs');
process.chdir(home);
rmSync(emptyDir, { recursive: true, force: true });

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'counting');
const expected = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8'));

for (const [name, want] of Object.entries(expected.docs)) {
  test(`shared fixture ${name} counts as distill-prose counts it`, () => {
    const text = readFileSync(join(fixtures, name), 'utf8');
    assert.deepEqual(
      { prose: proseWords(text), hidden: hiddenWords(text), balanced: fencesBalance(text) },
      want,
    );
  });
}

for (const { counts, pass, reason } of expected.curves) {
  test(`shared curve ${counts.join('->')} gets the same verdict as distill-prose`, () => {
    assert.deepEqual(verdict(counts), { pass, reason });
  });
}
