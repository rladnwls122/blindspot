import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGitContext, type GitContext } from './git';
import { canonicalPath } from './paths';

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
  /**
   * Where a previous version of this extension would have written the state
   * for the same folder, when that is somewhere else. Read from once, never
   * written to, so an upgrade does not look like a workspace nobody has read.
   */
  legacyStateDir: string | null;
  git: GitContext | null;
}

export function workspaceFromGit(git: GitContext): WorkspaceContext {
  // Inside the git directory: per-clone, never committed, gone with the clone.
  // Nothing is hashed here, so there is no older place to look.
  return { root: git.root, stateDir: path.join(git.gitDir, 'blindspot'), legacyStateDir: null, git };
}

/** The 12 hex characters a folder's state directory is named after. */
function folderKey(root: string): string {
  return createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * State for a folder that is not a repository lives under the home directory,
 * keyed by a hash of the path — there is no `.git` to hide it in, and writing
 * a dot-directory into someone's project is not this extension's call.
 */
export function workspaceWithoutGit(folder: string, home = os.homedir()): WorkspaceContext {
  const given = path.resolve(folder);
  // A folder can be reached by more than one name — through a symlink, a
  // junction, or an 8.3 short name — and the hash is what decides where the
  // reading is kept. Two names meant two histories, and opening the project
  // the other way looked exactly like never having read any of it. The
  // canonical name is the one all of them agree on.
  const root = canonicalPath(given);
  const stateDir = path.join(home, '.blindspot', folderKey(root));
  const legacy = path.join(home, '.blindspot', folderKey(given));
  return { root, stateDir, legacyStateDir: legacy === stateDir ? null : legacy, git: null };
}

/** The workspace for an open folder: its repository if it is in one, else itself. */
export async function findWorkspace(folder: string): Promise<WorkspaceContext> {
  const git = await findGitContext(folder);
  return git ? workspaceFromGit(git) : workspaceWithoutGit(folder);
}
