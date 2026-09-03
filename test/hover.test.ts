import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { DEFAULT_CONFIG } from '../src/core/config';
import { emptyActivity, emptyEvidence, type DiffReport, type LineEvidence } from '../src/core/types';
import { computeMetrics } from '../src/core/coverage';

/**
 * The hover is the only place a disagreement with the tool can be settled:
 * "I did read that" against a list of which signals the line actually earned.
 * If it appears on the wrong lines, or says nothing useful, the coverage number
 * goes back to being unfalsifiable.
 */

class MarkdownString {
  constructor(public value: string) {}
}
class Hover {
  constructor(
    public contents: unknown,
    public range: unknown,
  ) {}
}
class Range {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number,
  ) {}
}

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return { MarkdownString, Hover, Range };
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EvidenceHover } = require('../src/extension/hover');

const FILE = 'src/auth/session.ts';

function report(): DiffReport {
  return {
    baseRef: 'HEAD',
    sinceReview: false,
    generatedAt: 0,
    mode: 'diff',
    metrics: computeMetrics({ readSum: 0, focusSum: 0, effectiveMs: 0, reviewedLines: 0, targetLines: 0 }, emptyActivity(), DEFAULT_CONFIG),
    totalChangedLines: 10,
    reviewedLines: 6,
    interactedLines: 4,
    unseenLines: 4,
    deletedLines: 0,
    coverage: 0.6,
    blindspot: 0.4,
    score: {
      coverage: 0.6,
      critical: 0,
      newCode: 0.6,
      ai: 0,
      score: 40,
      measured: { coverage: true, critical: true, newCode: true, ai: false },
    },
    files: [],
    hunks: [
      {
        file: FILE,
        startLine: 9,
        endLine: 12,
        lineCount: 4,
        risk: 'critical',
        reason: 'authentication / session code',
        aiRatio: 1,
      },
    ],
    worstFile: null,
  };
}

function makeHover(overrides: {
  enabled?: boolean;
  rel?: string | null;
  evidence?: LineEvidence | undefined;
}) {
  return new EvidenceHover({
    enabled: () => overrides.enabled ?? true,
    relativePath: () => (overrides.rel === undefined ? FILE : overrides.rel),
    report: () => report(),
    evidence: () => overrides.evidence,
    config: () => DEFAULT_CONFIG,
  });
}

const doc = {
  uri: { scheme: 'file', fsPath: '/repo/src/auth/session.ts' },
  lineAt: (i: number) => ({ text: `  const token = sign(session, key); // ${i}` }),
};

describe('the unread-line hover', () => {
  test('explains which signals an unread line did and did not earn', () => {
    const evidence: LineEvidence = {
      ...emptyEvidence(),
      visibleMs: 5000,
      focusedMs: 5000,
    };
    const hover = makeHover({ evidence }).provideHover(doc, { line: 9 });
    assert.ok(hover, 'line 10 is inside the unread hunk');

    const text: string = (hover.contents as MarkdownString).value;
    assert.match(text, /unread/);
    assert.match(text, /✓ on screen/);
    assert.match(text, /· paused/, 'the viewport never stopped, and it says so');
    assert.match(text, /· navigated/);
    assert.match(text, /authentication \/ session code/);
    assert.match(text, /critical/);
  });

  test('a line nobody ever saw still gets an explanation, not a crash', () => {
    const hover = makeHover({ evidence: undefined }).provideHover(doc, { line: 8 });
    assert.ok(hover);
    assert.match((hover.contents as MarkdownString).value, /· on screen \(0ms\)/);
  });

  test('nothing is offered on lines outside an unread hunk', () => {
    assert.equal(makeHover({}).provideHover(doc, { line: 0 }), undefined);
    assert.equal(makeHover({}).provideHover(doc, { line: 100 }), undefined);
  });

  test('nothing is offered for a file outside the repository', () => {
    assert.equal(makeHover({ rel: null }).provideHover(doc, { line: 9 }), undefined);
  });

  test('the setting turns it off', () => {
    assert.equal(makeHover({ enabled: false }).provideHover(doc, { line: 9 }), undefined);
  });

  test('every hover request is reported as the mouse resting on that line, explained or not', () => {
    // The hover request is the only place the editor lets slip where the
    // mouse is. It is attention evidence on a reviewed line, on a line outside
    // any hunk, and with the explanation switched off.
    const seen: number[] = [];
    const hover = new EvidenceHover({
      enabled: () => false,
      relativePath: () => FILE,
      report: () => report(),
      evidence: () => undefined,
      config: () => DEFAULT_CONFIG,
      onPointer: (_doc: unknown, line: number) => seen.push(line),
    });
    hover.provideHover(doc, { line: 0 });
    hover.provideHover(doc, { line: 9 });
    assert.deepEqual(seen, [1, 10], '1-based, like the ledger');
  });
});
