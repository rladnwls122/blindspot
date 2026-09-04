import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The one place a file on disk becomes the key its evidence is stored under.
 *
 * Everything in this extension is keyed by a workspace-relative path: the
 * ledger, the report, the decorations, the sidebar, the state file. They agree
 * only because they all compute the key the same way, and for a while they each
 * computed it separately — three copies of a rule subtle enough to be wrong in
 * the same way three times.
 */

/**
 * A directory can have more than one true name, and the two halves of this
 * calculation get them from different places.
 *
 * The workspace root comes from `git rev-parse --show-toplevel`, which resolves
 * symlinks and, on Windows, always answers with the long form of a name. The
 * file path comes from the editor, which reports the path the folder was opened
 * by. Open a project through a symlink — or through a junction, or by a path
 * holding an 8.3 short name like `C:\\Users\\RUNNER~1` — and the two disagree.
 *
 * `path.relative` then walks up out of the workspace, every key starts with
 * `..`, every file is judged to be outside the workspace, and the extension
 * measures nothing at all. Silently: there is no error to report, because from
 * where the code stands the answer "that file is not in this workspace" is a
 * perfectly ordinary one.
 */
const canonicalCache = new Map<string, string>();
const CACHE_LIMIT = 4096;

export function canonicalPath(p: string): string {
  const hit = canonicalCache.get(p);
  if (hit !== undefined) return hit;

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    // Nothing on disk to ask: a file just deleted, the old side of a rename,
    // a path being named before it exists. Handing back the spelling we were
    // given would put the original problem straight back for exactly these
    // paths — a rename in a workspace opened through a symlink would fail to
    // carry its evidence, which is the case that matters most here. So resolve
    // the nearest ancestor that does exist and put the rest back on, and a
    // path that is not there is still spelled like its neighbours that are.
    const parent = path.dirname(p);
    // dirname of a filesystem root is itself; without this that recurses.
    resolved = parent === p ? p : path.join(canonicalPath(parent), path.basename(p));
  }

  // The cache is here because this runs on the tick path, where a syscall per
  // visible editor per 250 ms would be paid on a network drive too. A workspace
  // has a bounded number of files; a session that somehow outgrows the bound
  // starts over rather than growing without limit.
  if (canonicalCache.size >= CACHE_LIMIT) canonicalCache.clear();
  canonicalCache.set(p, resolved);
  return resolved;
}

/**
 * The workspace-relative key for a file, or null when it is not inside the
 * workspace at all.
 *
 * Null means exactly one thing: this file is somewhere else. Recording evidence
 * under a key the report will never look up would be worse than not recording
 * it, because it looks like tracking and measures nothing.
 */
export function relativeKey(root: string, fsPath: string): string | null {
  const rel = path.relative(canonicalPath(root), canonicalPath(fsPath));
  const normalized = rel.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

/** Forget what has been resolved. For tests, which move real directories about. */
export function clearPathCache(): void {
  canonicalCache.clear();
}
