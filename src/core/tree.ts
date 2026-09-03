import { baseLabel, headline, lineNoun } from './labels';
import { pct } from './score';
import type { BlindspotHunk, DiffReport, FileReport, RiskLevel } from './types';

/**
 * The sidebar, as data.
 *
 * The tree view the extension shows is a straight rendering of these nodes;
 * keeping the shape here, with no `vscode` in sight, is what lets the ranking
 * and the wording be asserted in a unit test instead of eyeballed in F5.
 */
export type TreeNode = SummaryNode | FileNode | HunkNode | NoticeNode;

export interface SummaryNode {
  kind: 'summary';
  label: string;
  description: string;
  tooltip: string;
}

export interface FileNode {
  kind: 'file';
  file: string;
  label: string;
  description: string;
  tooltip: string;
  risk: RiskLevel;
  /** Unread lines in high-risk code. */
  severe: boolean;
  unseenLines: number;
  coverage: number;
  /** Where a click should land: the first unread line, or the top. */
  line: number;
  children: HunkNode[];
}

export interface HunkNode {
  kind: 'hunk';
  file: string;
  line: number;
  endLine: number;
  label: string;
  description: string;
  tooltip: string;
  risk: RiskLevel;
  severe: boolean;
}

export interface NoticeNode {
  kind: 'notice';
  label: string;
  description: string;
}

const RISK_WORD: Record<RiskLevel, string> = {
  critical: 'critical',
  high: 'high risk',
  medium: 'medium',
  low: 'low',
};

/** Top-level rows: one summary line, then files in report order (worst first). */
export function buildTree(report: DiffReport | null, note = 'Not measuring yet'): TreeNode[] {
  if (!report) return [{ kind: 'notice', label: note, description: '' }];
  if (report.totalChangedLines === 0) {
    return [
      {
        kind: 'notice',
        label: report.mode === 'reading' ? 'No files opened yet' : 'No changes',
        description: baseLabel(report),
      },
    ];
  }
  return [summaryNode(report), ...report.files.map((f) => fileNode(f, report))];
}

function summaryNode(report: DiffReport): SummaryNode {
  const h = headline(report);
  const counted = report.mode === 'reading' ? report.reviewedLines : report.unseenLines;
  return {
    kind: 'summary',
    label: `${h.value}% ${h.label}`,
    description: `${counted} of ${report.totalChangedLines} ${lineNoun(report.mode)} · ${baseLabel(report)}`,
    tooltip:
      `${report.reviewedLines} reviewed (${report.interactedLines} interacted with) · ` +
      `${report.unseenLines} unread · ${report.files.length} files`,
  };
}

function fileNode(f: FileReport, report: DiffReport): FileNode {
  const severe = f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high');
  const children = f.hunks.map((h) => hunkNode(h));
  const parts: string[] = [];
  if (f.unseenLines > 0) parts.push(`${f.unseenLines} unread`);
  parts.push(`${pct(f.coverage)}%`);
  if (severe) parts.push(RISK_WORD[f.blindspotRisk]);
  const noun = lineNoun(report.mode);
  return {
    kind: 'file',
    file: f.file,
    label: f.file,
    description: parts.join(' · '),
    tooltip:
      `${f.file}\n${f.reviewedLines} of ${f.changedLines} ${noun} reviewed` +
      (f.deletedLines > 0 ? `\n${f.deletedLines} deleted (not measured)` : '') +
      (f.aiLines > 0 ? `\n${f.aiLines} machine-written` : ''),
    risk: f.unseenLines > 0 ? f.blindspotRisk : f.risk,
    severe,
    unseenLines: f.unseenLines,
    coverage: f.coverage,
    line: f.hunks[0]?.startLine ?? 1,
    children,
  };
}

function hunkNode(h: BlindspotHunk): HunkNode {
  const severe = h.risk === 'critical' || h.risk === 'high';
  const range = h.startLine === h.endLine ? `line ${h.startLine}` : `lines ${h.startLine}–${h.endLine}`;
  return {
    kind: 'hunk',
    file: h.file,
    line: h.startLine,
    endLine: h.endLine,
    label: range,
    description: `${h.lineCount} unread · ${h.reason}`,
    tooltip:
      `${h.file}:${h.startLine}${h.endLine !== h.startLine ? `–${h.endLine}` : ''}\n` +
      `${RISK_WORD[h.risk]} — ${h.reason}` +
      (h.aiRatio > 0 ? `\n${pct(h.aiRatio)}% machine-written` : ''),
    risk: h.risk,
    severe,
  };
}
