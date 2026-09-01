import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG, type BlindspotConfig } from '../src/core/config';
import { buildReport, type ReportSources } from '../src/core/coverage';
import { LineLedger } from '../src/core/ledger';
import {
  renderBlindspots,
  renderCard,
  renderFiles,
  renderScore,
} from '../src/core/render';
import { bar, pct } from '../src/core/score';
import type { DiffReport, FileDiff } from '../src/core/types';
import { classifyLine } from '../src/core/risk';
import { SCENARIO, type Action, type ScenarioFile } from './scenario';

/**
 * Replays a scripted editing session through the real ledger and the real
 * scoring model, then prints the real report.
 *
 * Nothing here fakes a number. The card you see is produced by the same
 * `buildReport` the extension calls; the only thing the demo supplies is the
 * eye-movement that a live editor would otherwise provide. That makes this
 * file the tuning harness too: change the scoring model, re-run it, and see
 * what the same session would have scored.
 */

const NOW = 1_700_000_000_000;

/** What each reading mode does to the ledger, in the units the tracker uses. */
const MODES: Record<Action['mode'], (l: LineLedger, from: number, to: number) => void> = {
  // The agent wrote it; no human eye time at all.
  generate: (l, from, to) => l.setProvenance(from, to, 'bulk'),

  // Scrolled past faster than the reading-speed guard allows; the little
  // unfocused screen time that survives is below the visibility threshold.
  // 0 points.
  skim: (l, from, to) => l.addVisible(from, to, 250, false, NOW),

  // On screen in the active editor long enough to register, but the viewport
  // never held still. 2 points.
  glance: (l, from, to) => l.addVisible(from, to, 900, true, NOW),

  // On screen, focused, and the viewport stopped — read without ever clicking
  // into it, which is how most code is actually read. 3 points.
  study: (l, from, to) => {
    l.addVisible(from, to, 2400, true, NOW);
    l.addDwell(from, to, NOW);
  },

  // Studied, and navigated to. 4 points.
  read: (l, from, to) => {
    l.addVisible(from, to, 2400, true, NOW);
    l.addDwell(from, to, NOW);
    l.addCaret(from, to, NOW);
  },

  // Typed by hand. The edit comes first and the screen time after it, because
  // that is the real order: rewriting a line resets the eye-time spent on its
  // old content, and then you keep looking at what you just wrote. 5 points.
  write: (l, from, to) => {
    for (let line = from; line <= to; line++) {
      l.applyChange(line, line, 1, { human: true, provenance: 'typed', now: NOW });
    }
    l.addVisible(from, to, 1500, true, NOW);
    l.addCaret(from, to, NOW);
  },
};

function replay(file: ScenarioFile): LineLedger {
  const ledger = new LineLedger();
  ledger.resize(file.lines.length);
  if (file.generated) {
    ledger.setProvenance(file.generated[0], file.generated[1], 'bulk');
  }
  for (const action of file.actions) {
    const to = Math.min(action.to, file.lines.length);
    if (action.from > to) continue;
    MODES[action.mode](ledger, action.from, to);
  }
  return ledger;
}

export function runScenario(
  scenario: ScenarioFile[] = SCENARIO,
  cfg: BlindspotConfig = DEFAULT_CONFIG,
): DiffReport {
  const ledgers = new Map<string, LineLedger>();
  const texts = new Map<string, string[]>();
  const diffs: FileDiff[] = [];

  for (const file of scenario) {
    ledgers.set(file.path, replay(file));
    texts.set(file.path, file.lines);
    diffs.push({
      file: file.path,
      addedLines: file.lines.map((_, i) => i + 1),
      modifiedLines: [],
      deletedLines: 0,
      binary: false,
    });
  }

  const sources: ReportSources = {
    getText: (file) => texts.get(file),
    getEvidence: (file, line) => ledgers.get(file)?.peek(line),
  };

  return buildReport(diffs, sources, cfg, 'HEAD', NOW);
}

// ---------------------------------------------------------------- reporting

function terminal(report: DiffReport, color: boolean): string {
  const out: string[] = [];
  out.push('');
  out.push(renderCard(report, { color }));
  out.push('');
  out.push(renderScore(report, { color }));
  out.push('');
  out.push(renderFiles(report, { color }));
  out.push('');
  out.push('Review Blindspot →');
  out.push('');
  out.push(renderBlindspots(report, 6, { color }));
  out.push('');
  return out.join('\n');
}

function html(report: DiffReport): string {
  const rows = report.files
    .map(
      (f) => `      <tr class="${f.unseenLines > 0 && (f.blindspotRisk === 'critical' || f.blindspotRisk === 'high') ? 'severe' : ''}">
        <td><code>${escapeHtml(f.file)}</code>${
          f.aiLines > 0 ? `<span class="tag">${pct(f.aiLines / f.changedLines)}% machine</span>` : ''
        }</td>
        <td class="num">${f.changedLines}</td>
        <td class="num ${f.unseenLines > 0 ? 'accent' : 'muted'}">${f.unseenLines}</td>
        <td class="num">${pct(f.coverage)}%</td>
        <td>${f.blindspotRisk === 'critical' || f.blindspotRisk === 'high' ? `⚠️ ${f.blindspotRisk}` : f.risk}</td>
      </tr>`,
    )
    .join('\n');

  const hunks = report.hunks
    .slice(0, 8)
    .map(
      (h) => `      <li>
        <code>${escapeHtml(h.file)}</code>
        <b>lines ${h.startLine}–${h.endLine}</b>
        <span class="muted">${h.lineCount} unread · ${escapeHtml(h.reason)}${
          h.aiRatio > 0 ? ` · ${pct(h.aiRatio)}% machine-written` : ''
        }</span>
      </li>`,
    )
    .join('\n');

  const s = report.score;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Blindspot report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; --fg:#e7e5e4; --bg:#0c0a09; --muted:#a8a29e; --line:#292524; --accent:#f97316; }
@media (prefers-color-scheme: light) { :root { --fg:#1c1917; --bg:#fafaf9; --muted:#57534e; --line:#e7e5e4; } }
body { margin:0; padding:32px 20px; background:var(--bg); color:var(--fg);
  font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
h1 { font-size:12px; letter-spacing:.24em; margin:0; color:var(--muted); }
.card { border:1px solid var(--line); border-radius:12px; padding:20px; }
.card.alert { border-color:var(--accent); }
.big { display:flex; gap:36px; align-items:flex-end; margin-bottom:14px; }
.big div { display:flex; flex-direction:column; }
.big b { font-size:38px; line-height:1; font-variant-numeric:tabular-nums; }
.big span { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.1em; }
.accent { color:var(--accent); }
.muted { color:var(--muted); }
.meter { height:8px; border-radius:4px; background:color-mix(in srgb, var(--accent) 30%, transparent); overflow:hidden; }
.meter i { display:block; height:100%; background:#22c55e; }
table { width:100%; border-collapse:collapse; margin-top:6px; }
th { text-align:left; font-size:11px; color:var(--muted); font-weight:500; padding-bottom:6px; }
td { padding:6px 0; border-top:1px solid var(--line); }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
tr.severe td:first-child { border-left:2px solid var(--accent); padding-left:8px; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
.bar { font-family:ui-monospace,monospace; letter-spacing:-1px; }
.metrics { display:grid; grid-template-columns:auto 1fr auto; gap:4px 12px; align-items:center; }
ul { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:10px; }
li { display:flex; flex-direction:column; gap:2px; }
.tag { font-size:10px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:1px 5px; margin-left:6px; }
</style></head>
<body><div class="wrap">
  <h1>BLINDSPOT</h1>

  <section class="card ${pct(report.blindspot) >= 25 ? 'alert' : ''}">
    <div class="big">
      <div><b>${pct(report.coverage)}%</b><span>review coverage</span></div>
      <div><b class="accent">${pct(report.blindspot)}%</b><span>blindspot</span></div>
    </div>
    <div class="meter"><i style="width:${pct(report.coverage)}%"></i></div>
    <p class="muted">${report.totalChangedLines} changed lines · ${report.reviewedLines} reviewed ·
      <b class="accent">${report.unseenLines} unseen</b></p>
  </section>

  <section class="card">
    <h1>REVIEW SCORE</h1>
    <div class="big"><div><b>${s.score}</b><span class="bar">${bar(s.score / 100)}</span></div></div>
    <div class="metrics">
      ${metricRow('Coverage', s.coverage, true)}
      ${metricRow('Critical', s.critical, s.measured.critical)}
      ${metricRow('New code', s.newCode, s.measured.newCode)}
      ${metricRow('AI-generated', s.ai, s.measured.ai)}
    </div>
  </section>

  <section class="card">
    <h1>FILES</h1>
    <table>
      <thead><tr><th>file</th><th class="num">changed</th><th class="num">unseen</th><th class="num">coverage</th><th>risk</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>

  <section class="card">
    <h1>REVIEW BLINDSPOT</h1>
    <ul>
${hunks}
    </ul>
  </section>
</div></body></html>
`;
}

function metricRow(label: string, value: number, measured: boolean): string {
  return `<span>${label}</span><span class="bar muted">${measured ? bar(value) : ''}</span><b>${
    measured ? `${pct(value)}%` : '—'
  }</b>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ----------------------------------------------------------------- raw data

/**
 * Per-line signals for the whole scenario.
 *
 * This is the evidence, not the verdict, which is the point: anything that
 * consumes it can apply a different threshold and see what the same session
 * would have scored. The interactive demo uses it to let you move the
 * threshold and watch the report change.
 */
export function scenarioData(cfg: BlindspotConfig = DEFAULT_CONFIG) {
  const files = SCENARIO.map((file) => {
    const ledger = replay(file);
    const lines = file.lines.map((text, i) => {
      const ev = ledger.peek(i + 1) ?? { ...emptyLine };
      const risk = classifyLine(file.path, text, cfg);
      return {
        n: i + 1,
        text,
        risk: risk.level,
        reason: risk.reason,
        ai: ev.provenance === 'bulk' || ev.provenance === 'declared-ai',
        signals: {
          visible: ev.visibleMs >= cfg.visibleMsForPoint,
          focused: ev.focusedMs >= cfg.focusedMsForPoint,
          dwell: ev.dwellEvents > 0,
          caret: ev.caretHits > 0,
          edited: ev.humanEdits > 0,
        },
      };
    });
    return { path: file.path, lines };
  });

  return { weights: cfg.weights, threshold: cfg.reviewThresholdPoints, riskWeights: cfg.riskWeights, files };
}

const emptyLine = {
  visibleMs: 0,
  focusedMs: 0,
  dwellEvents: 0,
  caretHits: 0,
  humanEdits: 0,
  provenance: 'unknown' as const,
  lastSeen: null,
};

// --------------------------------------------------------------------- main

function main(argv: string[]): void {
  if (argv.includes('--data')) {
    process.stdout.write(JSON.stringify(scenarioData()) + '\n');
    return;
  }

  const report = runScenario();

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const htmlIndex = argv.indexOf('--html');
  if (htmlIndex >= 0) {
    const target = argv[htmlIndex + 1] ?? 'demo/report.html';
    const abs = path.resolve(target);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html(report), 'utf8');
    process.stdout.write(`wrote ${abs}\n`);
    return;
  }

  // The interactive page: one template plus this session's evidence. The page
  // recomputes coverage in the browser from the same per-line signals the
  // extension records, so moving its threshold slider answers the same
  // question `reviewThresholdPoints` answers in the editor.
  const pageIndex = argv.indexOf('--page');
  if (pageIndex >= 0) {
    const target = argv[pageIndex + 1] ?? 'demo/index.html';
    const templatePath = path.resolve(__dirname, '../../demo/page.template.html');
    const template = fs.readFileSync(templatePath, 'utf8');
    if (!template.includes('__DATA__')) {
      throw new Error(`${templatePath} has no __DATA__ placeholder`);
    }
    const abs = path.resolve(target);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, template.replace('__DATA__', JSON.stringify(scenarioData())), 'utf8');
    process.stdout.write(`wrote ${abs}\n`);
    return;
  }

  process.stdout.write(terminal(report, !argv.includes('--no-color') && process.stdout.isTTY !== false));
}

if (require.main === module) {
  main(process.argv.slice(2));
}
