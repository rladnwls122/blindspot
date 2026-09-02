import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { DiffReport } from '../src/core/types';

/**
 * The report panel is a webview with `enableScripts: true`, and much of what it
 * renders is not ours: file paths come out of `git diff`, and a repository can
 * contain a file named anything a filesystem allows. Escaping is audited by
 * eye today; this makes a future unescaped interpolation fail loudly instead.
 */

let html = '';
let htmlWrites = 0;

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
          htmlWrites++;
        },
        get html() {
          return html;
        },
        onDidReceiveMessage: () => disposable,
        postMessage: () => Promise.resolve(true),
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
const { ReportPanel } = require('../src/extension/panel');

const HOSTILE = `src/<script>alert('xss')</script>&".ts`;

function report(file = HOSTILE): DiffReport {
  const fileReport = {
    file,
    changedLines: 10,
    reviewedLines: 4,
    unseenLines: 6,
    coverage: 0.4,
    weightedCoverage: 0.4,
    risk: 'critical' as const,
    blindspotRisk: 'critical' as const,
    aiLines: 0,
    aiReviewedLines: 0,
    hunks: [
      {
        file,
        startLine: 1,
        endLine: 6,
        lineCount: 6,
        risk: 'critical' as const,
        reason: `<img src=x onerror="alert(1)">`,
        aiRatio: 0,
      },
    ],
  };
  return {
    baseRef: `HEAD<script>`,
    generatedAt: 0,
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
    files: [fileReport],
    hunks: fileReport.hunks,
    worstFile: fileReport,
  };
}

/** Everything between the page's own <script nonce=...> tags, which is ours. */
function withoutOwnScript(page: string): string {
  return page.replace(/<script nonce="[^"]*">[\s\S]*?<\/script>/g, '');
}

describe('the report panel', () => {
  beforeEach(() => {
    html = '';
    htmlWrites = 0;
    (ReportPanel as any).current = undefined;
  });

  test('a refresh that changed nothing does not reload the page', () => {
    const panel = ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, report('src/app.ts'));
    assert.equal(htmlWrites, 1);
    // Same diff, same evidence, four seconds later.
    panel.update({ ...report('src/app.ts'), generatedAt: 4000 });
    assert.equal(htmlWrites, 1, 'reloading the webview would drop the scroll position');
    panel.update({ ...report('src/app.ts'), reviewedLines: 5, unseenLines: 5 });
    assert.equal(htmlWrites, 2, 'a real change still renders');
  });

  test('opening the panel before the first report shows a page, not a blank tab', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, null);
    assert.match(html, /No report yet/);
  });

  test('a filename full of HTML is rendered as text, not markup', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, report());
    const body = withoutOwnScript(html);

    assert.match(html, /Blindspot/, 'the page rendered at all');
    assert.equal(body.includes('<script>alert'), false, 'no injected script tag');
    assert.equal(body.includes('<img src=x'), false, 'no injected image tag');
    assert.match(body, /&lt;script&gt;/, 'the filename is visible, escaped');
    assert.match(body, /&lt;img src=x/, 'the risk reason is visible, escaped');
  });

  test('a quote in a filename cannot break out of an attribute', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, report(`a".ts`));
    const attrs = html.match(/data-file="[^"]*"/g) ?? [];
    assert.equal(attrs.length > 0, true, 'the file link rendered');
    for (const attr of attrs) {
      assert.equal(attr.includes('&quot;'), true, `unescaped quote in ${attr}`);
    }
  });

  test('the page still declares a script-src nonce and no inline fallback', () => {
    ReportPanel.show(vscodeStub.Uri.file('/ext'), () => {}, report('src/app.ts'));
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9]{32}'/);
    assert.equal(csp.includes("script-src 'unsafe-inline'"), false);
  });
});
