import * as vscode from 'vscode';
import { pct } from '../core/score';
import type { DiffReport } from '../core/types';

/**
 * The always-on number. It is deliberately phrased as the blindspot, not the
 * coverage: "64% reviewed" reads like a pass mark, "36% unread" reads like a
 * question you have not answered yet.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'blindspot.showReport';
    this.item.name = 'Blindspot';
  }

  update(report: DiffReport | null, visible: boolean): void {
    if (!visible || !report || report.totalChangedLines === 0) {
      this.item.hide();
      return;
    }
    const blind = pct(report.blindspot);
    const severe = report.hunks.some((h) => h.risk === 'critical' || h.risk === 'high');

    this.item.text = blind === 0 ? `$(eye) 0%` : `$(eye-closed) ${blind}%`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Blindspot ${blind}%** — ${report.unseenLines} of ${report.totalChangedLines} ${
          report.mode === 'reading' ? 'lines in opened files' : 'changed lines'
        } unread`,
        '',
        `Read **${report.metrics.read.score}** · Focus **${report.metrics.focus.score}** · Activity **${report.metrics.activity.score}**`,
        '',
        `Review Score **${report.score.score}**`,
        '',
        severe ? '⚠️ Unreviewed lines in high-risk code.' : '',
        '',
        '_Click to open the report._',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (blind >= 35 && severe) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (blind >= 25) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
