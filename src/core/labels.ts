import { PACE_CEILING_LINES_PER_MINUTE } from './coverage';
import { pct } from './score';
import type { DiffReport, TargetMode } from './types';

/**
 * Short human phrases shared by the panel, the status bar, the tree view and
 * the CLI, so that the four surfaces describe the same report in the same
 * words. Nothing here computes a number; it only names the ones the report
 * already holds.
 */

export const MODE_LABEL: Record<TargetMode, string> = {
  diff: 'Diff',
  reading: 'Reading',
};

/** What the diff is measured against, e.g. `since HEAD` or `since review a1b2c3d`. */
export function baseLabel(report: Pick<DiffReport, 'mode' | 'baseRef' | 'sinceReview'>): string {
  if (report.mode === 'reading') return 'files you have opened';
  if (report.sinceReview) return `since review ${shortRef(report.baseRef)}`;
  return `since ${shortRef(report.baseRef)}`;
}

/** A commit hash is shortened; a branch or tag name is left alone. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{12,64}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/**
 * The headline number, phrased in the direction the mode calls for.
 *
 * A diff is a question you have not finished answering, so it leads with
 * what is unread; reading a codebase is progress, so it leads with what is
 * done. The two are complements of the same coverage, and the label says
 * which one it is so 62% is never mistaken for 38%.
 */
export function headline(report: Pick<DiffReport, 'mode' | 'coverage' | 'blindspot'>): {
  value: number;
  label: string;
} {
  if (report.mode === 'reading') return { value: pct(report.coverage), label: 'read' };
  return { value: pct(report.blindspot), label: 'unread' };
}

/** What a "line" is in this mode, for counts. */
export function lineNoun(mode: TargetMode): string {
  return mode === 'reading' ? 'lines' : 'changed lines';
}

export function paceLabel(pace: DiffReport['metrics']['pace']): string {
  if (pace.linesPerMinute === null) return 'no reading time yet';
  return `≈ ${pace.linesPerMinute} lines/min`;
}

/** True when the pace is past the point where review studies stop finding bugs. */
export function paceIsFast(pace: DiffReport['metrics']['pace']): boolean {
  return pace.linesPerMinute !== null && pace.linesPerMinute > PACE_CEILING_LINES_PER_MINUTE;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
