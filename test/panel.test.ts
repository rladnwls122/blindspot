import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { emptyActivity, type DiffReport, type FileReport } from '../src/core/types';
import { computeMetrics } from '../src/core/coverage';
import { DEFAULT_CONFIG } from '../src/core/config';

/**
 * The report panel is a webview with `enableScripts: true`, and much of what it
 * renders is not ours: file paths come out of `git diff`, and a repository can
 * contain a file named anything a filesystem allows. Escaping is audited by
 * eye today; this makes a future unescaped interpolation fail loudly instead.
 *
 * It is also the place the two modes meet the reader, so the words it puts
 * next to the number are asserted here: a diff is described by what is
 * unread, a codebase being read by what is done.
 */

let html = '';
let posted: Array<{ type: string; html?: string }> = [];
let receive: ((m: unknown) => void) | undefined;

class MarkdownString {
  constructor(public value: string) {}
}

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
        onDidReceiveMessage: (fn: (m: unknown) => void) => {
          receive = fn;
          return disposable;
        },
        postMessage: (m: { type: string; html?: string }) => {
          posted.push(m);
          return Promise.resolve(true);
        },
      },
      title: '',
      reveal: () => {},
      onDidDispose: () => disposable,
      dispose: () => {},
    }),
  },
  ViewColumn: { One: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  MarkdownString,
};

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReportPanel, renderBody, sanitizeOverrides } = require('../src/extension/panel');

const HOSTILE = `src/<script>alert('xss')</script>&".ts`;

function report(file = HOSTILE, mode: 'diff' | 'reading' = 'diff'): DiffReport {
  const fileReport: FileReport = {
    file,
    changedLines: 10,
    reviewedLines: 4,
    interactedLines: 3,
    unseenLines: 6,
    deletedLines: 2,
    coverage: 0.4,
    weightedCoverage: 0.4,
    risk: 'critical',
    blindspotRisk: 'critical',
    aiLines: 0,
    aiReviewedLines: 0,
    hunks: [
      {
        file,
        startLine: 1,
        endLine: 6,
        lineCount: 6,
        risk: 'critical',
        reason: `<img src=x onerror="alert(1)">`,
        aiRatio: 0,
      },
    ],
  };
  return {
    baseRef: `HEAD<script>`,
    sinceReview: false,
    generatedAt: 0,
    mode,
    metrics: computeMetrics(
      { readSum: 4, focusSum: 2, effectiveMs: 16_000, reviewedLines: 4, targetLines: 10 },
      emptyActivity(),
      DEFAULT_CONFIG,
    ),
    totalChangedLines: 10,
    reviewedLines: 4,
    interactedLines: 3,
    unseenLines: 6,
    deletedLines: 2,
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
    files: [fileReport],
    hunks: fileReport.hunks,
    worstFile: fileReport,
  };
}

function view(r: DiffReport, extra: Partial<{ preview: DiffReport | null; canDiff: boolean; overrides: unknown }> = {}) {
  return {
    report: r,
    preview: extra.preview ?? null,
    overrides: extra.overrides ?? null,
    canDiff: extra.canDiff ?? true,
    tuning: { reviewThresholdPoints: 3, readAckMs: 2000, contentScaling: true },
  };
}

/** Everything between the page's own <script nonce=...> tags, which is ours. */
function withoutOwnScript(page: string): string {
  return page.replace(/<script nonce="[^"]*">[\s\S]*?<\/script>/g, '');
}

describe('the report panel', () => {
  beforeEach(() => {
    html = '';
    posted = [];
    receive = undefined;
    (ReportPanel as any).current = undefined;
  });

  test('a filename full of HTML is rendered as text, not markup', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, view(report()));
    const body = withoutOwnScript(html);

    assert.match(html, /Blindspot/, 'the page rendered at all');
    assert.equal(body.includes('<script>alert'), false, 'no injected script tag');
    assert.equal(body.includes('<img src=x'), false, 'no injected image tag');
    assert.match(body, /&lt;script&gt;/, 'the filename is visible, escaped');
    assert.match(body, /&lt;img src=x/, 'the risk reason is visible, escaped');
  });

  test('a quote in a filename cannot break out of an attribute', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, view(report(`a".ts`)));
    const attrs = html.match(/data-file="[^"]*"/g) ?? [];
    assert.equal(attrs.length > 0, true, 'the file link rendered');
    for (const attr of attrs) {
      assert.equal(attr.includes('&quot;'), true, `unescaped quote in ${attr}`);
    }
  });

  test('the page still declares a script-src nonce and no inline fallback', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, view(report('src/app.ts')));
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9]{32}'/);
    assert.equal(csp.includes("script-src 'unsafe-inline'"), false);
  });

  test('diff mode leads with what is unread; reading mode with what is read', () => {
    const diff = renderBody(view(report('src/app.ts', 'diff')));
    assert.match(diff, /<b>60%<\/b><span>unread<\/span>/);
    assert.match(diff, /Review Blindspot/);
    assert.match(diff, /Complete review/);
    assert.match(diff, /Review Score/, 'the composite belongs to a diff');
    assert.match(diff, /changed lines/);
    assert.match(diff, /−2 deleted/, 'deletions are shown, not hidden');

    const reading = renderBody(view(report('src/app.ts', 'reading')));
    assert.match(reading, /<b>40%<\/b><span>read<\/span>/);
    assert.match(reading, /Continue reading/);
    assert.equal(reading.includes('Complete review'), false, 'there is no baseline to move while reading');
    assert.equal(reading.includes('Review Score'), false);
    assert.match(reading, /files you have opened/);
  });

  test('the mode switch marks the current mode and disables diff without a repository', () => {
    const withGit = renderBody(view(report('src/app.ts', 'reading'), { canDiff: true }));
    assert.match(withGit, /aria-selected="true"[^>]*data-mode="reading"/);
    assert.match(withGit, /aria-selected="false"[^>]*data-mode="diff"/);
    assert.equal(/data-mode="diff" disabled/.test(withGit), false);

    const noGit = renderBody(view(report('src/app.ts', 'reading'), { canDiff: false }));
    assert.match(noGit, /data-mode="diff" disabled/);
  });

  test('the numbers the reader touched are shown beside the ones inferred from screen time', () => {
    const body = renderBody(view(report('src/app.ts')));
    assert.match(body, /<dd>3<\/dd><dt>interacted with<\/dt>/);
    assert.match(body, /Pace/);
  });

  test('a preview wears a badge and shows the change it would make', () => {
    const live = report('src/app.ts');
    const tuned = { ...live, coverage: 0.2, blindspot: 0.8, unseenLines: 8, reviewedLines: 2 };
    const body = renderBody(view(live, { preview: tuned, overrides: { reviewThresholdPoints: 5 } }));
    assert.match(body, /preview · not saved/);
    assert.match(body, /<b>80%<\/b><span>unread<\/span>/, 'the headline is the previewed one');
    assert.match(body, /Coverage<\/span> 40% <span class="arrow">→<\/span> <b>20%<\/b>/);
    assert.match(body, /value="5" data-tune="reviewThresholdPoints"/);
    assert.equal(/data-action="applyTuning" disabled/.test(body), false);

    const plain = renderBody(view(live));
    assert.equal(plain.includes('preview · not saved'), false);
    assert.match(plain, /data-action="applyTuning" disabled/);
  });

  test('after the page is up, updates are posted to it instead of reloading it', () => {
    const panel = ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, view(report('src/app.ts')));
    const first = html;
    receive!({ type: 'ready' });
    panel.update(view(report('src/other.ts')));
    assert.equal(html, first, 'the page was not rebuilt');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'render');
    assert.match(posted[0].html ?? '', /src\/other\.ts/);
  });

  test('only the three tuning knobs get through from the webview, clamped', () => {
    assert.deepEqual(sanitizeOverrides({ reviewThresholdPoints: 9, readAckMs: 10, contentScaling: false, ignore: ['**'] }), {
      reviewThresholdPoints: 6,
      readAckMs: 100,
      contentScaling: false,
    });
    assert.equal(sanitizeOverrides({ ignore: ['**'] }), null);
    assert.equal(sanitizeOverrides('nope'), null);
    assert.equal(sanitizeOverrides({ reviewThresholdPoints: NaN }), null);
  });
});
