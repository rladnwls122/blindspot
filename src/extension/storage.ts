import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, type BlindspotConfig } from '../core/config';
import {
  emptyState,
  parseAiRegions,
  parseState,
  pruneState,
  serializeState,
  type AiRegions,
  type BlindspotState,
} from '../core/store';
import type { StoredLine } from '../core/ledger';
import type { GitContext } from './git';
import type { WorkspaceContext } from './workspace';

const STATE_FILE = 'state.json';
const META_FILE = 'meta.json';
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where review evidence lives: `<stateDir>/state.json`. See `workspace.ts` for
 * where that is — inside `.git` when there is one, so it is per-clone, never
 * committed by accident, and disappears with the clone. Review attention is
 * personal telemetry about *you*; it should never end up in a shared branch.
 */
export function statePath(ctx: WorkspaceContext): string {
  return path.join(ctx.stateDir, STATE_FILE);
}

export function metaPath(ctx: WorkspaceContext): string {
  return path.join(ctx.stateDir, META_FILE);
}

/**
 * What a state directory is for, in plain text beside the state itself.
 *
 * A folder that is not a repository has its evidence under
 * `~/.blindspot/<12 hex characters>`, and a directory named like that tells
 * whoever finds it nothing: not which folder it belongs to, not whether it is
 * still in use, not whether deleting it loses anything. So the folder's own
 * path and the time it was last written go in beside it. Inside a repository
 * there is nothing to explain — the directory is `.git/blindspot` — so none is
 * written.
 */
export interface WorkspaceMeta {
  version: number;
  root: string;
  lastAccess: number;
}

export async function loadMeta(ctx: WorkspaceContext): Promise<WorkspaceMeta | null> {
  try {
    const raw = JSON.parse(await fs.readFile(metaPath(ctx), 'utf8')) as Record<string, unknown>;
    if (typeof raw.root !== 'string') return null;
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      root: raw.root,
      lastAccess: typeof raw.lastAccess === 'number' ? raw.lastAccess : 0,
    };
  } catch {
    return null;
  }
}

async function saveMeta(ctx: WorkspaceContext, now: number): Promise<void> {
  if (ctx.git) return;
  const meta: WorkspaceMeta = { version: 1, root: ctx.root, lastAccess: now };
  try {
    await fs.writeFile(metaPath(ctx), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  } catch {
    // A missing note about the state is not a reason to lose the state.
  }
}

export async function loadState(ctx: WorkspaceContext): Promise<BlindspotState> {
  try {
    const raw = await fs.readFile(statePath(ctx), 'utf8');
    return pruneState(parseState(raw), PRUNE_AFTER_MS);
  } catch {
    return emptyState();
  }
}

/**
 * Write atomically. A half-written state file after a crash would silently
 * reset someone's review history, so we rename over the target instead.
 */
export async function saveState(ctx: WorkspaceContext, state: BlindspotState): Promise<void> {
  await fs.mkdir(ctx.stateDir, { recursive: true });
  const target = statePath(ctx);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, serializeState(state), 'utf8');
  await fs.rename(tmp, target);
  await saveMeta(ctx, Date.now());
}

export function fileState(state: BlindspotState, file: string): StoredLine[] {
  return state.files[file] ?? [];
}

/** Project config, committed so a team shares one definition of "risky". */
export async function loadConfig(ctx: { root: string }): Promise<BlindspotConfig> {
  for (const candidate of ['.blindspot/config.json', '.blindspot.json']) {
    try {
      const raw = await fs.readFile(path.join(ctx.root, candidate), 'utf8');
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch {
      // Missing or malformed: fall through to defaults rather than failing to
      // start. A broken config should not disable review tracking.
    }
  }
  return DEFAULT_CONFIG;
}

/** Regions an agent or CI declared as machine-written. */
export async function loadAiRegions(ctx: { root: string }): Promise<AiRegions> {
  try {
    const raw = await fs.readFile(path.join(ctx.root, '.blindspot/ai-regions.json'), 'utf8');
    return parseAiRegions(raw);
  } catch {
    return {};
  }
}

const HOOK_MARKER = '# >>> blindspot >>>';

/**
 * The pre-commit hook. Deliberately non-blocking by default: it prints the
 * card and exits 0 unless the repo config asks for enforcement. A review tool
 * that stops you committing gets uninstalled within a week.
 */
export function hookScript(bundledCli?: string): string {
  // The extension's own copy of the CLI, for the common case: installed from
  // a .vsix, with nothing named `blindspot` on PATH and no node_modules to
  // find it in. Forward slashes because the hook runs under sh even on Windows.
  const posix = bundledCli ? bundledCli.split('\\').join('/') : '';
  const bundled = posix
    ? `elif [ -f "${posix}" ]; then
  node "${posix}" check --staged || exit $?
`
    : '';
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by the Blindspot VS Code extension.
# Remove this block (or the file) to uninstall.
if command -v blindspot >/dev/null 2>&1; then
  blindspot check --staged || exit $?
elif [ -f "$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" ]; then
  "$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" check --staged || exit $?
${bundled}else
  # Fail loudly rather than pretend the diff was reviewed. Still exit 0: a
  # missing review tool is not a reason to block anyone's commit.
  echo "blindspot: CLI not found, skipping review coverage check" >&2
fi
# <<< blindspot <<<
`;
}

/**
 * The prepare-commit-msg hook. Writes the one-line trailer the staged diff
 * earned into the message a commit is about to be made with, so the commit
 * carries `Blindspot: 36% (66/182 lines unread)` for as long as it exists.
 *
 * Opt-in (`blindspot install-hook --trailer`): unlike the evidence in `.git`,
 * this number leaves the repository with the commit. Everything here exits 0
 * — a trailer is a record, never a gate, and no failure of ours may stop a
 * commit. It also runs under `--no-verify`, which is right: that flag skips
 * checks, and this is not one.
 */
export function trailerHookScript(bundledCli?: string): string {
  const posix = bundledCli ? bundledCli.split('\\').join('/') : '';
  const bundled = posix
    ? `  elif [ -f "${posix}" ]; then
    trailer=$(node "${posix}" check --staged --trailer 2>/dev/null)
`
    : '';
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by the Blindspot VS Code extension.
# Records how much of each commit was read as a "Blindspot:" trailer.
# Remove this block (or the file) to uninstall.
blindspot_trailer() {
  # $1 is the message file, $2 where the message came from. A merge or squash
  # message describes other commits, and an amend already carries the trailer
  # its own diff earned; all three are left alone.
  case "$2" in merge|squash|commit) return 0 ;; esac
  if command -v blindspot >/dev/null 2>&1; then
    trailer=$(blindspot check --staged --trailer 2>/dev/null)
  elif [ -f "$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" ]; then
    trailer=$("$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" check --staged --trailer 2>/dev/null)
${bundled}  else
    # No CLI, no measurement, no claim.
    return 0
  fi
  [ -n "$trailer" ] || return 0
  comment=$(git config --get core.commentChar 2>/dev/null) || comment='#'
  [ -n "$comment" ] && [ "$comment" != auto ] || comment='#'
  if grep -v "^[$comment]" "$1" | grep -q '[^[:space:]]'; then
    # There is a message: put the trailer where git puts Signed-off-by, after
    # the body, replacing an earlier one rather than stacking a second.
    git interpret-trailers --in-place --if-exists replace --trailer "$trailer" "$1" 2>/dev/null
  else
    # Nothing typed yet, the editor is about to open: leave the first two lines
    # for the subject and the blank after it, the way git commit -s does.
    { printf '\\n\\n%s\\n' "$trailer"; cat "$1"; } > "$1.blindspot" && mv -f "$1.blindspot" "$1"
  fi
  return 0
}
blindspot_trailer "$1" "$2"
# <<< blindspot <<<
`;
}

export interface InstalledHook {
  path: string;
  action: 'created' | 'appended' | 'present';
}

export async function installHook(ctx: GitContext, bundledCli?: string): Promise<InstalledHook> {
  return writeHook(ctx, 'pre-commit', hookScript(bundledCli));
}

export async function installTrailerHook(ctx: GitContext, bundledCli?: string): Promise<InstalledHook> {
  return writeHook(ctx, 'prepare-commit-msg', trailerHookScript(bundledCli));
}

async function writeHook(ctx: GitContext, name: string, script: string): Promise<InstalledHook> {
  const hooksDir = ctx.hooksDir;
  await fs.mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, name);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(hookPath, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === null) {
    await fs.writeFile(hookPath, script, { mode: 0o755 });
    return { path: hookPath, action: 'created' };
  }
  if (existing.includes(HOOK_MARKER)) {
    return { path: hookPath, action: 'present' };
  }
  const appended = `${existing.replace(/\s*$/, '')}\n\n${script.replace(/^#!.*\n/, '')}`;
  await fs.writeFile(hookPath, appended, { mode: 0o755 });
  return { path: hookPath, action: 'appended' };
}
