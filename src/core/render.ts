import { bar, pct } from './score';
import type { BlindspotHunk, DiffReport, FileReport, RiskLevel } from './types';

/**
 * Terminal rendering, shared by the CLI and the git hook. The webview draws
 * the same numbers in HTML; this module exists so the two can never drift on
 * what the numbers *are*.
 */

const RISK_LABEL: Record<RiskLevel, string> = {
  critical: 'CRITICAL',
  high: 'HIGH RISK',
  medium: 'medium',
  low: 'low',
};

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
};

function paint(text: string, code: string, on: boolean | undefined): string {
  return on ? `${code}${text}${ANSI.reset}` : text;
}

/** Display width, counting CJK and emoji as two columns. */
export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
        ? 2
        : 1;
  }
  return w;
}

function padEnd(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return s + ' '.repeat(pad);
}

function padStart(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return ' '.repeat(pad) + s;
}

/** The commit-time card. */
export function renderCard(report: DiffReport, opts: RenderOptions = {}): string {
  const inner = opts.width ?? 33;
  const line = (content = '') => `│ ${padEnd(content, inner - 2)} │`;
  const rows: string[] = [];

  rows.push(`┌${'─'.repeat(inner)}┐`);
  rows.push(line(padStart(padEnd('BLINDSPOT', 20), 24)));
  rows.push(line());

  const coverage = pct(report.coverage);
  const blind = 100 - coverage;
  const warn = blind >= 25 ? ' ⚠' : '';
  rows.push(line(`${padEnd('Review coverage', 18)}${padStart(`${coverage}%`, 5)}`));
  rows.push(line(`${padEnd('Blindspot', 18)}${padStart(`${blind}%`, 5)}${warn}`));
  rows.push(line());
  rows.push(line(`${padStart(String(report.totalChangedLines), 4)} changed lines`));
  rows.push(line(`${padStart(String(report.reviewedLines), 4)} reviewed`));
  rows.push(line(`${padStart(String(report.unseenLines), 4)} unseen`));

  const worst = report.hunks[0];
  if (worst && (worst.risk === 'critical' || worst.risk === 'high')) {
    rows.push(line());
    rows.push(line(`⚠ ${RISK_LABEL[worst.risk]}`));
    rows.push(line(`${short(worst.file, inner - 4)}`));
    rows.push(line(`lines ${worst.startLine}-${worst.endLine} unread`));
  }

  rows.push(line());
  rows.push(line('[ Review Blindspot ]'));
  rows.push(`└${'─'.repeat(inner)}┘`);

  const body = rows.join('\n');
  if (!opts.color) return body;
  return blind >= 25 ? paint(body, ANSI.yellow, true) : paint(body, ANSI.cyan, true);
}

/** The Review Score block. */
export function renderScore(report: DiffReport, opts: RenderOptions = {}): string {
  const s = report.score;
  const rows: string[] = [];
  rows.push(paint('Review Score', ANSI.bold, opts.color));
  rows.push('');
  rows.push(`${bar(s.score / 100)} ${s.score}`);
  rows.push('');
  rows.push(metric('Coverage', s.coverage, true, opts));
  rows.push(metric('Critical', s.critical, s.measured.critical, opts));
  rows.push(metric('New code', s.newCode, s.measured.newCode, opts));
  rows.push(metric('AI-generated', s.ai, s.measured.ai, opts));
  return rows.join('\n');
}

function metric(label: string, value: number, measured: boolean, opts: RenderOptions): string {
  const text = measured ? `${pct(value)}%` : '—';
  const colored =
    measured && opts.color
      ? paint(text, value >= 0.9 ? ANSI.green : value >= 0.7 ? ANSI.yellow : ANSI.red, true)
      : text;
  return `${padEnd(label, 14)}${padStart(colored, opts.color && measured ? text.length + 9 : 4)}`;
}

/** The "Review Blindspot" list: what you have not read, worst first. */
export function renderBlindspots(report: DiffReport, limit = 12, opts: RenderOptions = {}): string {
  if (report.hunks.length === 0) return 'No blindspots. Every changed line has been reviewed.';
  const rows: string[] = [];
  for (const h of report.hunks.slice(0, limit)) {
    rows.push(renderHunk(h, opts));
  }
  const remaining = report.hunks.length - limit;
  if (remaining > 0) rows.push(paint(`… and ${remaining} more`, ANSI.dim, opts.color));
  return rows.join('\n');
}

export function renderHunk(h: BlindspotHunk, opts: RenderOptions = {}): string {
  const badge =
    h.risk === 'critical' || h.risk === 'high'
      ? paint(`⚠ ${RISK_LABEL[h.risk]}`, ANSI.red, opts.color)
      : paint(RISK_LABEL[h.risk], ANSI.dim, opts.color);
  const ai = h.aiRatio > 0 ? `  ${pct(h.aiRatio)}% machine-written` : '';
  const range = h.startLine === h.endLine ? `line ${h.startLine}` : `lines ${h.startLine}–${h.endLine}`;
  return `${h.file}\n  ${range}  (${h.lineCount} unread)  ${badge}  ${h.reason}${ai}`;
}

/** Per-file table for `blindspot report`. */
export function renderFiles(report: DiffReport, opts: RenderOptions = {}): string {
  if (report.files.length === 0) return 'No changed files.';
  const nameWidth = Math.min(48, Math.max(...report.files.map((f) => visualWidth(f.file))));
  const rows = [
    `${padEnd('file', nameWidth)}  ${padStart('cov', 5)}  ${padStart('unseen', 6)}  risk`,
    '─'.repeat(nameWidth + 24),
  ];
  for (const f of report.files) {
    rows.push(renderFileRow(f, nameWidth, opts));
  }
  return rows.join('\n');
}

function renderFileRow(f: FileReport, nameWidth: number, opts: RenderOptions): string {
  const cov = `${pct(f.coverage)}%`;
  // The risk column describes the blindspot, not the diff: a fully reviewed
  // file has no blindspot left to rate, however dangerous its code is.
  const risky = f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high');
  const label = f.unseenLines > 0 ? RISK_LABEL[f.blindspotRisk] : '—';
  const name = short(f.file, nameWidth);
  const line = `${padEnd(name, nameWidth)}  ${padStart(cov, 5)}  ${padStart(String(f.unseenLines), 6)}  ${label}`;
  return risky ? paint(line, ANSI.yellow, opts.color) : line;
}

function short(file: string, width: number): string {
  if (visualWidth(file) <= width) return file;
  return '…' + file.slice(file.length - width + 1);
}

/** One-line summary used by the status bar and the hook's first line. */
export function renderSummaryLine(report: DiffReport): string {
  if (report.totalChangedLines === 0) return 'Blindspot: no changes';
  return `Blindspot ${pct(report.blindspot)}% · ${report.unseenLines}/${report.totalChangedLines} lines unread`;
}
