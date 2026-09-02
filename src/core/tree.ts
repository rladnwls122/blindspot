import { pct } from './score';
import type { DiffReport, FileReport } from './types';

/**
 * The sidebar tree, as data. Pure: two reports in, two groups out, so it can be
 * tested without a `vscode` stub and rendered by anything — the TreeView today,
 * the CLI if it ever wants the same listing.
 *
 * Everything here comes from the same `DiffReport` the status bar and the
 * panel render, so the three can never disagree about your coverage.
 */

export type TreeNode = GroupNode | FileNode;

export interface GroupNode {
  kind: 'group';
  id: string;
  label: string;
  /** "36% unread" / "38% read" — the word says which way the number points. */
  description: string;
  children: FileNode[];
}

export interface FileNode {
  kind: 'file';
  id: string;
  file: string;
  label: string;
  /** "24%  26 unread" */
  description: string;
  tooltip: string;
  /** Unread lines in critical/high-risk code — earns the warning icon. */
  severe: boolean;
  /** First unread line, where a click lands. */
  firstUnreadLine: number | null;
}

/**
 * The diff group comes first — the commit-time warning must never sit below
 * the progress meter — and a group with nothing to show is left out rather
 * than shown empty.
 */
export function buildTree(diff: DiffReport | null, scope: DiffReport | null = null): GroupNode[] {
  const groups: GroupNode[] = [];
  if (diff && diff.totalChangedLines > 0) {
    groups.push({
      kind: 'group',
      id: 'diff',
      label: 'Diff',
      description: `${pct(diff.blindspot)}% unread`,
      children: diff.files.map((f) => fileNode('diff', f)),
    });
  }
  if (scope && scope.totalChangedLines > 0) {
    groups.push({
      kind: 'group',
      id: 'scope',
      label: 'Tracked',
      description: `${pct(scope.coverage)}% read`,
      children: scope.files.map((f) => fileNode('scope', f)),
    });
  }
  return groups;
}

function fileNode(group: string, f: FileReport): FileNode {
  const coverage = pct(f.coverage);
  const severe = f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high');
  const first = f.hunks.reduce<number | null>(
    (best, h) => (best === null || h.startLine < best ? h.startLine : best),
    null,
  );
  return {
    kind: 'file',
    id: `${group}:${f.file}`,
    file: f.file,
    label: f.file,
    description: f.unseenLines === 0 ? `${coverage}%` : `${coverage}%  ${f.unseenLines} unread`,
    tooltip: [
      f.file,
      `${f.reviewedLines} of ${f.changedLines} changed lines reviewed (${coverage}%)`,
      f.unseenLines > 0 ? `${f.unseenLines} unread, highest risk ${f.blindspotRisk}` : 'fully reviewed',
      severe ? '⚠️ Unread lines in high-risk code.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    severe,
    firstUnreadLine: first,
  };
}
