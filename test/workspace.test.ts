import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWorkspace, relativeToRoot, workspaceWithoutGit } from '../src/extension/workspace';

/**
 * Reading code needs a folder, not a repository. What differs between the two
 * is only where the evidence is kept: inside `.git` when there is one, under
 * the home directory when there is not — never as a dot-directory dropped into
 * someone's project.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-ws-'));
}

describe('findWorkspace', () => {
  test('a repository keeps its state inside .git', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const ws = await findWorkspace(path.join(repo));
    assert.notEqual(ws.git, null);
    assert.equal(path.resolve(ws.root), fs.realpathSync(repo));
    // git prints forward slashes on Windows; compare resolved paths.
    assert.equal(ws.stateDir.startsWith(path.resolve(ws.git!.gitDir)), true);
  });

  test('a plain folder is a workspace too, with state kept out of the folder', async () => {
    const dir = tempDir();
    const ws = await findWorkspace(dir);
    assert.equal(ws.git, null);
    assert.equal(ws.root, path.resolve(dir));
    assert.equal(ws.stateDir.startsWith(path.resolve(dir)), false);
    assert.equal(ws.stateDir.startsWith(path.join(os.homedir(), '.blindspot')), true);
  });

  test('the same folder always maps to the same state directory, regardless of case', () => {
    const a = workspaceWithoutGit('C:/Work/Project', '/home/x');
    const b = workspaceWithoutGit('c:/work/project', '/home/x');
    const c = workspaceWithoutGit('C:/Work/Other', '/home/x');
    assert.equal(a.stateDir, b.stateDir);
    assert.notEqual(a.stateDir, c.stateDir);
  });
});

describe('relativeToRoot', () => {
  const root = path.resolve(path.sep === '\\' ? 'C:/repo' : '/repo');
  const inside = (...parts: string[]) => path.join(root, ...parts);

  test('a file inside the root becomes a forward-slash relative key', () => {
    assert.equal(relativeToRoot(root, inside('src', 'a.ts')), 'src/a.ts');
  });

  test('a file outside the root is not ours', () => {
    assert.equal(relativeToRoot(root, path.join(path.dirname(root), 'other', 'a.ts')), null);
    assert.equal(relativeToRoot(root, root), null);
  });

  test('a file on another Windows drive is not ours either', () => {
    // The bug this pins: between two drives `path.relative` returns an
    // absolute path, not one starting with `..`, so a `startsWith('..')`
    // check accepted `D:\x\a.ts` as a file inside a repository on `C:`.
    if (path.sep !== '\\') return;
    const rel = relativeToRoot('C:\\repo', 'D:\\x\\a.ts');
    assert.equal(rel, null, `should not be inside C:\\repo, got ${rel}`);
  });

  test('a file whose name merely starts with dots is inside', () => {
    assert.equal(relativeToRoot(root, inside('..cache')), '..cache');
  });
});
