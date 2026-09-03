import * as vscode from 'vscode';
import { MODE_LABEL, baseLabel, headline, paceLabel } from '../core/labels';
import type { DiffReport } from '../core/types';

/**
 * The always-on number, phrased in the direction the mode calls for.
 *
 * In diff mode it is the blindspot, not the coverage: "64% reviewed" reads
 * like a pass mark, "36% unread" reads like a question you have not answered
 * yet. In reading mode there is no deadline and no commit, so it is progress:
 * "62% read". The word is always attached, because a bare percentage cannot
 * say which of the two it is.
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
    const h = headline(report);
    const severe = report.hunks.some((x) => x.risk === 'critical' || x.risk === 'high');
    const reading = report.mode === 'reading';

    const icon = reading ? '$(book)' : report.unseenLines === 0 ? '$(eye)' : '$(eye-closed)';
    this.item.text = `${icon} ${h.value}% ${h.label}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Blindspot · ${MODE_LABEL[report.mode]}** — ${baseLabel(report)}`,
        '',
        `${report.reviewedLines} of ${report.totalChangedLines} ${
          reading ? 'lines in opened files' : 'changed lines'
        } read, ${report.interactedLines} of them interacted with · ${report.unseenLines} unread`,
        '',
        `Read **${report.metrics.read.score}** · Focus **${report.metrics.focus.score}** · ` +
          `Activity **${report.metrics.activity.score}** · ${paceLabel(report.metrics.pace)}`,
        '',
        reading ? '' : `Review Score **${report.score.score}**`,
        severe ? '⚠️ Unread lines in high-risk code.' : '',
        '',
        '_Click to open the report. Switch mode with `Blindspot: Switch Mode`._',
      ]
        .filter((line, i, all) => line !== '' || all[i - 1] !== '')
        .join('\n'),
    );

    // Warning colours belong to the diff, where unread code is about to be
    // committed. Reading has no such moment; a low number there is a start.
    if (!reading && h.value >= 35 && severe) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (!reading && h.value >= 25) {
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
