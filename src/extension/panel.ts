import * as vscode from 'vscode';
import { bar, pct } from '../core/score';
import { reportSignature } from '../core/signature';
import type { DiffReport, FileReport, RiskLevel } from '../core/types';

export type PanelMessage =
  | { type: 'open'; file: string; line: number }
  | { type: 'reviewNext' }
  | { type: 'refresh' }
  | { type: 'markReviewed'; file: string };

/**
 * The commit-time panel. Everything it shows comes from a `DiffReport`; it
 * computes nothing of its own, so the panel, the status bar and the git hook
 * can never disagree about your coverage.
 */
export class ReportPanel {
  static readonly viewType = 'blindspot.report';
  private static current: ReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private report: DiffReport | null = null;
  private signature: string | undefined;

  static show(
    extensionUri: vscode.Uri,
    onMessage: (m: PanelMessage) => void,
    report: DiffReport | null,
  ): ReportPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ReportPanel.current) {
      ReportPanel.current.panel.reveal(column, true);
      ReportPanel.current.update(report);
      return ReportPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ReportPanel.viewType,
      'Blindspot',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    ReportPanel.current = new ReportPanel(panel, onMessage);
    // A panel with no HTML is a blank editor tab that explains nothing; when
    // there is no report yet (tracking disabled, first refresh still running)
    // the page says so instead.
    ReportPanel.current.update(report);
    return ReportPanel.current;
  }

  static get active(): ReportPanel | undefined {
    return ReportPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, onMessage: (m: PanelMessage) => void) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: PanelMessage) => onMessage(m),
      null,
      this.disposables,
    );
  }

  /**
   * Render a report, or — with `null` — the page that says why there is none.
   * `note` is that reason; it is part of what decides whether to re-render.
   */
  update(report: DiffReport | null, note?: string): void {
    this.report = report;
    // Setting `webview.html` reloads the page: scroll position, focus and any
    // hover state are lost. Skip it when the new report would render the same.
    const signature = report ? reportSignature(report) : `none:${note ?? ''}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.panel.webview.html = this.render(report, note);
    this.panel.title =
      !report || report.totalChangedLines === 0 ? 'Blindspot' : `Blindspot ${pct(report.blindspot)}%`;
  }

  get lastReport(): DiffReport | null {
    return this.report;
  }

  dispose(): void {
    ReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private render(r: DiffReport | null, note?: string): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${STYLES}</style>
</head>
<body>
${r === null ? renderPending(note) : r.totalChangedLines === 0 ? renderEmpty(r) : renderReport(r)}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'open') {
    vscode.postMessage({ type: 'open', file: el.dataset.file, line: Number(el.dataset.line) });
  } else if (action === 'reviewNext') {
    vscode.postMessage({ type: 'reviewNext' });
  } else if (action === 'refresh') {
    vscode.postMessage({ type: 'refresh' });
  } else if (action === 'markReviewed') {
    vscode.postMessage({ type: 'markReviewed', file: el.dataset.file });
  }
});
</script>
</body>
</html>`;
  }
}

function renderPending(note?: string): string {
  return `<div class="wrap">
  <header><h1>BLINDSPOT</h1><button class="ghost" data-action="refresh">refresh</button></header>
  <div class="empty">
    <p>No report yet.</p>
    <p class="muted">${escapeHtml(note ?? 'Blindspot is still computing the first one.')}</p>
  </div>
</div>`;
}

function renderEmpty(r: DiffReport): string {
  return `<div class="wrap">
  <header><h1>BLINDSPOT</h1><button class="ghost" data-action="refresh">refresh</button></header>
  <div class="empty">
    <p>No changes against <code>${escapeHtml(r.baseRef)}</code>.</p>
    <p class="muted">Blindspot starts measuring as soon as you change something.</p>
  </div>
</div>`;
}

function renderReport(r: DiffReport): string {
  const coverage = pct(r.coverage);
  const blind = 100 - coverage;
  const tone = blind >= 35 ? 'bad' : blind >= 15 ? 'warn' : 'good';

  return `<div class="wrap">
  <header>
    <h1>BLINDSPOT</h1>
    <button class="ghost" data-action="refresh">refresh</button>
  </header>

  <section class="card ${tone}">
    <div class="row"><span>Review coverage</span><b>${coverage}%</b></div>
    <div class="row"><span>Blindspot</span><b class="accent">${blind}% ${blind >= 25 ? '⚠️' : ''}</b></div>
    <div class="meter"><i style="width:${coverage}%"></i></div>
    <div class="counts">
      <div><b>${r.totalChangedLines}</b><span>changed lines</span></div>
      <div><b>${r.reviewedLines}</b><span>reviewed</span></div>
      <div><b class="accent">${r.unseenLines}</b><span>unseen</span></div>
    </div>
    <button class="primary" data-action="reviewNext" ${r.unseenLines === 0 ? 'disabled' : ''}>
      ${r.unseenLines === 0 ? 'Nothing left to review' : 'Review Blindspot'}
    </button>
  </section>

  ${renderScoreCard(r)}
  ${renderRiskCard(r)}
  ${renderFileList(r)}
</div>`;
}

function renderScoreCard(r: DiffReport): string {
  const s = r.score;
  const rows = [
    ['Coverage', s.coverage, true],
    ['Critical', s.critical, s.measured.critical],
    ['New code', s.newCode, s.measured.newCode],
    ['AI-generated', s.ai, s.measured.ai],
  ] as Array<[string, number, boolean]>;

  return `<section class="card">
  <h2>Review Score</h2>
  <div class="score"><span class="bar">${bar(s.score / 100)}</span><b>${s.score}</b></div>
  <table class="metrics">
    ${rows
      .map(
        ([label, value, measured]) => `<tr>
      <td>${label}</td>
      <td class="num ${measured ? toneClass(value) : 'muted'}">${measured ? `${pct(value)}%` : '—'}</td>
    </tr>`,
      )
      .join('')}
  </table>
  ${
    s.measured.ai && s.ai < 1
      ? `<p class="note">${pct(1 - s.ai)}% of the machine-written lines in this diff have not been reviewed.</p>`
      : ''
  }
</section>`;
}

function renderRiskCard(r: DiffReport): string {
  const worst = r.hunks.find((h) => h.risk === 'critical' || h.risk === 'high');
  if (!worst) return '';
  const file = r.files.find((f) => f.file === worst.file);
  const unseen = file?.unseenLines ?? worst.lineCount;
  return `<section class="card risk">
  <div class="risk-head">
    <span class="badge ${worst.risk}">⚠️ ${worst.risk === 'critical' ? 'CRITICAL' : 'HIGH RISK'}</span>
    <span class="muted">${escapeHtml(worst.reason)}</span>
  </div>
  <a class="file" data-action="open" data-file="${escapeAttr(worst.file)}" data-line="${worst.startLine}">${escapeHtml(worst.file)}</a>
  <p>You have not reviewed <b>${unseen}</b> changed ${unseen === 1 ? 'line' : 'lines'} here${
    file ? ` (${pct(1 - file.coverage)}% blindspot in this file)` : ''
  }.</p>
  <p class="muted">Starts at line ${worst.startLine}${worst.endLine !== worst.startLine ? `–${worst.endLine}` : ''}.</p>
</section>`;
}

function renderFileList(r: DiffReport): string {
  if (r.files.length === 0) return '';
  return `<section class="card">
  <h2>Files</h2>
  <table class="files">
    <thead><tr><th>file</th><th class="num">unseen</th><th class="num">coverage</th><th></th></tr></thead>
    <tbody>
      ${r.files.map(renderFileRow).join('')}
    </tbody>
  </table>
</section>`;
}

function renderFileRow(f: FileReport): string {
  const target = f.hunks[0]?.startLine ?? 1;
  // Severity comes from the risk of what is still *unread*, matching how the
  // list is ranked. A file whose only unread lines are comments should not
  // wear a critical marker just because the diff also touched auth code.
  const severe = f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high');
  return `<tr class="${severe ? 'severe' : ''}">
  <td>
    <a data-action="open" data-file="${escapeAttr(f.file)}" data-line="${target}">${escapeHtml(f.file)}</a>
    ${f.aiLines > 0 ? `<span class="tag">${pct(f.aiLines / f.changedLines)}% machine</span>` : ''}
    ${severe ? `<span class="tag ${f.blindspotRisk}">${f.blindspotRisk}</span>` : ''}
  </td>
  <td class="num ${f.unseenLines > 0 ? 'accent' : 'muted'}">${f.unseenLines}</td>
  <td class="num ${toneClass(f.coverage)}">${pct(f.coverage)}%</td>
  <td class="num">${
    f.unseenLines > 0
      ? `<button class="ghost small" data-action="markReviewed" data-file="${escapeAttr(f.file)}">mark read</button>`
      : '✓'
  }</td>
</tr>`;
}

function toneClass(v: number): string {
  return v >= 0.9 ? 'good' : v >= 0.7 ? 'warn' : 'bad';
}

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 16px;
}
.wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
header { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 12px; letter-spacing: .22em; margin: 0; opacity: .75; font-weight: 600; }
h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; opacity: .6; margin: 0 0 10px; font-weight: 600; }
.card {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  border-radius: 10px;
  padding: 16px;
  background: var(--vscode-editorWidget-background, transparent);
}
.card.bad { border-color: #f9731699; }
.card.warn { border-color: #eab30899; }
.card.good { border-color: #22c55e77; }
.row { display: flex; justify-content: space-between; align-items: baseline; padding: 3px 0; }
.row b { font-variant-numeric: tabular-nums; font-size: 20px; }
.accent { color: #f97316; }
.good { color: #22c55e; }
.warn { color: #eab308; }
.bad { color: #ef4444; }
.muted { opacity: .55; }
.meter { height: 6px; border-radius: 3px; background: #f9731633; overflow: hidden; margin: 12px 0 14px; }
.meter i { display: block; height: 100%; background: #22c55e; }
.counts { display: flex; gap: 22px; margin-bottom: 14px; }
.counts div { display: flex; flex-direction: column; }
.counts b { font-size: 18px; font-variant-numeric: tabular-nums; }
.counts span { font-size: 11px; opacity: .6; }
button {
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid transparent;
  padding: 7px 12px;
}
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); width: 100%; }
button.primary:disabled { opacity: .5; cursor: default; }
button.ghost { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border, rgba(128,128,128,.4)); opacity: .8; }
button.small { padding: 2px 7px; font-size: 11px; }
.score { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.bar { font-family: var(--vscode-editor-font-family); letter-spacing: -1px; font-size: 16px; }
.score b { font-size: 26px; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; }
.metrics td { padding: 3px 0; }
.metrics td.num { text-align: right; font-variant-numeric: tabular-nums; }
.files th { text-align: left; font-weight: 500; font-size: 11px; opacity: .5; padding-bottom: 6px; }
.files td { padding: 5px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.files td.num, .files th.num { text-align: right; font-variant-numeric: tabular-nums; }
.files tr.severe td:first-child { border-left: 2px solid #f97316; padding-left: 8px; }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
.tag { font-size: 10px; opacity: .6; margin-left: 6px; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.tag.critical, .tag.high { color: #f97316; opacity: .9; }
.badge { font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.badge.critical { color: #ef4444; }
.badge.high { color: #f97316; }
.risk-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.risk .file { display: block; font-family: var(--vscode-editor-font-family); margin-bottom: 6px; }
.risk p { margin: 4px 0; }
.note { margin: 10px 0 0; font-size: 12px; opacity: .75; }
.empty { padding: 24px 0; text-align: center; }
code { font-family: var(--vscode-editor-font-family); }
`;

function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export function riskLabel(level: RiskLevel): string {
  return level === 'critical' ? 'CRITICAL' : level === 'high' ? 'HIGH RISK' : level;
}
