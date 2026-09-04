import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, clearPathCache, relativeKey } from '../src/extension/paths';

/**
 * Everything the extension stores is keyed by a workspace-relative path, and
 * the two halves of that subtraction come from different places: the root from
 * git, the file from the editor. When a directory has more than one true name,
 * they disagree, and the honest-looking answer — "that file is not in this
 * workspace" — is returned for every file in the workspace.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-paths-'));
}

describe('relativeKey', () => {
  beforeEach(() => clearPathCache());

  test('the ordinary case is a plain relative path with forward slashes', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'core', 'a.ts'), 'const a = 1;\n');
    assert.equal(relativeKey(root, path.join(root, 'src', 'core', 'a.ts')), 'src/core/a.ts');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a workspace opened by another of its names still measures its files', () => {
    // git resolves the root; the editor reports the path the folder was opened
    // by. Reached through a symlink the two disagree, and before this every
    // key came out as `../opened-as/src/a.ts` — outside the workspace, so
    // nothing at all was tracked, and nothing said so.
    const base = tempDir();
    const real = path.join(base, 'real');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    fs.writeFileSync(path.join(real, 'src', 'a.ts'), 'const a = 1;\n');
    const opened = path.join(base, 'opened-as');
    fs.symlinkSync(real, opened, 'junction');
    try {
      // Root as git reports it, file as the editor reports it.
      assert.equal(relativeKey(real, path.join(opened, 'src', 'a.ts')), 'src/a.ts');
      // And the other way round, which is what a symlinked home directory does.
      assert.equal(relativeKey(opened, path.join(real, 'src', 'a.ts')), 'src/a.ts');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a file outside the workspace is still refused', () => {
    // The fix must not turn "somewhere else" into a key. Recording evidence
    // under a path the report never looks up is worse than not recording it.
    const base = tempDir();
    const root = path.join(base, 'repo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(base, 'outside.ts'), 'const x = 1;\n');
    try {
      assert.equal(relativeKey(root, path.join(base, 'outside.ts')), null);
      assert.equal(relativeKey(root, root), null, 'the root itself is not a file in it');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a path that does not exist is used as given, not dropped', () => {
    // A file deleted a moment ago, or the old side of a rename. There is no
    // canonical spelling to look up and the one we were handed is the answer.
    const root = tempDir();
    assert.equal(relativeKey(root, path.join(root, 'gone', 'x.ts')), 'gone/x.ts');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('canonicalPath', () => {
  beforeEach(() => clearPathCache());

  test('resolves a link, and answers unresolvable paths with themselves', () => {
    const base = tempDir();
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link, 'junction');
    try {
      assert.equal(canonicalPath(link), canonicalPath(real));
      const missing = path.join(base, 'no-such-thing');
      assert.equal(canonicalPath(missing), missing);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('caching does not outlive a directory it resolved', () => {
    // The cache exists because this runs on the tick path. It must not be the
    // reason a stale answer survives a test, or a session, that moves things.
    const base = tempDir();
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link, 'junction');
    assert.equal(canonicalPath(link), canonicalPath(real));

    fs.rmSync(link);
    clearPathCache();
    assert.equal(canonicalPath(link), link, 'gone, so it is its own answer again');
    fs.rmSync(base, { recursive: true, force: true });
  });
});
