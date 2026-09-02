import type { DiffReport } from './types';

/**
 * A stable fingerprint of what a report *says*. Two reports built seconds apart
 * over the same diff and the same evidence differ only in `generatedAt`, and
 * the report is rebuilt every few seconds for as long as the editor is open.
 *
 * The webview compares this before re-rendering, because setting its HTML
 * reloads the page and loses the scroll position. The tree and the decorations
 * key on smaller things of their own (the built groups; one editor's hunks)
 * for the same reason: a refresh that changed nothing should cost nothing
 * visible.
 */
export function reportSignature(report: DiffReport | null): string {
  if (!report) return '';
  const { generatedAt: _ignored, ...rest } = report;
  return JSON.stringify(rest);
}
