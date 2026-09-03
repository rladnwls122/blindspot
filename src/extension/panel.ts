import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PageData } from '../core/coverage';
import { pct } from '../core/score';
import type { DiffReport } from '../core/types';

export type PanelMessage =
  | { type: 'open'; file: string; line: number }
  | { type: 'reviewNext' }
  | { type: 'refresh' }
  | { type: 'completeReview' }
  | { type: 'markReviewed'; file: string };

/** What the panel shows: the report for its title, the evidence for its page. */
export interface PanelView {
  report: DiffReport;
  data: PageData;
}

/**
 * The commit-time panel: the interactive page in `media/page.html`, fed the
 * per-line evidence the report was judged by. The page re-judges every line
 * itself as its threshold slider moves, from data `pageData` produced, so the
 * panel, the status bar and the git hook can never disagree about a line.
 *
 * The page is loaded once; later reports are posted into it, so the reader's
 * slider and scroll position survive the refresh that runs every few seconds.
 */
export class ReportPanel {
  static readonly viewType = 'blindspot.report';
  private static current: ReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly template: string;
  private readonly disposables: vscode.Disposable[] = [];
  private loaded = false;

  static show(
    extensionUri: vscode.Uri,
    onMessage: (m: PanelMessage) => void,
    view: PanelView | null,
  ): ReportPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ReportPanel.current) {
      ReportPanel.current.panel.reveal(column, true);
      if (view) ReportPanel.current.update(view);
      return ReportPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ReportPanel.viewType,
      'Blindspot',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    const template = fs.readFileSync(path.join(extensionUri.fsPath, 'media', 'page.html'), 'utf8');
    ReportPanel.current = new ReportPanel(panel, template, onMessage);
    if (view) ReportPanel.current.update(view);
    return ReportPanel.current;
  }

  static get active(): ReportPanel | undefined {
    return ReportPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    template: string,
    onMessage: (m: PanelMessage) => void,
  ) {
    this.panel = panel;
    this.template = template;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: PanelMessage) => onMessage(m),
      null,
      this.disposables,
    );
  }

  update({ report, data }: PanelView): void {
    if (this.loaded) {
      void this.panel.webview.postMessage(data);
    } else {
      this.panel.webview.html = this.render(data);
      this.loaded = true;
    }
    this.panel.title =
      report.totalChangedLines === 0 ? 'Blindspot' : `Blindspot ${pct(report.blindspot)}%`;
  }

  dispose(): void {
    ReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private render(data: PageData): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src https://fonts.gstatic.com`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    // No `<` survives raw inside the embedded JSON, so no file name and no
    // line of code can close the script tag that carries it. The replacement
    // is a function because a string one would interpret `$&` in the data.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    const page = this.template
      .replace('<script>', `<script nonce="${nonce}">`)
      .replace('__DATA__', () => json);
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${page}
</html>`;
  }
}

function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
