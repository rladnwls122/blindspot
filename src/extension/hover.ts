import * as vscode from 'vscode';
import { explain } from '../core/evidence';
import { emptyEvidence, type DiffReport, type LineEvidence } from '../core/types';
import type { BlindspotConfig } from '../core/config';

/**
 * "Why does it think I did not read this?"
 *
 * A coverage number nobody can interrogate is a number nobody believes. The
 * model already knows how to explain any single verdict; this puts that
 * explanation where the disagreement happens, on the line itself.
 *
 * Only unread changed lines get a hover. A reviewed line never prompts the
 * question, and decorating every line in the file with review trivia would
 * make the editor worse for the sake of a feature.
 */
export class EvidenceHover implements vscode.HoverProvider {
  constructor(
    private readonly deps: {
      enabled(): boolean;
      relativePath(uri: vscode.Uri): string | null;
      report(): DiffReport | null;
      evidence(file: string, line: number): LineEvidence | undefined;
      config(): BlindspotConfig;
    },
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!this.deps.enabled()) return undefined;
    const file = this.deps.relativePath(document.uri);
    if (!file) return undefined;

    const line = position.line + 1;
    const hunk = this.deps
      .report()
      ?.hunks.find((h) => h.file === file && line >= h.startLine && line <= h.endLine);
    if (!hunk) return undefined;

    const cfg = this.deps.config();
    const evidence = this.deps.evidence(file, line) ?? emptyEvidence();
    const text = document.lineAt(position.line).text;

    const md = new vscode.MarkdownString(
      [
        `**Blindspot** — this line is unread`,
        '',
        // A code fence, because the explanation is a column of ✓ and · that
        // only reads as a list when it stays monospaced.
        '```',
        explain(evidence, cfg, text),
        '```',
        `Risk: ${hunk.risk} — ${hunk.reason}`,
      ].join('\n'),
    );

    return new vscode.Hover(md, new vscode.Range(position.line, 0, position.line, text.length));
  }
}
