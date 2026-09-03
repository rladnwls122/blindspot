import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashLine } from '../src/core/hash';
import { emptyEvidence } from '../src/core/types';
import { serializeState, emptyState } from '../src/core/store';
import { hookScript } from '../src/extension/storage';
import type { DiffReport } from '../src/core/types';

/**
 * End-to-end: a real git repository, the real CLI binary, real `git diff`.
 *
 * The unit tests cover the model; this covers the plumbing around it —
 * collecting the diff, finding the git directory, anchoring persisted evidence
 * to files on disk, and the exit codes the pre-commit hook depends on.
 */

const CLI = path.resolve(__dirname, '../src/cli/index.js');
let repo: string;

function git(args: string[], cwd = repo, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The installed hooks look for `blindspot` on PATH. A shim there that runs
 * this checkout's CLI lets a real `git commit` exercise them end to end.
 */
let shimDir: string | null = null;
function withCliOnPath(): NodeJS.ProcessEnv {
  if (!shimDir) {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-bin-'));
    const posix = (p: string) => p.split(path.sep).join('/');
    fs.writeFileSync(
      path.join(shimDir, 'blindspot'),
      `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(CLI)}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [key]: `${shimDir}${path.delimiter}${process.env[key] ?? ''}`, NO_COLOR: '1' };
}

function blindspot(args: string[], cwd = repo): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ''), code: err.status ?? 1 };
  }
}

function write(file: string, lines: string[]): void {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + '\n');
}

/** Persist evidence for lines, as if they had been read in the editor. */
function recordAsRead(file: string, lineNumbers: number[]): void {
  const statePath = path.join(repo, '.git', 'blindspot', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : emptyState();

  const text = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  const entries = lineNumbers.map((line) => ({
    h: hashLine(text[line - 1] ?? ''),
    i: line - 1,
    e: {
      ...emptyEvidence(),
      visibleMs: 4000,
      focusedMs: 4000,
      dwellEvents: 1,
      caretHits: 1,
      lastSeen: Date.now(),
    },
  }));

  state.files = { ...state.files, [file]: entries };
  fs.writeFileSync(statePath, serializeState(state));
}

function reportJson(args: string[] = []): DiffReport {
  const { stdout } = blindspot(['check', '--json', ...args]);
  return JSON.parse(stdout);
}

describe('cli against a real repository', () => {
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-it-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);

    write('src/app.ts', ['export const version = "1.0.0";', 'export const name = "demo";']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
  });

  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
  });

  test('a clean tree has nothing to review', () => {
    const { stdout, code } = blindspot(['check']);
    assert.equal(code, 0);
    assert.match(stdout, /no changes/);
  });

  test('counts modified lines against HEAD', () => {
    write('src/app.ts', [
      'export const version = "2.0.0";',
      'export const name = "demo";',
      'export const extra = true;',
    ]);
    const report = reportJson();
    // One rewritten line plus one appended line.
    assert.equal(report.totalChangedLines, 2);
    assert.equal(report.unseenLines, 2);
    assert.equal(report.coverage, 0);
  });

  test('includes untracked files, which no diff would show', () => {
    write('src/brand-new.ts', ['const a = 1;', 'const b = 2;', 'const c = 3;']);
    const report = reportJson();
    const file = report.files.find((f) => f.file === 'src/brand-new.ts');
    assert.ok(file, 'an untracked file is the largest blindspot there is');
    assert.equal(file.changedLines, 3);
  });

  test('persisted evidence marks lines as reviewed', () => {
    recordAsRead('src/brand-new.ts', [1, 2, 3]);
    const report = reportJson();
    const file = report.files.find((f) => f.file === 'src/brand-new.ts');
    assert.equal(file?.reviewedLines, 3);
    assert.equal(file?.unseenLines, 0);
  });

  test('evidence survives an insertion above the lines it belongs to', () => {
    write('src/brand-new.ts', ['// added header', 'const a = 1;', 'const b = 2;', 'const c = 3;']);
    const report = reportJson();
    const file = report.files.find((f) => f.file === 'src/brand-new.ts');
    assert.equal(file?.changedLines, 4);
    assert.equal(file?.reviewedLines, 3, 'the three known lines kept their evidence');
    assert.equal(file?.unseenLines, 1, 'only the new header is unread');
  });

  test('editing a tracked line makes it unread again', () => {
    write('src/brand-new.ts', ['// added header', 'const a = 999;', 'const b = 2;', 'const c = 3;']);
    const report = reportJson();
    const file = report.files.find((f) => f.file === 'src/brand-new.ts');
    assert.equal(file?.reviewedLines, 2);
  });

  test('risk classification reaches the report', () => {
    write('src/auth/session.ts', [
      'const key = process.env.SESSION_KEY;',
      'export function sign(v: string) { return v + key; }',
    ]);
    const report = reportJson();
    const file = report.files.find((f) => f.file === 'src/auth/session.ts');
    assert.equal(file?.risk, 'critical');
    assert.equal(report.files[0].file, 'src/auth/session.ts', 'critical blindspot ranks first');
    assert.equal(report.hunks[0].file, 'src/auth/session.ts');
  });

  test('--staged measures only what the commit will contain', () => {
    git(['add', 'src/auth/session.ts']);
    const staged = reportJson(['--staged']);
    const files = staged.files.map((f) => f.file);
    assert.deepEqual(files, ['src/auth/session.ts']);
    assert.equal(staged.baseRef, 'index');
  });

  test('warns but does not block by default', () => {
    const { code, stdout } = blindspot(['check']);
    assert.equal(code, 0, 'a review tool that blocks commits gets uninstalled');
    assert.match(stdout, /Review coverage/);
  });

  test('--min-coverage blocks and says why', () => {
    const { code, stdout } = blindspot(['check', '--min-coverage', '90']);
    assert.equal(code, 1);
    assert.match(stdout, /below the required 90%/);
    assert.match(stdout, /--no-verify/);
  });

  test('--max-critical blocks on unread high-risk lines', () => {
    const { code, stdout } = blindspot(['check', '--max-critical', '0']);
    assert.equal(code, 1);
    assert.match(stdout, /unread high-risk lines/);
  });

  test('a satisfied threshold exits zero', () => {
    const { code } = blindspot(['check', '--min-coverage', '0', '--max-critical', '9999']);
    assert.equal(code, 0);
  });

  test('report lists every changed file', () => {
    const { stdout, code } = blindspot(['report']);
    assert.equal(code, 0);
    assert.match(stdout, /src\/auth\/session\.ts/);
    assert.match(stdout, /src\/app\.ts/);
    assert.match(stdout, /unseen/);
  });

  test('install-hook writes an executable pre-commit hook', () => {
    const { stdout, code } = blindspot(['install-hook']);
    assert.equal(code, 0);
    assert.match(stdout, /hook created/);

    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    const contents = fs.readFileSync(hookPath, 'utf8');
    assert.match(contents, /blindspot check --staged/);
    // Windows has no executable bit — git runs hooks through sh there regardless,
    // so asserting the mode would only ever fail on the platform, not on the code.
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(hookPath).mode & 0o111) !== 0, true, 'hook must be executable');
    }
  });

  test('install-hook honours core.hooksPath', () => {
    // husky sets core.hooksPath by default. Writing to .git/hooks in a repo
    // that has moved its hook directory installs a hook git will never run,
    // which is a worse outcome than not installing one.
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-hooks-'));
    git(['config', 'core.hooksPath', moved.split(path.sep).join('/')]);
    try {
      const { code } = blindspot(['install-hook']);
      assert.equal(code, 0);
      const contents = fs.readFileSync(path.join(moved, 'pre-commit'), 'utf8');
      assert.match(contents, /blindspot check --staged/);
    } finally {
      git(['config', '--unset', 'core.hooksPath']);
    }
  });

  test('the hook says something when no CLI can be found', () => {
    // Installed from a .vsix there is no `blindspot` on PATH and no
    // node_modules to fall back to. Silently doing nothing would read as
    // "your diff is fine".
    const script = hookScript();
    assert.match(script, /CLI not found/);
    assert.equal(script.includes('node "'), false, 'no bundled path was supplied');

    const withBundled = hookScript('C:\\ext\\bin\\blindspot.js');
    assert.match(withBundled, /node "C:\/ext\/bin\/blindspot\.js" check --staged/);
  });

  test('a mistyped flag is an error, not a silent full run', () => {
    // Reporting coverage for something other than what was asked for is the
    // exact failure this tool exists to prevent.
    const bad = blindspot(['check', '--frobnicate']);
    assert.equal(bad.code, 2);
    assert.equal(blindspot(['frobnicate']).code, 2);
    assert.equal(blindspot(['check', '--min-coverage', 'abc']).code, 2);
    assert.equal(blindspot(['check', '--min-coverage', '150']).code, 2);
    assert.equal(blindspot(['check', '--base']).code, 2);
  });

  test('an unknown base ref is an error, not an empty diff', () => {
    // `git diff nosuchref` fails; treating that as "nothing changed" would let
    // a typo'd --base pass an enforcing hook with 100% coverage.
    write('src/app.ts', ['export const version = "3.0.0";', 'export const name = "demo";']);
    const warn = blindspot(['check', '--base', 'nosuchref']);
    assert.equal(warn.code, 0);
    assert.doesNotMatch(warn.stdout, /changed lines/);
    assert.equal(blindspot(['check', '--base', 'nosuchref', '--min-coverage', '1']).code, 1);
    git(['checkout', '--', 'src/app.ts']);
  });

  test('a broken risk rule in the repo config is skipped, not fatal', () => {
    write('.blindspot/config.json', [
      '{"pathRules":[{"pattern":"(unclosed","level":"critical","reason":"x"},"junk"]}',
    ]);
    write('src/app.ts', ['export const version = "3.0.0";', 'export const name = "demo";']);
    const { stdout, code } = blindspot(['check']);
    assert.equal(code, 0);
    assert.match(stdout, /changed lines/);
    fs.rmSync(path.join(repo, '.blindspot'), { recursive: true, force: true });
    git(['checkout', '--', 'src/app.ts']);
  });

  test('--version and --help are not errors', () => {
    const v = blindspot(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^blindspot \d+\.\d+\.\d+/);
    assert.equal(blindspot(['--help']).code, 0);
  });

  test('install-hook is idempotent', () => {
    const { stdout } = blindspot(['install-hook']);
    assert.match(stdout, /already installed|hook present/);
  });

  test('--trailer prints the one line a commit message would carry', () => {
    // src/auth/session.ts is staged, two lines, neither read.
    const { stdout, code } = blindspot(['check', '--staged', '--trailer']);
    assert.equal(code, 0);
    assert.equal(stdout, 'Blindspot: 100% (2/2 lines unread)\n');
    // Two formats on one stream would paste JSON into a commit message.
    assert.equal(blindspot(['check', '--trailer', '--json']).code, 2);
    assert.equal(blindspot(['read', '--trailer']).code, 2);
  });

  test('install-hook --trailer adds the prepare-commit-msg hook, and only when asked', () => {
    const hookPath = path.join(repo, '.git', 'hooks', 'prepare-commit-msg');
    assert.equal(fs.existsSync(hookPath), false, 'a plain install-hook must not write it');

    const { stdout, code } = blindspot(['install-hook', '--trailer']);
    assert.equal(code, 0);
    assert.match(stdout, /hook present at .*pre-commit/);
    assert.match(stdout, /hook created at .*prepare-commit-msg/);

    const contents = fs.readFileSync(hookPath, 'utf8');
    assert.match(contents, /check --staged --trailer/);
    assert.match(contents, /merge\|squash\|commit\) return 0/, 'other people\'s messages are left alone');
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(hookPath).mode & 0o111) !== 0, true, 'hook must be executable');
    }

    const again = blindspot(['install-hook', '--trailer']).stdout;
    assert.equal(again.match(/hook present/g)?.length, 2, 'both hooks are idempotent');
  });

  test('a commit made through the hooks carries the trailer', () => {
    git(['commit', '-q', '-m', 'feat: sign sessions'], repo, withCliOnPath());
    const body = git(['log', '-1', '--pretty=%B']);
    assert.match(body, /^feat: sign sessions\n/, 'the subject is untouched');
    assert.match(body, /^Blindspot: 100% \(2\/2 lines unread\)$/m);
    // git itself reads it back as a trailer, which is what makes it data.
    const value = git(['log', '-1', '--format=%(trailers:key=Blindspot,valueonly)']).trim();
    assert.equal(value, '100% (2/2 lines unread)');
  });

  test('a commit with nothing to measure gets no trailer', () => {
    git(['commit', '-q', '--allow-empty', '-m', 'chore: nothing'], repo, withCliOnPath());
    assert.doesNotMatch(git(['log', '-1', '--pretty=%B']), /Blindspot/);
  });

  test('a message that already carries a trailer gets it replaced, not doubled', () => {
    write('src/next.ts', ['export const next = true;']);
    git(['add', 'src/next.ts']);
    git(
      ['commit', '-q', '-m', 'feat: next', '-m', 'Blindspot: 5% (1/20 lines unread)'],
      repo,
      withCliOnPath(),
    );
    const body = git(['log', '-1', '--pretty=%B']);
    assert.equal(body.match(/^Blindspot:/gm)?.length, 1);
    assert.match(body, /^Blindspot: 100% \(1\/1 lines unread\)$/m, 'the measured value wins');
  });

  test(
    'with the editor about to open, the trailer leaves the subject line free',
    { skip: process.platform === 'win32' && 'the editor shim is a shell script' },
    () => {
      // `git commit` with no -m: the hook sees an empty message and must not
      // put the trailer on the line the subject is about to be typed on. The
      // editor here copies the buffer out and aborts the commit.
      write('src/editor.ts', ['export const editor = true;']);
      git(['add', 'src/editor.ts']);
      const capture = path.join(shimDir as string, 'editor-buffer');
      const editor = path.join(shimDir as string, 'editor.sh');
      fs.writeFileSync(editor, `#!/bin/sh\ncp "$1" "${capture}"\nexit 1\n`, { mode: 0o755 });
      try {
        git(['commit', '-q'], repo, { ...withCliOnPath(), GIT_EDITOR: editor });
        assert.fail('the aborting editor should have aborted the commit');
      } catch (err: any) {
        assert.equal(err.status, 1);
      }
      const buffer = fs.readFileSync(capture, 'utf8');
      assert.match(buffer, /^\n\nBlindspot: 100% \(1\/1 lines unread\)\n/, 'as git commit -s lays it out');
      git(['reset', '-q', '--', 'src/editor.ts']);
      fs.rmSync(path.join(repo, 'src/editor.ts'));
    },
  );

  test('project config overrides the defaults', () => {
    write('.blindspot/config.json', [
      JSON.stringify({ ignore: ['**/node_modules/**', 'src/auth/**'] }),
    ]);
    const report = reportJson();
    const files = report.files.map((f) => f.file);
    assert.equal(files.includes('src/auth/session.ts'), false, 'ignored by project config');
  });

  test('a malformed project config falls back to defaults instead of failing', () => {
    write('.blindspot/config.json', ['{ not json']);
    const { code, stdout } = blindspot(['check', '--json']);
    assert.equal(code, 0);
    const report = JSON.parse(stdout) as DiffReport;
    assert.ok(report.totalChangedLines > 0);
  });

  test('`read` reports every file with reading evidence, whole, as the editor does', () => {
    write('src/whole.ts', ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;']);
    recordAsRead('src/whole.ts', [1, 2]);
    const { stdout, code } = blindspot(['read']);
    assert.equal(code, 0);
    assert.match(stdout, /Read\s+\d/);
    assert.match(stdout, /src\/whole\.ts/);
    const report = JSON.parse(blindspot(['read', '--json']).stdout) as DiffReport;
    assert.equal(report.mode, 'reading');
    const file = report.files.find((f) => f.file === 'src/whole.ts');
    assert.equal(file?.changedLines, 4, 'the whole file is the target, not a diff');
    assert.equal(file?.reviewedLines, 2);
    assert.equal(file?.interactedLines, 2);
    fs.rmSync(path.join(repo, 'src/whole.ts'));
  });

  test('outside a git repository it says so and does not crash', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-nogit-'));
    try {
      const { code } = blindspot(['check'], plain);
      assert.equal(code, 0);
      // Reading needs a folder, not a repository.
      const read = blindspot(['read'], plain);
      assert.equal(read.code, 0);
      assert.match(read.stdout, /no reading recorded/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
