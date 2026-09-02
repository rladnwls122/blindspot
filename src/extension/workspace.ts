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
