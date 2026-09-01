import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReport, type ReportSources } from '../core/coverage';
import { LineLedger } from '../core/ledger';
import {
  renderBlindspots,
  renderCard,
  renderFiles,
  renderScore,
  renderSummaryLine,
} from '../core/render';
import { pct } from '../core/score';
import type { BlindspotConfig } from '../core/config';
import type { DiffReport } from '../core/types';
import { collectDiff, findGitContext, type GitContext } from '../extension/git';
import { loadConfig, loadState, installHook } from '../extension/storage';

interface Args {
  command: string;
  staged: boolean;
  json: boolean;
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
  blindspot install-hook         install the pre-commit hook in this repo

Options
  --staged                measure the staged tree (what the commit will contain)
  --base <ref>            diff against <ref> instead of HEAD
  --min-coverage <n>      fail below this coverage percentage (implies --enforce)
  --max-critical <n>      fail above this many unread critical/high-risk lines
  --enforce               exit 1 when thresholds are not met (default: warn only)
  --json                  machine-readable output
  --no-color              disable ANSI colour
  --quiet                 only print when there is something to say
  -h, --help              this message
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = await findGitContext(process.cwd());
  if (!ctx) {
    process.stderr.write('blindspot: not a git repository\n');
    return args.enforce ? 1 : 0;
  }

  if (args.command === 'install-hook') {
    const { path: hookPath, action } = await installHook(ctx);
    process.stdout.write(`blindspot: hook ${action} at ${hookPath}\n`);
    return 0;
  }

  const cfg = await loadConfig(ctx);
  const report = await produceReport(ctx, cfg, args);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
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
  const state = await loadState(ctx);

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
    staged: false,
    json: false,
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

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--staged':
        args.staged = true;
        break;
      case '--json':
        args.json = true;
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
      case '--base':
        args.baseRef = rest[++i] ?? 'HEAD';
        break;
      case '--min-coverage':
        args.minCoverage = Number(rest[++i]);
        args.enforce = true;
        break;
      case '--max-critical':
        args.maxCritical = Number(rest[++i]);
        args.enforce = true;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      default:
        if (a.startsWith('-')) {
          process.stderr.write(`blindspot: unknown option ${a}\n`);
        }
    }
  }

  if (!['check', 'report', 'install-hook', 'help'].includes(args.command)) {
    args.command = 'help';
  }
  return args;
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
