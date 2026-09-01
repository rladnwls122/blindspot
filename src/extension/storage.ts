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

const STATE_DIR = 'blindspot';
const STATE_FILE = 'state.json';
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where review evidence lives.
 *
 * `.git/blindspot/state.json` — inside the git directory, so it is per-clone,
 * never committed by accident, and disappears with the clone. Review attention
 * is personal telemetry about *you*; it should never end up in a shared branch.
 */
export function stateDir(ctx: GitContext): string {
  return path.join(ctx.gitDir, STATE_DIR);
}

export function statePath(ctx: GitContext): string {
  return path.join(stateDir(ctx), STATE_FILE);
}

export async function loadState(ctx: GitContext): Promise<BlindspotState> {
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
export async function saveState(ctx: GitContext, state: BlindspotState): Promise<void> {
  const dir = stateDir(ctx);
  await fs.mkdir(dir, { recursive: true });
  const target = statePath(ctx);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, serializeState(state), 'utf8');
  await fs.rename(tmp, target);
}

export function fileState(state: BlindspotState, file: string): StoredLine[] {
  return state.files[file] ?? [];
}

/** Project config, committed so a team shares one definition of "risky". */
export async function loadConfig(ctx: GitContext): Promise<BlindspotConfig> {
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
export async function loadAiRegions(ctx: GitContext): Promise<AiRegions> {
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
export function hookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by the Blindspot VS Code extension.
# Remove this block (or the file) to uninstall.
if command -v blindspot >/dev/null 2>&1; then
  blindspot check --staged || exit $?
elif [ -f "$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" ]; then
  "$(git rev-parse --show-toplevel)/node_modules/.bin/blindspot" check --staged || exit $?
fi
# <<< blindspot <<<
`;
}

export async function installHook(ctx: GitContext): Promise<{ path: string; action: 'created' | 'appended' | 'present' }> {
  const hooksDir = path.join(ctx.gitDir, 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');

  let existing: string | null = null;
  try {
    existing = await fs.readFile(hookPath, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === null) {
    await fs.writeFile(hookPath, hookScript(), { mode: 0o755 });
    return { path: hookPath, action: 'created' };
  }
  if (existing.includes(HOOK_MARKER)) {
    return { path: hookPath, action: 'present' };
  }
  const appended = `${existing.replace(/\s*$/, '')}\n\n${hookScript().replace(/^#!.*\n/, '')}`;
  await fs.writeFile(hookPath, appended, { mode: 0o755 });
  return { path: hookPath, action: 'appended' };
}
