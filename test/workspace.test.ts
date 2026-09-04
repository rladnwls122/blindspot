import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWorkspace, workspaceWithoutGit } from '../src/extension/workspace';
import { loadMeta, metaPath, saveState } from '../src/extension/storage';
import { emptyState } from '../src/core/store';

/**
 * Reading code needs a folder, not a repository. What differs between the two
 * is only where the evidence is kept: inside `.git` when there is one, under
 * the home directory when there is not — never as a dot-directory dropped into
 * someone's project.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-ws-'));
}

describe('the note beside a git-less state directory', () => {
  test('says which folder it belongs to, and when it was last written', async () => {
    // ~/.blindspot/<12 hex characters> tells whoever finds it nothing. A
    // person has to be able to see what it is for and delete it by hand.
    const home = tempDir();
    const folder = tempDir();
    const ws = workspaceWithoutGit(folder, home);
    const before = Date.now();
    await saveState(ws, emptyState());

    const meta = await loadMeta(ws);
    assert.notEqual(meta, null);
    assert.equal(meta!.root, path.resolve(folder));
    assert.equal(meta!.lastAccess >= before, true);
    assert.equal(fs.existsSync(metaPath(ws)), true);
  });

  test('a repository needs no note — .git/blindspot explains itself', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const ws = await findWorkspace(repo);
    await saveState(ws, emptyState());
    assert.equal(fs.existsSync(metaPath(ws)), false);
    assert.equal(await loadMeta(ws), null);
  });
});

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
