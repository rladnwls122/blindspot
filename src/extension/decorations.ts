import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffReport } from '../core/types';

/**
 * In-editor markers for lines you have not read yet.
 *
 * Only the gutter is touched: a solid bar beside the line number, and a mark
 * in the overview ruler. The code itself keeps its own colours — painting the
 * whole line was a wall of orange that taught people to ignore it, and made
 * the text harder to read at exactly the moment they were supposed to read it.
 *
 * The colour follows the mode. In a diff an unread line is a warning, so it
 * is orange, and red when the code is high-risk. While reading a codebase an
 * unread line is simply one you have not got to yet, so it is blue — the
 * same mark with none of the alarm, because there is nothing to alarm about.
 */
export class Decorations implements vscode.Disposable {
  private readonly unreviewed: vscode.TextEditorDecorationType;
  private readonly severe: vscode.TextEditorDecorationType;
  private readonly unread: vscode.TextEditorDecorationType;
  private enabled = true;

  constructor() {
    this.unreviewed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar('#f97316'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('blindspot.unreviewedBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.severe = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar('#ef4444'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('errorForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.unread = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar('#3b82f6'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('blindspot.unreadBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clearAll();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  apply(report: DiffReport | null, root: string): void {
    if (!this.enabled) return;
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyTo(editor, report, root);
    }
  }

  applyTo(editor: vscode.TextEditor, report: DiffReport | null, root: string): void {
    if (!this.enabled || !report) return;
    if (editor.document.uri.scheme !== 'file') return;
    const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
    const hunks = report.hunks.filter((h) => h.file === rel);

    const plain: vscode.DecorationOptions[] = [];
    const risky: vscode.DecorationOptions[] = [];

    for (const h of hunks) {
      const start = Math.min(Math.max(0, h.startLine - 1), editor.document.lineCount - 1);
      const end = Math.min(Math.max(0, h.endLine - 1), editor.document.lineCount - 1);
      const hoverMessage = new vscode.MarkdownString(
        `**Blindspot** — ${h.lineCount} unread ${h.lineCount === 1 ? 'line' : 'lines'}` +
          `\n\n${h.risk === 'critical' || h.risk === 'high' ? '⚠️ ' : ''}${h.reason}` +
          (h.aiRatio > 0 ? `\n\n${Math.round(h.aiRatio * 100)}% machine-written` : ''),
      );
      // A gutter icon is per line, not per range: one option per line, or
      // only the first line of a hunk would get the bar.
      const bucket = h.risk === 'critical' || h.risk === 'high' ? risky : plain;
      for (let line = start; line <= end; line++) {
        bucket.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage });
      }
    }

    const reading = report.mode === 'reading';
    editor.setDecorations(this.unreviewed, reading ? [] : plain);
    editor.setDecorations(this.unread, reading ? plain : []);
    editor.setDecorations(this.severe, risky);
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.unreviewed, []);
      editor.setDecorations(this.unread, []);
      editor.setDecorations(this.severe, []);
    }
  }

  dispose(): void {
    this.clearAll();
    this.unreviewed.dispose();
    this.unread.dispose();
    this.severe.dispose();
  }
}

/** A tall, narrow bar that sits against the line number. */
function gutterBar(color: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<rect x="10" y="0" width="5" height="16" rx="1" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}
