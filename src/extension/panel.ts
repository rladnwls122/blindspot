import * as vscode from 'vscode';
import type { BlindspotConfig } from '../core/config';
import {
  MODE_LABEL,
  baseLabel,
  formatDuration,
  headline,
  lineNoun,
  paceIsFast,
  paceLabel,
} from '../core/labels';
import { bar, pct } from '../core/score';
import type { DiffReport, FileReport, RiskLevel, TargetMode } from '../core/types';

/** The evaluation-time knobs the tuning panel can preview. */
export interface TuningOverrides {
  reviewThresholdPoints?: number;
  readAckMs?: number;
  contentScaling?: boolean;
}

export type PanelMessage =
  | { type: 'open'; file: string; line: number }
  | { type: 'reviewNext' }
  | { type: 'refresh' }
  | { type: 'completeReview' }
  | { type: 'markReviewed'; file: string }
  | { type: 'setMode'; mode: TargetMode }
  | { type: 'selectBase' }
  | { type: 'preview'; overrides: TuningOverrides | null }
  | { type: 'applyTuning'; overrides: TuningOverrides };

/** Everything the panel draws. It computes nothing of its own. */
export interface PanelView {
  report: DiffReport;
  /** The same evidence scored under the tuning overrides, while previewing. */
  preview: DiffReport | null;
  overrides: TuningOverrides | null;
  /** Diff mode needs a repository; without one the switch is shown disabled. */
  canDiff: boolean;
  /** The values the tuning controls start from. */
  tuning: Required<TuningOverrides>;
}

/**
 * The report panel. Everything it shows comes from a `DiffReport`; it
 * computes nothing of its own, so the panel, the status bar, the sidebar and
 * the git hook can never disagree about your coverage.
 *
 * The page is rendered once. Every later update is posted to it as a fresh
 * body, which the page swaps in place — a full reload every few seconds
 * would throw away the scroll position and whatever the reader was doing,
 * and a tuning slider that resets under your hand is not a control.
 */
export class ReportPanel {
  static readonly viewType = 'blindspot.report';
  private static current: ReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private view: PanelView | null = null;
  private ready = false;

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
    ReportPanel.current = new ReportPanel(panel, onMessage);
    if (view) ReportPanel.current.update(view);
    return ReportPanel.current;
  }

  static get active(): ReportPanel | undefined {
    return ReportPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, onMessage: (m: PanelMessage) => void) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: PanelMessage | { type: 'ready' }) => {
        if (m.type === 'ready') {
          this.ready = true;
          return;
        }
        onMessage(m);
      },
      null,
      this.disposables,
    );
  }

  update(view: PanelView): void {
    this.view = view;
    const shown = view.preview ?? view.report;
    const h = headline(shown);
    this.panel.title = shown.totalChangedLines === 0 ? 'Blindspot' : `Blindspot ${h.value}% ${h.label}`;
    const body = renderBody(view);
    if (this.ready) {
      void this.panel.webview.postMessage({ type: 'render', html: body });
    } else {
      this.panel.webview.html = renderPage(body);
    }
  }

  get lastView(): PanelView | null {
    return this.view;
  }

  dispose(): void {
    ReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

// ------------------------------------------------------------------ page

function renderPage(body: string): string {
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
<div id="root">${body}</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** The body, for the first paint and for every update after it. */
export function renderBody(view: PanelView): string {
  const shown = view.preview ?? view.report;
  return `<div class="wrap">
  ${renderHeader(view, shown)}
  ${shown.totalChangedLines === 0 ? renderEmpty(shown) : renderReport(shown)}
  ${renderTuning(view)}
</div>`;
}

function renderHeader(view: PanelView, r: DiffReport): string {
  const seg = (mode: TargetMode) => {
    const on = r.mode === mode;
    const off = mode === 'diff' && !view.canDiff;
    return `<button role="tab" aria-selected="${on}" class="seg-btn" data-action="setMode" data-mode="${mode}" ${
      off ? 'disabled title="Diff mode needs a git repository"' : ''
    }>${MODE_LABEL[mode]}</button>`;
  };
  const base =
    r.mode === 'diff'
      ? `<button class="chip" data-action="selectBase" title="Change what the diff is measured against">${escapeHtml(
          baseLabel(r),
        )} <span class="caret">▾</span></button>`
      : `<span class="chip static">${escapeHtml(baseLabel(r))}</span>`;
  return `<header>
    <div class="brand">
      <span class="logo">BLINDSPOT</span>
      <div class="seg" role="tablist" aria-label="Mode">${seg('diff')}${seg('reading')}</div>
      ${base}
    </div>
    <div class="tools">
      ${view.preview ? `<span class="badge preview" title="Numbers under the tuning below; nothing has been saved">preview · not saved</span>` : ''}
      <button class="icon" data-action="refresh" title="Refresh">↻</button>
    </div>
  </header>`;
}

function renderEmpty(r: DiffReport): string {
  const what =
    r.mode === 'reading'
      ? `<p>No files opened here yet.</p><p class="muted">Reading mode measures every line of every file you open in this folder.</p>`
      : `<p>No changes ${escapeHtml(baseLabel(r))}.</p><p class="muted">Diff mode starts measuring as soon as you change something.</p>`;
  return `<section class="empty">${what}</section>`;
}

function renderReport(r: DiffReport): string {
  return `${renderHero(r)}
  <div class="duo">
    ${renderMetricsCard(r)}
    ${r.mode === 'diff' ? renderScoreCard(r) : ''}
  </div>
  ${renderRiskCard(r)}
  ${renderFileList(r)}`;
}

/**
 * The headline. A diff leads with what is unread, because that is the
 * question still open before the commit; reading leads with what is read,
 * because that is progress. Same coverage, opposite framing, and the word
 * next to the number is what keeps 62% from being read as 38%.
 */
function renderHero(r: DiffReport): string {
  const h = headline(r);
  const coverage = pct(r.coverage);
  const blind = 100 - coverage;
  const reading = r.mode === 'reading';
  const tone = reading ? 'read' : blind >= 35 ? 'bad' : blind >= 15 ? 'warn' : 'good';
  const noun = lineNoun(r.mode);
  const counts: Array<[string, number, string]> = [
    [noun, r.totalChangedLines, ''],
    ['reviewed', r.reviewedLines, ''],
    ['interacted with', r.interactedLines, 'quiet'],
    ['unread', r.unseenLines, r.unseenLines > 0 ? 'accent' : 'quiet'],
  ];
  if (r.deletedLines > 0) counts.push(['deleted, not measured', r.deletedLines, 'quiet']);
  return `<section class="hero ${tone}">
    <div class="headline">
      <b>${h.value}%</b><span>${h.label}</span>
      ${!reading && blind >= 25 ? '<span class="flag">⚠</span>' : ''}
    </div>
    <div class="meter"><i style="width:${coverage}%"></i></div>
    <dl class="counts">
      ${counts
        .map(([label, n, cls]) => `<div class="${cls}"><dd>${n}</dd><dt>${escapeHtml(label)}</dt></div>`)
        .join('')}
    </dl>
    <div class="actions">
      <button class="primary" data-action="reviewNext" ${r.unseenLines === 0 ? 'disabled' : ''}>
        ${r.unseenLines === 0 ? (reading ? 'Everything read' : 'Nothing left to review') : reading ? 'Continue reading' : 'Review Blindspot'}
      </button>
      ${
        r.mode === 'diff'
          ? `<button class="ghost" data-action="completeReview" title="Move the review baseline to HEAD; the next diff starts after it">Complete review</button>`
          : ''
      }
    </div>
  </section>`;
}

/**
 * The three measurements, side by side and never summed into one another,
 * and the pace they were made at. The composite sits below, labelled as the
 * derived thing it is.
 */
function renderMetricsCard(r: DiffReport): string {
  const m = r.metrics;
  const a = m.activity.counts;
  const actions = a.jumps + a.navigations + a.edits + a.marks + a.completions;
  const fast = paceIsFast(m.pace);
  return `<section class="card">
  <h2>Reading</h2>
  <div class="triple">
    <div><span>Read</span><b class="${toneClass(m.read.fraction)}">${m.read.score}</b><small>${m.read.reviewedLines}/${m.read.targetLines} lines</small></div>
    <div><span>Focus</span><b class="${toneClass(m.focus.fraction)}">${m.focus.score}</b><small>${formatDuration(m.pace.attentionMs)} of attention</small></div>
    <div><span>Activity</span><b class="${toneClass(m.activity.fraction)}">${m.activity.score}</b><small>${actions} actions</small></div>
  </div>
  <div class="pace ${fast ? 'fast' : ''}">
    <span>Pace</span><b>${escapeHtml(paceLabel(m.pace))}</b>
    ${fast ? `<span class="tag warn" title="Review studies see defect detection fall off above roughly 500 lines an hour">fast</span>` : ''}
  </div>
  <p class="note">Final ${m.final} — weighted composite; the three above are what was measured.</p>
</section>`;
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
      <td class="track"><i class="${measured ? toneClass(value) : ''}" style="width:${measured ? pct(value) : 0}%"></i></td>
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
  const range = worst.endLine !== worst.startLine ? `${worst.startLine}–${worst.endLine}` : `${worst.startLine}`;
  return `<section class="risk ${worst.risk}">
  <div class="risk-head">
    <span class="badge ${worst.risk}">⚠ ${worst.risk === 'critical' ? 'CRITICAL' : 'HIGH RISK'}</span>
    <span class="muted">${escapeHtml(worst.reason)}</span>
  </div>
  <a class="file" data-action="open" data-file="${escapeAttr(worst.file)}" data-line="${worst.startLine}">${escapeHtml(worst.file)}<span class="muted">:${range}</span></a>
  <p>${unseen} unread ${unseen === 1 ? 'line' : 'lines'} here${
    file ? `, ${pct(1 - file.coverage)}% of the file's ${lineNoun(r.mode)}` : ''
  }.</p>
</section>`;
}

function renderFileList(r: DiffReport): string {
  if (r.files.length === 0) return '';
  return `<section class="card">
  <h2>Files <span class="muted">worst first</span></h2>
  <ul class="files">
    ${r.files.map((f) => renderFileRow(f, r.mode)).join('')}
  </ul>
</section>`;
}

function renderFileRow(f: FileReport, mode: TargetMode): string {
  const target = f.hunks[0]?.startLine ?? 1;
  // Severity comes from the risk of what is still *unread*, matching how the
  // list is ranked. A file whose only unread lines are comments should not
  // wear a critical marker just because the diff also touched auth code.
  const severe = f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high');
  const tags: string[] = [];
  if (severe) tags.push(`<span class="tag ${f.blindspotRisk}">${f.blindspotRisk}</span>`);
  if (f.aiLines > 0) tags.push(`<span class="tag">${pct(f.aiLines / f.changedLines)}% machine</span>`);
  if (f.deletedLines > 0) tags.push(`<span class="tag muted" title="Deleted lines are reported, not scored">−${f.deletedLines} deleted</span>`);
  const hunks = f.hunks
    .map((h) => {
      const label = h.startLine === h.endLine ? `${h.startLine}` : `${h.startLine}–${h.endLine}`;
      const sev = h.risk === 'critical' || h.risk === 'high';
      return `<button class="hunk ${sev ? 'severe' : ''}" data-action="open" data-file="${escapeAttr(f.file)}" data-line="${h.startLine}" title="${escapeAttr(
        `${h.lineCount} unread · ${h.reason}`,
      )}">${label}</button>`;
    })
    .join('');
  return `<li class="file ${severe ? 'severe' : ''} ${f.unseenLines === 0 ? 'done' : ''}">
  <div class="file-row">
    <a class="path" data-action="open" data-file="${escapeAttr(f.file)}" data-line="${target}">${escapeHtml(f.file)}</a>
    <span class="tags">${tags.join('')}</span>
    <span class="filemeter" title="${f.reviewedLines} of ${f.changedLines} ${escapeAttr(lineNoun(mode))} read"><i class="${toneClass(f.coverage)}" style="width:${pct(f.coverage)}%"></i></span>
    <span class="num ${toneClass(f.coverage)}">${pct(f.coverage)}%</span>
    <span class="num ${f.unseenLines > 0 ? 'accent' : 'muted'}">${f.unseenLines > 0 ? `${f.unseenLines} unread` : '✓'}</span>
    ${
      f.unseenLines > 0
        ? `<button class="ghost small" data-action="markReviewed" data-file="${escapeAttr(f.file)}" title="I read this somewhere Blindspot could not see">mark read</button>`
        : ''
    }
  </div>
  ${hunks ? `<div class="hunks">${hunks}</div>` : ''}
</li>`;
}

/**
 * The definition of "read", previewed against this very report.
 *
 * The controls only cover what changes at evaluation time — the threshold,
 * the read time, and whether a line's density scales it. The focal model
 * shapes how evidence is *collected*, so a preview toggle for it would show
 * nothing, and a control that does nothing is worse than none.
 */
function renderTuning(view: PanelView): string {
  const t = view.tuning;
  const o = view.overrides ?? {};
  const threshold = o.reviewThresholdPoints ?? t.reviewThresholdPoints;
  const readAck = o.readAckMs ?? t.readAckMs;
  const scaling = o.contentScaling ?? t.contentScaling;
  const live = view.report;
  const prev = view.preview;
  const delta = prev
    ? `<div class="delta">
        ${deltaCell('Coverage', `${pct(live.coverage)}%`, `${pct(prev.coverage)}%`)}
        ${deltaCell('Unread', `${live.unseenLines}`, `${prev.unseenLines}`)}
        ${live.mode === 'diff' ? deltaCell('Score', `${live.score.score}`, `${prev.score.score}`) : ''}
        ${deltaCell('Read', `${live.metrics.read.score}`, `${prev.metrics.read.score}`)}
      </div>`
    : `<div class="delta muted">Move a control to see what this report would say under a different definition.</div>`;
  return `<details class="card tuning">
  <summary><h2>Tuning</h2><span class="muted">what "read" means, previewed on this report</span></summary>
  <div class="controls">
    <label>
      <span>Reviewed at</span>
      <input type="range" min="1" max="6" step="1" value="${threshold}" data-tune="reviewThresholdPoints" data-default="${t.reviewThresholdPoints}" data-unit="pts">
      <output>${threshold} pts</output>
    </label>
    <label>
      <span>Read time</span>
      <input type="range" min="500" max="6000" step="250" value="${readAck}" data-tune="readAckMs" data-default="${t.readAckMs}" data-unit="ms">
      <output>${(readAck / 1000).toFixed(2)} s</output>
    </label>
    <label class="check">
      <input type="checkbox" data-tune="contentScaling" data-default="${t.contentScaling}" ${scaling ? 'checked' : ''}>
      <span>Scale read time by line density</span>
    </label>
  </div>
  ${delta}
  <div class="actions">
    <button class="primary small" data-action="applyTuning" ${prev ? '' : 'disabled'}>Apply to workspace</button>
    <button class="ghost small" data-action="resetTuning" ${prev ? '' : 'disabled'}>Reset</button>
  </div>
</details>`;
}

function deltaCell(label: string, from: string, to: string): string {
  const changed = from !== to;
  return `<span class="dcell ${changed ? 'changed' : ''}"><span class="dlabel">${label}</span> ${from}${
    changed ? ` <span class="arrow">→</span> <b>${to}</b>` : ''
  }</span>`;
}

function toneClass(v: number): string {
  return v >= 0.9 ? 'good' : v >= 0.7 ? 'warn' : 'bad';
}

// ---------------------------------------------------------------- assets

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 14px 16px 28px;
}
.wrap { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.wrap > * { min-width: 0; }
.muted { color: var(--vscode-descriptionForeground); }
.accent { color: var(--vscode-charts-orange, #f97316); }
.good { color: var(--vscode-charts-green, #22c55e); }
.warn { color: var(--vscode-charts-yellow, #eab308); }
.bad { color: var(--vscode-charts-red, #ef4444); }
.quiet { opacity: .7; }

/* header */
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.logo { font-size: 11px; letter-spacing: .22em; font-weight: 600; opacity: .75; }
.seg { display: inline-flex; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); border-radius: 6px; overflow: hidden; }
.seg-btn {
  font-family: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
  border: 0; background: transparent; color: var(--vscode-foreground); opacity: .75;
}
.seg-btn + .seg-btn { border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); }
.seg-btn[aria-selected="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
.seg-btn:disabled { opacity: .35; cursor: not-allowed; }
.chip {
  font-family: inherit; font-size: 11px; padding: 3px 8px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  background: transparent; color: var(--vscode-descriptionForeground);
}
.chip:not(.static):hover { color: var(--vscode-foreground); border-color: var(--vscode-foreground); }
.chip.static { cursor: default; }
.chip .caret { opacity: .6; }
.tools { display: flex; align-items: center; gap: 8px; }
.badge.preview {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  background: var(--vscode-charts-orange, #f97316); color: #111; font-weight: 600;
}
button.icon {
  font-family: inherit; font-size: 14px; line-height: 1; padding: 4px 7px; cursor: pointer;
  border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); opacity: .7;
}
button.icon:hover { opacity: 1; border-color: var(--vscode-panel-border, rgba(128,128,128,.4)); }

/* hero */
.hero {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  border-left-width: 4px;
  border-radius: 10px; padding: 16px 18px;
  background: var(--vscode-editorWidget-background, transparent);
  display: flex; flex-direction: column; gap: 12px;
}
.hero.bad { border-left-color: var(--vscode-charts-red, #ef4444); }
.hero.warn { border-left-color: var(--vscode-charts-orange, #f97316); }
.hero.good { border-left-color: var(--vscode-charts-green, #22c55e); }
.hero.read { border-left-color: var(--vscode-charts-blue, #3b82f6); }
.headline { display: flex; align-items: baseline; gap: 8px; }
.headline b { font-size: 34px; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.headline span { font-size: 14px; opacity: .8; }
.headline .flag { color: var(--vscode-charts-orange, #f97316); font-size: 16px; }
.meter { height: 6px; border-radius: 3px; background: rgba(128,128,128,.25); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--vscode-charts-green, #22c55e); transition: width .25s ease; }
.hero.read .meter i { background: var(--vscode-charts-blue, #3b82f6); }
.counts { display: flex; gap: 22px; margin: 0; flex-wrap: wrap; }
.counts div { display: flex; flex-direction: column; }
.counts dd { margin: 0; font-size: 18px; font-variant-numeric: tabular-nums; font-weight: 600; }
.counts dt { font-size: 11px; opacity: .6; }
.counts .accent dd { color: var(--vscode-charts-orange, #f97316); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* cards */
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .duo { grid-template-columns: 1fr; } }
.card {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  border-radius: 10px; padding: 14px 16px;
  background: var(--vscode-editorWidget-background, transparent);
  min-width: 0;
}
h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; opacity: .6; margin: 0 0 10px; font-weight: 600; }
h2 .muted { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; }
.triple { display: flex; gap: 18px; }
.triple div { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.triple span { font-size: 11px; opacity: .6; }
.triple b { font-size: 22px; font-variant-numeric: tabular-nums; }
.triple small { font-size: 11px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pace { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; font-size: 12px; }
.pace span:first-child { opacity: .6; font-size: 11px; }
.pace.fast b { color: var(--vscode-charts-orange, #f97316); }
.note { margin: 10px 0 0; font-size: 12px; opacity: .7; }

button {
  font-family: inherit; font-size: 12px; cursor: pointer;
  border-radius: 6px; border: 1px solid transparent; padding: 6px 12px;
}
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
button.primary:disabled { opacity: .5; cursor: default; }
button.ghost {
  background: transparent; color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, rgba(128,128,128,.4)); opacity: .85;
}
button.ghost:hover { opacity: 1; }
button.ghost:disabled { opacity: .4; cursor: default; }
button.small { padding: 3px 8px; font-size: 11px; }

.score { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.bar { font-family: var(--vscode-editor-font-family); letter-spacing: -1px; font-size: 15px; opacity: .8; }
.score b { font-size: 26px; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; }
.metrics td { padding: 3px 0; font-size: 12px; }
.metrics td.track { width: 45%; padding: 0 10px; }
.metrics td.track i { display: block; height: 4px; border-radius: 2px; background: currentColor; opacity: .8; }
.metrics td.num { text-align: right; font-variant-numeric: tabular-nums; width: 3.5em; }

/* risk */
.risk {
  border-radius: 10px; padding: 12px 16px;
  border: 1px solid var(--vscode-charts-orange, #f97316);
  background: color-mix(in srgb, var(--vscode-charts-orange, #f97316) 8%, transparent);
}
.risk.critical { border-color: var(--vscode-charts-red, #ef4444); background: color-mix(in srgb, var(--vscode-charts-red, #ef4444) 8%, transparent); }
.risk-head { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.badge { font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.badge.critical { color: var(--vscode-charts-red, #ef4444); }
.badge.high { color: var(--vscode-charts-orange, #f97316); }
.risk .file { display: block; font-family: var(--vscode-editor-font-family); font-size: 12px; margin-bottom: 4px; }
.risk p { margin: 0; font-size: 12px; }

/* files */
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.file { padding: 8px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.file:first-child { border-top: 0; }
.file.severe { border-left: 2px solid var(--vscode-charts-red, #ef4444); padding-left: 10px; margin-left: -12px; }
.file.done { opacity: .7; }
.file-row { display: grid; grid-template-columns: minmax(0,1fr) auto 90px 3.5em 6.5em auto; gap: 10px; align-items: center; }
@media (max-width: 640px) { .file-row { grid-template-columns: minmax(0,1fr) auto 3.5em 6.5em; } .filemeter, .file-row button { display: none; } }
.path { font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tags { display: flex; gap: 4px; }
.tag { font-size: 10px; opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; white-space: nowrap; }
.tag.critical, .tag.high { color: var(--vscode-charts-red, #ef4444); opacity: .9; }
.tag.warn { color: var(--vscode-charts-orange, #f97316); opacity: .9; }
.filemeter { height: 4px; border-radius: 2px; background: rgba(128,128,128,.25); overflow: hidden; }
.filemeter i { display: block; height: 100%; background: currentColor; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; white-space: nowrap; }
.hunks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.hunk {
  font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 1px 7px;
  border-radius: 4px; border: 1px solid var(--vscode-charts-orange, #f97316);
  color: var(--vscode-charts-orange, #f97316); background: transparent;
}
.hunk.severe { border-color: var(--vscode-charts-red, #ef4444); color: var(--vscode-charts-red, #ef4444); }
.hunk:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }

/* tuning */
details.tuning summary { cursor: pointer; display: flex; align-items: baseline; gap: 8px; list-style: none; }
details.tuning summary::-webkit-details-marker { display: none; }
details.tuning summary::before { content: '▸'; font-size: 11px; opacity: .6; }
details.tuning[open] summary::before { content: '▾'; }
details.tuning summary h2 { margin: 0; }
.controls { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 8px; }
.controls label { display: grid; grid-template-columns: 8em 1fr 5em; gap: 10px; align-items: center; font-size: 12px; }
.controls label.check { grid-template-columns: auto 1fr; }
.controls output { text-align: right; font-variant-numeric: tabular-nums; opacity: .8; }
input[type="range"] { width: 100%; margin: 0; accent-color: var(--vscode-button-background); }
.delta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; padding: 8px 0; font-variant-numeric: tabular-nums; }
.dcell .dlabel { opacity: .6; margin-right: 2px; }
.dcell.changed b { color: var(--vscode-charts-orange, #f97316); }
.arrow { opacity: .5; }
.empty { padding: 28px 0; text-align: center; }
.empty p { margin: 4px 0; }
code { font-family: var(--vscode-editor-font-family); }
`;

/**
 * The page's own script. It never builds markup from data — every body it
 * swaps in was rendered and escaped by the extension — and it keeps the
 * tuning block alive across swaps so a slider stays where your hand left it.
 */
const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const post = (m) => vscode.postMessage(m);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const action = el.dataset.action;
  if (action === 'open') post({ type: 'open', file: el.dataset.file, line: Number(el.dataset.line) });
  else if (action === 'reviewNext') post({ type: 'reviewNext' });
  else if (action === 'refresh') post({ type: 'refresh' });
  else if (action === 'markReviewed') post({ type: 'markReviewed', file: el.dataset.file });
  else if (action === 'completeReview') post({ type: 'completeReview' });
  else if (action === 'setMode') post({ type: 'setMode', mode: el.dataset.mode });
  else if (action === 'selectBase') post({ type: 'selectBase' });
  else if (action === 'applyTuning') post({ type: 'applyTuning', overrides: collect() });
  else if (action === 'resetTuning') { resetTuning(); post({ type: 'preview', overrides: null }); }
});

function collect() {
  const o = {};
  for (const el of root.querySelectorAll('[data-tune]')) {
    o[el.dataset.tune] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return o;
}
function resetTuning() {
  for (const el of root.querySelectorAll('[data-tune]')) {
    if (el.type === 'checkbox') el.checked = el.dataset.default === 'true';
    else el.value = el.dataset.default;
  }
  showOutputs();
}
function showOutputs() {
  for (const el of root.querySelectorAll('input[type="range"][data-tune]')) {
    const out = el.parentElement && el.parentElement.querySelector('output');
    if (!out) continue;
    out.textContent = el.dataset.unit === 'ms' ? (Number(el.value) / 1000).toFixed(2) + ' s' : el.value + ' ' + el.dataset.unit;
  }
}
let timer;
document.addEventListener('input', (e) => {
  if (!e.target.closest('[data-tune]')) return;
  showOutputs();
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: 'preview', overrides: collect() }), 120);
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'render') swap(m.html);
});

// Replace the body but keep the tuning block the reader is holding: only its
// result line and its buttons change, and its open/closed state is theirs.
function swap(html) {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  const oldT = root.querySelector('details.tuning');
  const newT = tmpl.content.querySelector('details.tuning');
  if (oldT && newT) {
    const parts = ['.delta', '.actions'];
    for (const sel of parts) {
      const a = oldT.querySelector(sel), b = newT.querySelector(sel);
      if (a && b) a.replaceWith(b);
    }
    newT.replaceWith(oldT);
  }
  root.replaceChildren(tmpl.content);
}

post({ type: 'ready' });
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

/** The tuning controls' starting values, from a config. */
export function tuningOf(cfg: BlindspotConfig): Required<TuningOverrides> {
  return {
    reviewThresholdPoints: cfg.reviewThresholdPoints,
    readAckMs: cfg.readAckMs,
    contentScaling: cfg.contentScaling,
  };
}

/** Only the three knobs, each checked, so a webview message cannot set anything else. */
export function sanitizeOverrides(raw: unknown): TuningOverrides | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: TuningOverrides = {};
  if (typeof o.reviewThresholdPoints === 'number' && Number.isFinite(o.reviewThresholdPoints)) {
    out.reviewThresholdPoints = Math.min(6, Math.max(1, Math.round(o.reviewThresholdPoints)));
  }
  if (typeof o.readAckMs === 'number' && Number.isFinite(o.readAckMs)) {
    out.readAckMs = Math.min(60_000, Math.max(100, Math.round(o.readAckMs)));
  }
  if (typeof o.contentScaling === 'boolean') out.contentScaling = o.contentScaling;
  return Object.keys(out).length > 0 ? out : null;
}
