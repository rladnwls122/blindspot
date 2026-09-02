import type { DiffReport } from './types';

/**
 * A stable fingerprint of what a report *says*. Two reports built seconds apart
 * over the same diff and the same evidence differ only in `generatedAt`, and
 * the report is rebuilt every few seconds for as long as the editor is open.
 * Every surface that renders it — the webview, the tree, the decorations —
 * compares this before redrawing, so a refresh that changed nothing costs
 * nothing visible: no webview reload, no tree flicker, no lost scroll position.
 */
export function reportSignature(report: DiffReport | null): string {
  if (!report) return '';
  const { generatedAt: _ignored, ...rest } = report;
  return JSON.stringify(rest);
}
