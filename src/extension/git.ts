import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mergeDiffs, parseUnifiedDiff } from '../core/diff';
import type { FileDiff } from '../core/types';

const run = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;

export interface GitContext {
  /** Absolute path to the working tree root. */
  root: string;
  /** Absolute path to the git directory (handles worktrees and submodules). */
  gitDir: string;
  /**
   * Absolute path to the directory git actually runs hooks from. Not always
   * `<gitDir>/hooks`: `core.hooksPath` moves it, and husky moves it by default.
   * Writing to the wrong one installs a hook that silently never runs, which
   * is worse than not installing one at all.
   */
  hooksDir: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true });
  return stdout;
}

export async function findGitContext(cwd: string): Promise<GitContext | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
    if (!root || !gitDir) return null;
    return { root, gitDir, hooksDir: await resolveHooksDir(cwd, root, gitDir) };
  } catch {
    return null;
  }
}

async function resolveHooksDir(cwd: string, root: string, gitDir: string): Promise<string> {
  try {
    const configured = (await git(cwd, ['config', '--get', 'core.hooksPath'])).trim();
    // git resolves a relative core.hooksPath against the working tree root.
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.join(root, configured);
    }
  } catch {
    // `config --get` exits 1 when the key is unset. That is the common case.
  }
  return path.join(gitDir, 'hooks');
}

export interface DiffOptions {
  /** Ref to compare against. Defaults to HEAD. */
  baseRef?: string;
  /** Only the staged tree (what a commit would actually contain). */
  staged?: boolean;
  /** Include untracked files as fully-added files. */
  includeUntracked?: boolean;
}

/**
 * The changed-line set the report is built from.
 *
 * By default this is the working tree against HEAD, plus untracked files —
 * because at the moment you are about to commit, a brand-new file you never
 * opened is the largest blindspot you can have, and it appears in no diff.
 */
export async function collectDiff(ctx: GitContext, opts: DiffOptions = {}): Promise<FileDiff[]> {
  const baseRef = opts.baseRef || 'HEAD';
  const args = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames'];
  if (opts.staged) args.push('--cached');
  args.push(baseRef, '--');

  let diffs: FileDiff[] = [];
  try {
    diffs = parseUnifiedDiff(await git(ctx.root, args));
  } catch {
    // An empty repository has no HEAD to diff against; everything is untracked.
    diffs = [];
  }

  if (opts.includeUntracked !== false && !opts.staged) {
    diffs = mergeDiffs(diffs, await untrackedAsDiffs(ctx));
  }
  if (opts.staged) {
    diffs = mergeDiffs(diffs, await stagedNewFilesAsDiffs(ctx));
  }
  return diffs;
}

async function untrackedAsDiffs(ctx: GitContext): Promise<FileDiff[]> {
  let list: string[] = [];
  try {
    list = (await git(ctx.root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
  return wholeFileDiffs(ctx, list);
}

/** `git diff --cached HEAD` already covers added files, but not in a fresh repo. */
async function stagedNewFilesAsDiffs(ctx: GitContext): Promise<FileDiff[]> {
  try {
    await git(ctx.root, ['rev-parse', '--verify', 'HEAD']);
    return [];
  } catch {
    const list = (await git(ctx.root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=A']))
      .split('\0')
      .filter(Boolean);
    return wholeFileDiffs(ctx, list);
  }
}

async function wholeFileDiffs(ctx: GitContext, files: string[]): Promise<FileDiff[]> {
  const out: FileDiff[] = [];
  for (const file of files) {
    try {
      const abs = path.join(ctx.root, file);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const content = await fs.readFile(abs, 'utf8');
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      // A trailing newline produces a final empty element that is not a line.
      const count = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      if (count === 0) continue;
      out.push({
        file,
        addedLines: Array.from({ length: count }, (_, i) => i + 1),
        modifiedLines: [],
        deletedLines: 0,
        binary: false,
      });
    } catch {
      // Unreadable or vanished between listing and reading; skip it.
    }
  }
  return out;
}

/** Commit trailers that explicitly claim machine authorship. */
const AI_TRAILERS = /^(Co-Authored-By:.*(claude|copilot|cursor|codex|gpt|aider|devin)|Generated-By:)/im;

export async function headCommitDeclaresAi(ctx: GitContext): Promise<boolean> {
  try {
    const body = await git(ctx.root, ['log', '-1', '--pretty=%B']);
    return AI_TRAILERS.test(body);
  } catch {
    return false;
  }
}

export async function currentBranch(ctx: GitContext): Promise<string> {
  try {
    return (await git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return 'HEAD';
  }
}

/** Text of a file at a ref, or null when it does not exist there. */
export async function showFile(ctx: GitContext, ref: string, file: string): Promise<string | null> {
  try {
    return await git(ctx.root, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}
