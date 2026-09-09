import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReport, wholeFileTarget, type ReportSources } from '../core/coverage';
import { LineLedger } from '../core/ledger';
import {
  renderBlindspots,
  renderCard,
  renderFiles,
  renderReading,
  renderScore,
  renderSummaryLine,
  renderTrailer,
} from '../core/render';
import { pct } from '../core/score';
import type { BlindspotConfig } from '../core/config';
import { forgetFiles, isForgotten, measureAgain, type BlindspotState } from '../core/store';
import type { DiffReport, FileDiff } from '../core/types';
import { collectDiff, findGitContext, type GitContext } from '../extension/git';
import { loadConfig, loadState, saveState, installHook, installTrailerHook } from '../extension/storage';
import { findWorkspace, workspaceFromGit } from '../extension/workspace';

const COMMANDS = ['check', 'report', 'read', 'forget', 'install-hook', 'help', 'version'];

interface Args {
  command: string;
  /** A usage mistake, reported instead of guessing what was meant. */
  error: string | null;
  staged: boolean;
  /** A file or folder the command is limited to, when one was given. */
  target: string | null;
  /** `forget --list` and `forget --undo`. */
  list: boolean;
  undo: boolean;
  json: boolean;
  /** Print only the `Blindspot:` commit trailer, for prepare-commit-msg. */
  trailer: boolean;
  enforce: boolean;
  color: boolean;
  quiet: boolean;
  baseRef: string;
  minCoverage: number | null;
  maxCritical: number | null;
}

const HELP = `blindspot — how much of this diff have you actually read?

Usage
  blindspot check [options]      print the review card; exit non-zero if enforcing
  blindspot report [options]     full per-file report
  blindspot read [path]          reading coverage of every file you have opened here
                                 (what the editor's Reading mode shows; needs no git).
                                 With a path, only that file or folder
  blindspot forget <path>        drop everything recorded for a file or folder, so it
                                 leaves the reading report. The evidence is deleted,
                                 and the path stays out until you undo it
  blindspot forget --list        what you have forgotten here
  blindspot forget --undo <path> measure it again from now on
  blindspot install-hook         install the pre-commit hook in this repo
  blindspot install-hook --trailer
                                 also install the prepare-commit-msg hook that
                                 writes a "Blindspot: 36% (66/182 lines unread)"
                                 trailer on every commit. Opt-in: the number
                                 leaves the repository with the commit

Options
  --staged                measure the staged tree (what the commit will contain)
  --base <ref>            diff against <ref> instead of HEAD
  --min-coverage <n>      fail below this coverage percentage (implies --enforce)
  --max-critical <n>      fail above this many unread critical/high-risk lines
  --enforce               exit 1 when thresholds are not met (default: warn only)
  --json                  machine-readable output
  --trailer               print only the commit trailer line (nothing when there
                          is nothing to measure)
  --list                  with forget: list the paths you have forgotten
  --undo                  with forget: measure the path again
  --no-color              disable ANSI colour
  --quiet                 only print when there is something to say
  -v, --version           print the version
  -h, --help              this message
`;

/** Version from the installed package.json, whichever layout we are running in. */
function version(): string {
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(__dirname, candidate), 'utf8')).version;
      if (typeof v === 'string') return v;
    } catch {
      // Try the next layout.
    }
  }
  return 'unknown';
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    // Exit non-zero. A mistyped flag means the caller is not measuring what it
    // thinks it is, and reporting coverage anyway would be a wrong answer
    // delivered confidently.
    process.stderr.write(`blindspot: ${args.error}\n\n${HELP}`);
    return 2;
  }
  if (args.command === 'version') {
    process.stdout.write(`blindspot ${version()}\n`);
    return 0;
  }
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.command === 'read') return readCommand(args);
  if (args.command === 'forget') return forgetCommand(args);

  const ctx = await findGitContext(process.cwd());
  if (!ctx) {
    process.stderr.write('blindspot: not a git repository\n');
    return args.enforce ? 1 : 0;
  }

  if (args.command === 'install-hook') {
    const installed = [await installHook(ctx)];
    if (args.trailer) installed.push(await installTrailerHook(ctx));
    for (const { path: hookPath, action } of installed) {
      process.stdout.write(`blindspot: hook ${action} at ${hookPath}\n`);
    }
    return 0;
  }

  const cfg = await loadConfig(ctx);
  let report: DiffReport;
  try {
    report = await produceReport(ctx, cfg, args);
  } catch (err) {
    // Same shape as "not a git repository": nothing was measured, so an
    // enforcing hook fails and a plain check just says so.
    process.stderr.write(`blindspot: ${err instanceof Error ? err.message : String(err)}\n`);
    return args.enforce ? 1 : 0;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return verdict(report, cfg, args);
  }

  if (args.trailer) {
    // One line or nothing: the hook pastes stdout straight into the message.
    const trailer = renderTrailer(report);
    if (trailer) process.stdout.write(trailer + '\n');
    return verdict(report, cfg, args);
  }

  const code = verdict(report, cfg, args);

  if (args.quiet && report.unseenLines === 0) return code;

  if (report.totalChangedLines === 0) {
    if (!args.quiet) process.stdout.write('blindspot: no changes to review\n');
    return code;
  }

  const out: string[] = [];
  out.push(renderCard(report, { color: args.color }));
  out.push('');
  out.push(renderScore(report, { color: args.color }));

  if (args.command === 'report') {
    out.push('');
    out.push(renderReading(report, { color: args.color }));
    out.push('');
    out.push(renderFiles(report, { color: args.color }));
  }

  if (report.unseenLines > 0) {
    out.push('');
    out.push('Unreviewed:');
    out.push(renderBlindspots(report, args.command === 'report' ? 30 : 6, { color: args.color }));
  }

  if (code !== 0) {
    out.push('');
    out.push(failureReason(report, cfg, args));
    out.push('Commit anyway with `git commit --no-verify`.');
  }

  process.stdout.write(out.join('\n') + '\n');
  return code;
}

async function produceReport(
  ctx: GitContext,
  cfg: BlindspotConfig,
  args: Args,
): Promise<DiffReport> {
  const diffs = await collectDiff(ctx, { baseRef: args.baseRef, staged: args.staged });
  const state = await loadState(workspaceFromGit(ctx));

  // Rebuild each file's ledger by anchoring stored hashes to the text the
  // commit will actually contain.
  const textCache = new Map<string, string[] | undefined>();
  const ledgers = new Map<string, LineLedger>();

  const getText = (file: string): string[] | undefined => {
    if (textCache.has(file)) return textCache.get(file);
    let lines: string[] | undefined;
    if (args.staged) {
      const staged = stagedTextSync(ctx, file);
      lines = staged === null ? undefined : staged.split('\n');
    }
    if (!lines) {
      try {
        const abs = path.join(ctx.root, file);
        if (fs.statSync(abs).size <= 2 * 1024 * 1024) {
          lines = fs.readFileSync(abs, 'utf8').split('\n');
        }
      } catch {
        lines = undefined;
      }
    }
    textCache.set(file, lines);
    return lines;
  };

  const sources: ReportSources = {
    getText,
    getEvidence: (file, line) => {
      let ledger = ledgers.get(file);
      if (!ledger) {
        const stored = state.files[file] ?? [];
        const text = getText(file) ?? [];
        ledger = LineLedger.anchor(stored, text);
        ledgers.set(file, ledger);
      }
      return ledger.peek(line);
    },
  };

  return buildReport(diffs, sources, cfg, args.staged ? 'index' : args.baseRef);
}

/**
 * `blindspot read`: every file with persisted reading evidence, whole, which
 * is what the editor's Reading mode measures. It needs a folder, not a
 * repository, so the workspace is resolved the way the extension resolves it
 * and the state is read from wherever that put it.
 */
async function readCommand(args: Args): Promise<number> {
  const ws = await findWorkspace(process.cwd());
  const cfg = await loadConfig(ws);
  const state = await loadState(ws);
  const only = args.target === null ? null : relativeTarget(ws.root, args.target);
  const report = readingReport(ws.root, state, cfg, only);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  if (report.totalChangedLines === 0) {
    if (!args.quiet) {
      process.stdout.write(
        only === null
          ? 'blindspot: no reading recorded here yet — open files in the editor with Reading mode on\n'
          : `blindspot: no reading recorded for ${only}\n`,
      );
    }
    return 0;
  }
  const out: string[] = [];
  out.push(renderReading(report, { color: args.color }));
  out.push('');
  out.push(renderFiles(report, { color: args.color }));
  if (report.unseenLines > 0) {
    out.push('');
    out.push('Unread:');
    out.push(renderBlindspots(report, 30, { color: args.color }));
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/**
 * The one spelling of a path that two sources can be compared by.
 *
 * Windows keeps 8.3 short names for directories, so the same folder can be
 * `C:\\Users\\RUNNER~1\\…` or `C:\\Users\\runneradmin\\…` depending on who is
 * asking. Falls back to the path as given when it does not exist, which is a
 * perfectly ordinary thing for a `forget` target to be.
 */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * A path the user typed, as the key the evidence is stored under: relative to
 * the workspace root, forward slashes, no trailing one. A path outside the
 * workspace comes back as given, and matches nothing — the honest outcome,
 * rather than quietly reporting on some other folder.
 *
 * Both sides are canonicalised first. `root` comes from
 * `git rev-parse --show-toplevel`, which always answers with the long form,
 * while `process.cwd()` reports whatever spelling the shell was started with.
 * When the two disagree, `path.relative` walks up out of the repository and
 * every path the user names matches nothing at all.
 */
function relativeTarget(root: string, given: string): string {
  const abs = canonical(path.resolve(canonical(process.cwd()), given));
  const rel = path.relative(canonical(root), abs);
  const normalized = rel.split(path.sep).join('/').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

/** True when `file` is `target` itself, or lives under it. */
function withinTarget(file: string, target: string | null): boolean {
  if (target === null || target === '.') return true;
  return file === target || file.startsWith(`${target}/`);
}

/**
 * Drop a file or folder from the reading target, evidence and all.
 *
 * Deleting the evidence is only half of it. The path is remembered as
 * forgotten, because a file still open in the editor would earn fresh evidence
 * within seconds and be back in the denominator before anyone looked.
 */
async function forgetCommand(args: Args): Promise<number> {
  const ws = await findWorkspace(process.cwd());
  const state = await loadState(ws);

  if (args.list) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ forgotten: state.ignored }, null, 2) + '\n');
      return 0;
    }
    if (state.ignored.length === 0) {
      if (!args.quiet) process.stdout.write('blindspot: nothing forgotten here\n');
      return 0;
    }
    process.stdout.write(state.ignored.map((p) => `  ${p}`).join('\n') + '\n');
    return 0;
  }

  if (args.target === null) {
    process.stderr.write(`blindspot: forget needs a path\n\n${HELP}`);
    return 2;
  }
  const target = relativeTarget(ws.root, args.target);

  if (args.undo) {
    const { state: next, restored } = measureAgain(state, target);
    if (restored.length === 0) {
      if (!args.quiet) process.stdout.write(`blindspot: ${target} was not forgotten\n`);
      return 0;
    }
    await saveState(ws, next);
    process.stdout.write(
      `blindspot: measuring ${restored.join(', ')} again — nothing in it is read yet\n`,
    );
    return 0;
  }

  const { state: next, forgotten } = forgetFiles(state, target);
  await saveState(ws, next);
  if (args.json) {
    process.stdout.write(JSON.stringify({ target, forgotten }, null, 2) + '\n');
    return 0;
  }
  const what =
    forgotten.length === 0
      ? `${target} (nothing was recorded for it)`
      : forgotten.length === 1
        ? forgotten[0]
        : `${forgotten.length} files under ${target}`;
  process.stdout.write(`blindspot: forgot ${what}\n`);
  return 0;
}

export function readingReport(
  root: string,
  state: BlindspotState,
  cfg: BlindspotConfig,
  only: string | null = null,
): DiffReport {
  const textCache = new Map<string, string[] | undefined>();
  const getText = (file: string): string[] | undefined => {
    if (textCache.has(file)) return textCache.get(file);
    let lines: string[] | undefined;
    try {
      const abs = path.join(root, file);
      if (fs.statSync(abs).size <= 2 * 1024 * 1024) lines = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      lines = undefined;
    }
    textCache.set(file, lines);
    return lines;
  };
  const targets: FileDiff[] = [];
  for (const file of Object.keys(state.files).sort()) {
    if (!withinTarget(file, only)) continue;
    if (isForgotten(state.ignored, file)) continue;
    const text = getText(file);
    if (text) targets.push(wholeFileTarget(file, text));
  }
  const ledgers = new Map<string, LineLedger>();
  const sources: ReportSources = {
    getText,
    getEvidence: (file, line) => {
      let ledger = ledgers.get(file);
      if (!ledger) {
        ledger = LineLedger.anchor(state.files[file] ?? [], getText(file) ?? []);
        ledgers.set(file, ledger);
      }
      return ledger.peek(line);
    },
  };
  return buildReport(targets, sources, cfg, 'workspace', Date.now(), {
    mode: 'reading',
    activity: state.activity,
  });
}

/** Synchronous `git show :file`, so the report builder stays simple. */
function stagedTextSync(ctx: GitContext, file: string): string | null {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      cwd: ctx.root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Which thresholds are actually being enforced.
 *
 * A flag enforces only what it names. `--max-critical 0` means "block on
 * unread high-risk lines", not "block on that *and* the default coverage
 * threshold I never mentioned" — otherwise the tool blocks a commit and then
 * reports a reason the caller did not ask about. Bare `--enforce` falls back to
 * the project config for both. `null` means "not enforced".
 */
function thresholds(cfg: BlindspotConfig, args: Args): {
  minCoverage: number | null;
  maxCritical: number | null;
} {
  const explicitCoverage = args.minCoverage !== null;
  const explicitCritical = args.maxCritical !== null;
  const useConfigDefaults = args.enforce && !explicitCoverage && !explicitCritical;

  return {
    minCoverage: explicitCoverage ? args.minCoverage : useConfigDefaults ? cfg.minCoverage : null,
    maxCritical: explicitCritical ? args.maxCritical : useConfigDefaults ? cfg.maxCriticalBlindspotLines : null,
  };
}

function criticalUnread(report: DiffReport): number {
  return report.hunks
    .filter((h) => h.risk === 'critical' || h.risk === 'high')
    .reduce((n, h) => n + h.lineCount, 0);
}

function verdict(report: DiffReport, cfg: BlindspotConfig, args: Args): number {
  if (!args.enforce) return 0;
  if (report.totalChangedLines === 0) return 0;
  const { minCoverage, maxCritical } = thresholds(cfg, args);
  if (minCoverage !== null && pct(report.coverage) < minCoverage) return 1;
  if (maxCritical !== null && criticalUnread(report) > maxCritical) return 1;
  return 0;
}

function failureReason(report: DiffReport, cfg: BlindspotConfig, args: Args): string {
  const { minCoverage, maxCritical } = thresholds(cfg, args);
  const coverage = pct(report.coverage);
  const critical = criticalUnread(report);
  if (minCoverage !== null && coverage < minCoverage) {
    return `blocked: review coverage ${coverage}% is below the required ${minCoverage}%.`;
  }
  if (maxCritical !== null && critical > maxCritical) {
    return `blocked: ${critical} unread high-risk lines (limit ${maxCritical}).`;
  }
  return `blocked: ${renderSummaryLine(report)}`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'check',
    error: null,
    staged: false,
    target: null,
    list: false,
    undo: false,
    json: false,
    trailer: false,
    enforce: false,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    quiet: false,
    baseRef: 'HEAD',
    minCoverage: null,
    maxCritical: null,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) {
    args.command = rest.shift() as string;
  }
  if (args.command === '-h' || args.command === '--help') args.command = 'help';
  if (args.command === '-v' || args.command === '--version') args.command = 'version';

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--staged':
        args.staged = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--trailer':
        args.trailer = true;
        break;
      case '--list':
        args.list = true;
        break;
      case '--undo':
        args.undo = true;
        break;
      case '--enforce':
        args.enforce = true;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '--color':
        args.color = true;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--base': {
        const ref = rest[++i];
        if (!ref || ref.startsWith('-')) args.error ??= '--base needs a ref';
        else args.baseRef = ref;
        break;
      }
      case '--min-coverage':
        args.minCoverage = percentArg(args, a, rest[++i]);
        args.enforce = true;
        break;
      case '--max-critical':
        args.maxCritical = countArg(args, a, rest[++i]);
        args.enforce = true;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      case '-v':
      case '--version':
        args.command = 'version';
        break;
      default:
        if (a.startsWith('-')) {
          args.error ??= `unknown option ${a}`;
        } else if (args.target !== null) {
          args.error ??= `only one path, got ${args.target} and ${a}`;
        } else if (args.command === 'read' || args.command === 'forget') {
          args.target = a;
        } else {
          args.error ??= `unexpected argument ${a}`;
        }
    }
  }

  if (!COMMANDS.includes(args.command)) {
    args.error ??= `unknown command ${args.command}`;
  }
  if (args.trailer && args.json) {
    // Two output formats for one stream: the hook would paste JSON into a
    // commit message. Refuse rather than pick one.
    args.error ??= '--trailer and --json cannot be combined';
  }
  if (args.trailer && (args.command === 'read' || args.command === 'forget')) {
    args.error ??= '--trailer applies to check and install-hook';
  }
  if ((args.list || args.undo) && args.command !== 'forget') {
    args.error ??= `${args.list ? '--list' : '--undo'} applies to forget`;
  }
  if (args.list && args.undo) {
    args.error ??= '--list and --undo cannot be combined';
  }
  return args;
}

/**
 * A threshold that quietly became NaN would enforce nothing while looking like
 * it enforced something, which is the one failure mode this tool exists to
 * prevent in the first place.
 */
function numberArg(args: Args, flag: string, raw: string | undefined): number | null {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) {
    args.error ??= `${flag} needs a number`;
    return null;
  }
  return n;
}

function percentArg(args: Args, flag: string, raw: string | undefined): number | null {
  const n = numberArg(args, flag, raw);
  if (n === null) return null;
  if (n < 0 || n > 100) {
    args.error ??= `${flag} must be between 0 and 100`;
    return null;
  }
  return n;
}

function countArg(args: Args, flag: string, raw: string | undefined): number | null {
  const n = numberArg(args, flag, raw);
  if (n === null) return null;
  if (n < 0) {
    args.error ??= `${flag} cannot be negative`;
    return null;
  }
  return n;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`blindspot: ${err?.message ?? String(err)}\n`);
      // A crashed review tool must never block a commit.
      process.exitCode = 0;
    });
}
