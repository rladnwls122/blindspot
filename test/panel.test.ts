import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'node:path';
import { emptyActivity, type DiffReport } from '../src/core/types';
import { computeMetrics, type PageData } from '../src/core/coverage';
import { DEFAULT_CONFIG } from '../src/core/config';

/**
 * The report panel is a webview with `enableScripts: true`, and what it shows
 * is not ours: file paths come out of `git diff`, line text out of the working
 * tree, and either can contain anything a filesystem or an editor allows. The
 * page renders that data itself, so the one place the extension can get it
 * wrong is the JSON it embeds — a `</script>` inside it would end our script
 * and start the attacker's.
 */

let html = '';
let title = '';
const posted: unknown[] = [];

const disposable = { dispose() {} };
const vscodeStub: any = {
  window: {
    activeTextEditor: undefined,
    createWebviewPanel: () => ({
      webview: {
        set html(v: string) {
          html = v;
        },
        get html() {
          return html;
        },
        onDidReceiveMessage: () => disposable,
        postMessage: (m: unknown) => {
          posted.push(m);
          return Promise.resolve(true);
        },
      },
      set title(v: string) {
        title = v;
      },
      get title() {
        return title;
      },
      reveal: () => {},
      onDidDispose: () => disposable,
      dispose: () => {},
    }),
  },
  ViewColumn: { One: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
};

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReportPanel } = require('../src/extension/panel');

/** The repository root, where media/page.html lives. */
const EXT = vscodeStub.Uri.file(path.resolve(__dirname, '..', '..'));
const HOSTILE = `src/</script><script>alert('xss')</script>.ts`;
const HOSTILE_LINE = `</script><img src=x onerror="alert(1)">`;

function view(file = HOSTILE) {
  const data: PageData = {
    weights: DEFAULT_CONFIG.weights,
    threshold: DEFAULT_CONFIG.reviewThresholdPoints,
    riskWeights: DEFAULT_CONFIG.riskWeights,
    files: [
      {
        path: file,
        lines: [
          {
            n: 1,
            text: HOSTILE_LINE,
            risk: 'critical',
            reason: 'authentication / session code',
            ai: false,
            read: 0,
            signals: { visible: false, focused: false, dwell: false, caret: false, edited: false, revisit: false },
          },
        ],
      },
    ],
  };
  const report: DiffReport = {
    baseRef: 'HEAD',
    generatedAt: 0,
    mode: 'diff',
    metrics: computeMetrics(
      { readSum: 0, focusSum: 0, effectiveMs: 0, reviewedLines: 4, targetLines: 10 },
      emptyActivity(),
      DEFAULT_CONFIG,
    ),
    totalChangedLines: 10,
    reviewedLines: 4,
    unseenLines: 6,
    coverage: 0.4,
    blindspot: 0.6,
    score: {
      coverage: 0.4,
      critical: 0,
      newCode: 0.4,
      ai: 0,
      score: 22,
      measured: { coverage: true, critical: true, newCode: true, ai: false },
    },
    files: [],
    hunks: [],
    sinceReview: false,
    interactedLines: 0,
    deletedLines: 0,
    worstFile: null,
  };
  return { report, data };
}

describe('the report panel', () => {
  beforeEach(() => {
    html = '';
    title = '';
    posted.length = 0;
    (ReportPanel as any).current = undefined;
  });

  test('hostile file names and line text cannot end the page script', () => {
    ReportPanel.show(EXT, () => {}, view());
    assert.match(html, /Blindspot/, 'the page rendered at all');
    assert.equal((html.match(/<script/g) ?? []).length, 1, 'exactly one script opens');
    assert.equal((html.match(/<\/script>/g) ?? []).length, 1, 'exactly one script closes');
    assert.equal(html.includes(HOSTILE), false, 'the raw file name never reaches the markup');
    assert.equal(html.includes(HOSTILE_LINE), false, 'the raw line text never reaches the markup');
  });

  test('the script carries the nonce the policy demands, and nothing else runs', () => {
    ReportPanel.show(EXT, () => {}, view('src/app.ts'));
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9]+)'/)?.[1];
    assert.match(csp, /default-src 'none'/);
    assert.ok(nonce, `no script nonce in "${csp}"`);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  });

  test('the page may fetch its typefaces, and nothing else', () => {
    ReportPanel.show(EXT, () => {}, view('src/app.ts'));
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
    assert.doesNotMatch(csp, /connect-src|img-src/);
  });

  test('a later report is posted into the page, not reloaded over it', () => {
    ReportPanel.show(EXT, () => {}, view('src/a.ts'));
    const first = html;
    ReportPanel.active.update(view('src/b.ts'));
    assert.equal(html, first, 'the page (and the reader\'s slider) survives an update');
    assert.equal(posted.length, 1);
    assert.equal((posted[0] as PageData).files[0].path, 'src/b.ts');
  });

  test('the tab title carries the blindspot share', () => {
    ReportPanel.show(EXT, () => {}, view('src/app.ts'));
    assert.equal(title, 'Blindspot 60%');
  });
});
