import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGitContext, type GitContext } from './git';

/**
 * Where Blindspot is running.
 *
 * Reading code does not need git; only diffing does. So the root and the
 * state directory are always present, and `git` is what a diff-based target
 * needs and a reading target does not.
 */
export interface WorkspaceContext {
  /** Absolute path everything is keyed relative to. The repo root when in one. */
  root: string;
  /** Absolute path where per-clone / per-folder state is written. */
  stateDir: string;
  git: GitContext | null;
}

export function workspaceFromGit(git: GitContext): WorkspaceContext {
  // Inside the git directory: per-clone, never committed, gone with the clone.
  return { root: git.root, stateDir: path.join(git.gitDir, 'blindspot'), git };
}

/**
 * State for a folder that is not a repository lives under the home directory,
 * keyed by a hash of the path — there is no `.git` to hide it in, and writing
 * a dot-directory into someone's project is not this extension's call.
 */
export function workspaceWithoutGit(folder: string, home = os.homedir()): WorkspaceContext {
  const root = path.resolve(folder);
  const key = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12);
  return { root, stateDir: path.join(home, '.blindspot', key), git: null };
}

/** The workspace for an open folder: its repository if it is in one, else itself. */
export async function findWorkspace(folder: string): Promise<WorkspaceContext> {
  const git = await findGitContext(folder);
  return git ? workspaceFromGit(git) : workspaceWithoutGit(folder);
}

/**
 * The key everything inside a root is stored under: the path relative to that
 * root, with forward slashes, or null when the file is not under it at all.
 *
 * The evidence, the report, the decorations and the hover all key on this, so
 * they only agree while they compute it the same way — which is why it is one
 * function rather than the four near-copies it used to be. Two of those copies
 * were missing the absolute-path rejection, and on Windows `path.relative`
 * between two drives returns an absolute path rather than one starting with
 * `..`: a file on `D:` was accepted as belonging to a repository on `C:`, and
 * the evidence collected for it was written under a key nothing could ever
 * read back.
 */
export function relativeToRoot(root: string, fsPath: string): string | null {
  const rel = path.relative(root, fsPath).split(path.sep).join('/');
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  // Only a leading `..` segment means "outside"; a file really named `..cache`
  // is inside, and `startsWith('..')` used to throw it away.
  if (rel.split('/')[0] === '..') return null;
  return rel;
}
