import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffReport } from '../core/types';

/**
 * In-editor markers for changed lines you have not read yet.
 *
 * Only unreviewed lines are decorated. Marking the reviewed ones too would
 * turn the whole diff into a wall of colour and teach you to ignore it.
 */
export class Decorations implements vscode.Disposable {
  private readonly unreviewed: vscode.TextEditorDecorationType;
  private readonly severe: vscode.TextEditorDecorationType;
  private enabled = true;

  constructor() {
    this.unreviewed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('blindspot.unreviewedBackground'),
      overviewRulerColor: new vscode.ThemeColor('blindspot.unreviewedBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('blindspot.unreviewedBorder'),
    });
    this.severe = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('blindspot.unreviewedBackground'),
      overviewRulerColor: new vscode.ThemeColor('errorForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('errorForeground'),
      after: {
        contentText: '  unreviewed',
        color: new vscode.ThemeColor('descriptionForeground'),
        fontStyle: 'italic',
      },
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
      const option: vscode.DecorationOptions = {
        range: new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER),
        hoverMessage: new vscode.MarkdownString(
          `**Blindspot** — ${h.lineCount} unread ${h.lineCount === 1 ? 'line' : 'lines'}` +
            `\n\n${h.risk === 'critical' || h.risk === 'high' ? '⚠️ ' : ''}${h.reason}` +
            (h.aiRatio > 0 ? `\n\n${Math.round(h.aiRatio * 100)}% machine-written` : ''),
        ),
      };
      if (h.risk === 'critical' || h.risk === 'high') risky.push(option);
      else plain.push(option);
    }

    editor.setDecorations(this.unreviewed, plain);
    editor.setDecorations(this.severe, risky);
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.unreviewed, []);
      editor.setDecorations(this.severe, []);
    }
  }

  dispose(): void {
    this.clearAll();
    this.unreviewed.dispose();
    this.severe.dispose();
  }
}
